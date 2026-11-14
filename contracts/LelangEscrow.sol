// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LelangEscrow
/// @notice Sealed-bid tender escrow for agent-to-agent procurement. Bonds sit in this contract, not with the buyer.
/// @dev Flow: open -> commit (bond in) -> closeCommits -> reveal -> settle (one tx: refunds, evidence-hashed slashes,
///      down payment, success fee, balance held for delivery) or, if the buyer never settles, withdraw. There is no owner,
///      admin or pause: no party can move bonds outside these rules.
///      V4: the buyer never profits from a forfeit. A slashed bond waits out a challenge window in which a quorum of
///      approvers can overturn it on-chain; after that it goes to a bounty pool that pays whoever finds a hole in the
///      evaluator. Attackers fund the defence. The balance after the down payment is held until the buyer confirms
///      delivery (or, if the buyer stays silent past the deadline, a quorum of approvers decides).
///      V5: the approvers' delivery decision is queued for DELIVERY_TIMELOCK before anyone can execute it, so a wrong or
///      captured quorum can be seen (and outvoted, or pre-empted by the buyer confirming) before the money moves.
contract LelangEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tender {
        address buyer;
        IERC20 token;
        uint256 bond;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 settleDeadline;
        bool settled;
        uint32 committed;
        uint32 revealed;
        uint16 feeBps; // success fee on the down payment, agreed by the buyer when it opens the tender
    }

    struct Bid {
        bytes32 commitment;
        bytes32 docHash;
        bool revealed;
        bool closed; // bond refunded, slashed or withdrawn
        uint256 bond; // what this bidder locked: at least the tender bond, more when it chose (or was asked) to post more
    }

    /// @notice Cap on bidders per tender, so `settle` (which loops over bidders) always fits in a block.
    uint256 public constant MAX_BIDDERS = 100;

    /// @notice Cap on the success fee: 5% of the down payment.
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice Receives success fees (the operator running evaluation and audits). Fixed at deployment.
    address public immutable treasury;

    /// @notice Addresses that can overturn a pending slash or resolve a stuck delivery, and how many must agree.
    mapping(address => bool) public isApprover;
    uint256 public immutable quorum;
    /// @notice How long a slash stays pending (overturnable) before it is final.
    uint64 public immutable challengeSeconds;

    struct PendingSlash {
        uint64 finalAt; // 0: no pending slash
        bytes32 evidence;
    }
    /// @notice A slash listed at settle, held here until `finalAt`.
    mapping(uint256 => mapping(address => PendingSlash)) public pendingSlash;

    struct Delivery {
        address winner;
        uint256 balance; // paid to the winner on delivery
        uint256 fee; // success fee on the balance, paid to the treasury with it
        uint64 deadline; // after this, approvers can resolve if the buyer has not confirmed
        bool closed;
    }
    /// @notice The balance of the contract price, held from settle until delivery is confirmed or resolved.
    mapping(uint256 => Delivery) public deliveries;

    /// @notice How long a quorum's delivery decision waits before `executeDelivery` can move the balance.
    uint64 public constant DELIVERY_TIMELOCK = 1 hours;
    struct QueuedDelivery {
        uint64 eta; // 0: nothing queued
        bool payWinner;
    }
    /// @notice The approvers' decision on a held balance, waiting out the timelock.
    mapping(uint256 => QueuedDelivery) public queuedDelivery;
    /// @notice Bumped each time a decision is queued, so votes cast for an earlier decision never count again.
    mapping(uint256 => uint256) public deliveryRound;

    /// @notice Forfeited bonds by token: they only ever leave as evidence-tagged bounties.
    mapping(address => uint256) public bountyPool;
    /// @notice Evidence hashes a bounty was already paid for (one bounty per finding).
    mapping(bytes32 => bool) public bountyPaid;

    mapping(bytes32 => mapping(address => bool)) public voted;
    mapping(bytes32 => uint256) public votes;

    /// @notice Number of tenders opened so far; ids start at 1.
    uint256 public tenderCount;
    /// @notice Tender parameters and state by id.
    mapping(uint256 => Tender) public tenders;
    /// @notice Bid of `bidder` in tender `id`.
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) internal bidderList;

    event TenderOpened(uint256 indexed id, address indexed buyer, address token, uint256 bond, uint64 commitDeadline);
    event Committed(uint256 indexed id, address indexed bidder, bytes32 commitment);
    event CommitsClosed(uint256 indexed id, uint256 bidders);
    event Revealed(uint256 indexed id, address indexed bidder, bytes32 docHash);
    event BondRefunded(uint256 indexed id, address indexed bidder, uint256 amount);
    /// @dev `evidenceHash` is keccak256 of the offending text; zero when the bid was never revealed.
    event BondSlashed(uint256 indexed id, address indexed bidder, uint256 amount, bytes32 evidenceHash);
    event Awarded(uint256 indexed id, address indexed winner, uint256 downPayment);
    event BondWithdrawn(uint256 indexed id, address indexed bidder, uint256 amount);
    event FeePaid(uint256 indexed id, address indexed treasury, uint256 amount);
    event SlashPending(uint256 indexed id, address indexed bidder, uint256 amount, bytes32 evidenceHash, uint64 finalAt);
    event SlashOverturned(uint256 indexed id, address indexed bidder, uint256 amount, bytes32 evidenceHash);
    event Voted(bytes32 indexed action, address indexed approver, uint256 votes);
    event BalanceHeld(uint256 indexed id, address indexed winner, uint256 balance, uint64 deadline);
    event DeliveryClosed(uint256 indexed id, address indexed to, uint256 amount, bool delivered);
    event DeliveryQueued(uint256 indexed id, bool payWinner, uint64 eta);
    event BountyPaid(address indexed token, address indexed to, uint256 amount, bytes32 evidenceHash);

    error WrongPhase();
    error NotBuyer();
    error NotBidder();
    error BadReveal();
    error AlreadyCommitted();
    error InvalidWinner();
    error MissingEvidence();
    error InvalidParams();
    error TooManyBidders();
    error NotApprover();
    error AlreadyVoted();

    constructor(address treasury_, address[] memory approvers_, uint256 quorum_, uint64 challengeSeconds_) {
        if (treasury_ == address(0) || quorum_ == 0 || quorum_ > approvers_.length || challengeSeconds_ == 0) revert InvalidParams();
        for (uint256 i; i < approvers_.length; i++) {
            if (approvers_[i] == address(0) || isApprover[approvers_[i]]) revert InvalidParams();
            isApprover[approvers_[i]] = true;
        }
        treasury = treasury_;
        quorum = quorum_;
        challengeSeconds = challengeSeconds_;
    }

    /// @notice Opens a tender; the caller becomes its buyer.
    /// @param token ERC-20 used for bonds and the down payment.
    /// @param bond Minimum bond each bidder locks on commit (token units).
    /// @param commitSeconds Length of the commit window from now.
    /// @param revealSeconds Length of the reveal window after commits close.
    /// @param settleSeconds Time the buyer has to settle after the reveal window; afterwards bidders can withdraw.
    /// @param feeBps Success fee in basis points of the down payment, paid to the treasury only when an award settles.
    /// @return id The new tender id.
    function open(IERC20 token, uint256 bond, uint64 commitSeconds, uint64 revealSeconds, uint64 settleSeconds, uint16 feeBps)
        external
        returns (uint256 id)
    {
        if (address(token) == address(0) || bond == 0 || commitSeconds == 0 || revealSeconds == 0 || settleSeconds == 0 || feeBps > MAX_FEE_BPS) {
            revert InvalidParams();
        }
        id = ++tenderCount;
        uint64 c = uint64(block.timestamp) + commitSeconds;
        tenders[id] = Tender(msg.sender, token, bond, c, c + revealSeconds, c + revealSeconds + settleSeconds, false, 0, 0, feeBps);
        emit TenderOpened(id, msg.sender, address(token), bond, c);
    }

    /// @notice The commitment a bidder must submit: binds document, salt, bidder and tender (no copying, no reuse).
    function commitmentOf(bytes32 docHash, bytes32 salt, address bidder, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(docHash, salt, bidder, id));
    }

    /// @notice Locks the caller's bond and records its sealed commitment. Requires prior token approval.
    /// @param amount Bond to lock, at least the tender bond. A bidder with a slashing history can post more to be
    ///        trusted again: the evaluator reads this amount, and a later slash takes all of it.
    function commit(uint256 id, bytes32 commitment, uint256 amount) external nonReentrant {
        Tender storage t = tenders[id];
        if (t.buyer == address(0) || block.timestamp >= t.commitDeadline) revert WrongPhase();
        if (msg.sender == t.buyer) revert NotBidder(); // the buyer can't bid on (and then slash into) its own tender
        Bid storage b = bids[id][msg.sender];
        if (b.commitment != 0) revert AlreadyCommitted();
        if (t.committed >= MAX_BIDDERS) revert TooManyBidders();
        if (amount < t.bond) revert InvalidParams();
        b.commitment = commitment;
        b.bond = amount;
        t.committed++;
        bidderList[id].push(msg.sender);
        t.token.safeTransferFrom(msg.sender, address(this), amount);
        emit Committed(id, msg.sender, commitment);
    }

    /// @notice Buyer ends the commit window early (e.g. all invited suppliers are in). Window lengths are kept.
    function closeCommits(uint256 id) external {
        Tender storage t = tenders[id];
        if (msg.sender != t.buyer) revert NotBuyer();
        if (block.timestamp >= t.commitDeadline) revert WrongPhase();
        uint64 shift = t.commitDeadline - uint64(block.timestamp);
        t.commitDeadline -= shift;
        t.revealDeadline -= shift;
        t.settleDeadline -= shift;
        emit CommitsClosed(id, t.committed);
    }

    /// @notice Proves which document the caller committed to. Only possible inside the reveal window.
    function reveal(uint256 id, bytes32 docHash, bytes32 salt) external {
        Tender storage t = tenders[id];
        if (block.timestamp < t.commitDeadline || block.timestamp >= t.revealDeadline) revert WrongPhase();
        Bid storage b = bids[id][msg.sender];
        if (b.commitment == 0 || b.revealed || commitmentOf(docHash, salt, msg.sender, id) != b.commitment) revert BadReveal();
        b.revealed = true;
        b.docHash = docHash;
        t.revealed++;
        emit Revealed(id, msg.sender, docHash);
    }

    /// @notice Settles the tender in one transaction: puts listed bids (each needs a non-zero evidence hash) on a pending
    ///         slash, forfeits unrevealed bonds to the bounty pool, refunds every other bond, pays `downPayment` from the
    ///         buyer to the winner and holds `balance` until delivery.
    /// @dev Allowed once the reveal window is over, or earlier if every bidder has revealed, so nobody is auto-slashed
    ///      for not having revealed yet.
    function settle(
        uint256 id,
        address winner,
        address[] calldata slash,
        bytes32[] calldata evidence,
        uint256 downPayment,
        uint256 balance,
        uint64 deliverySeconds
    ) external nonReentrant {
        Tender storage t = tenders[id];
        if (msg.sender != t.buyer) revert NotBuyer();
        bool revealDone = block.timestamp >= t.revealDeadline || (t.revealed == t.committed && block.timestamp >= t.commitDeadline);
        if (t.settled || !revealDone || block.timestamp >= t.settleDeadline) revert WrongPhase();
        if (slash.length != evidence.length) revert MissingEvidence();
        if (!bids[id][winner].revealed) revert InvalidWinner();
        t.settled = true;

        for (uint256 i; i < slash.length; i++) {
            Bid storage s = bids[id][slash[i]];
            if (s.closed || s.commitment == 0) continue;
            if (slash[i] == winner) revert InvalidWinner();
            if (evidence[i] == 0) revert MissingEvidence();
            s.closed = true;
            pendingSlash[id][slash[i]] = PendingSlash(uint64(block.timestamp) + challengeSeconds, evidence[i]);
            emit SlashPending(id, slash[i], s.bond, evidence[i], uint64(block.timestamp) + challengeSeconds);
        }
        address[] storage list = bidderList[id];
        for (uint256 i; i < list.length; i++) {
            Bid storage b = bids[id][list[i]];
            if (b.closed) continue;
            b.closed = true;
            if (b.revealed) {
                t.token.safeTransfer(list[i], b.bond);
                emit BondRefunded(id, list[i], b.bond);
            } else {
                bountyPool[address(t.token)] += b.bond;
                emit BondSlashed(id, list[i], b.bond, bytes32(0));
            }
        }
        if (downPayment > 0) {
            t.token.safeTransferFrom(msg.sender, winner, downPayment);
            // The operator is paid in the same transaction as the winner, and only then: no award, no fee.
            uint256 fee = (downPayment * t.feeBps) / 10_000;
            if (fee > 0) {
                t.token.safeTransferFrom(msg.sender, treasury, fee);
                emit FeePaid(id, treasury, fee);
            }
        }
        if (balance > 0) _holdBalance(id, winner, balance, deliverySeconds);
        emit Awarded(id, winner, downPayment);
    }

    function _holdBalance(uint256 id, address winner, uint256 balance, uint64 deliverySeconds) internal {
        if (deliverySeconds == 0) revert InvalidParams();
        Tender storage t = tenders[id];
        uint256 fee = (balance * t.feeBps) / 10_000;
        uint64 deadline = uint64(block.timestamp) + deliverySeconds;
        deliveries[id] = Delivery(winner, balance, fee, deadline, false);
        t.token.safeTransferFrom(msg.sender, address(this), balance + fee);
        emit BalanceHeld(id, winner, balance, deadline);
    }

    /// @notice After the challenge window, anyone makes a pending slash final: the bond goes to the bounty pool, never
    ///         to the buyer, so the party that lists a slash cannot profit from it.
    function finalizeSlash(uint256 id, address bidder) external nonReentrant {
        PendingSlash memory p = pendingSlash[id][bidder];
        if (p.finalAt == 0 || block.timestamp < p.finalAt) revert WrongPhase();
        delete pendingSlash[id][bidder];
        uint256 bond = bids[id][bidder].bond;
        bountyPool[address(tenders[id].token)] += bond;
        emit BondSlashed(id, bidder, bond, p.evidence);
    }

    /// @notice Inside the challenge window, `quorum` approvers overturn a pending slash: the bond goes back to the bidder
    ///         and no BondSlashed event is ever emitted, so the slash never counts in reputation.
    function overturnSlash(uint256 id, address bidder) external nonReentrant {
        PendingSlash memory p = pendingSlash[id][bidder];
        if (p.finalAt == 0 || block.timestamp >= p.finalAt) revert WrongPhase();
        if (!_vote(keccak256(abi.encode("overturn", id, bidder)))) return;
        delete pendingSlash[id][bidder];
        uint256 bond = bids[id][bidder].bond;
        tenders[id].token.safeTransfer(bidder, bond);
        emit SlashOverturned(id, bidder, bond, p.evidence);
    }

    /// @notice The buyer confirms delivery: the held balance goes to the winner and its success fee to the treasury.
    ///         Also while an approver decision is queued: the buyer admitting delivery beats a queued refund.
    function confirmDelivery(uint256 id) external nonReentrant {
        if (msg.sender != tenders[id].buyer) revert NotBuyer();
        delete queuedDelivery[id];
        _closeDelivery(id, true);
    }

    /// @notice If the buyer has not confirmed by the deadline, `quorum` approvers decide: pay the winner, or refund the
    ///         buyer. The vote that reaches quorum only queues the decision; `executeDelivery` moves the money after
    ///         DELIVERY_TIMELOCK. A quorum for the other outcome replaces the queued one (and restarts the clock).
    /// @dev Votes are counted per round, so an approver who voted for the replaced outcome must vote again to bring it
    ///      back: one approver alone can't flip a decision. ponytail: rival quorums can keep replacing each other (each
    ///      flip needs a full quorum); the buyer's confirmDelivery ends it at any time.
    function resolveDelivery(uint256 id, bool payWinner) external nonReentrant {
        Delivery storage d = deliveries[id];
        QueuedDelivery storage q = queuedDelivery[id];
        if (d.balance == 0 || d.closed || block.timestamp < d.deadline) revert WrongPhase();
        if (q.eta != 0 && q.payWinner == payWinner) revert WrongPhase(); // already queued: nothing to decide
        if (!_vote(keccak256(abi.encode("delivery", id, payWinner, deliveryRound[id])))) return;
        deliveryRound[id]++;
        uint64 eta = uint64(block.timestamp) + DELIVERY_TIMELOCK;
        queuedDelivery[id] = QueuedDelivery(eta, payWinner);
        emit DeliveryQueued(id, payWinner, eta);
    }

    /// @notice After the timelock, anyone executes the approvers' queued delivery decision.
    function executeDelivery(uint256 id) external nonReentrant {
        QueuedDelivery memory q = queuedDelivery[id];
        if (q.eta == 0 || block.timestamp < q.eta) revert WrongPhase();
        delete queuedDelivery[id];
        _closeDelivery(id, q.payWinner);
    }

    function _closeDelivery(uint256 id, bool delivered) internal {
        Delivery storage d = deliveries[id];
        if (d.balance == 0 || d.closed) revert WrongPhase();
        d.closed = true;
        Tender storage t = tenders[id];
        if (delivered) {
            t.token.safeTransfer(d.winner, d.balance);
            if (d.fee > 0) {
                t.token.safeTransfer(treasury, d.fee);
                emit FeePaid(id, treasury, d.fee);
            }
            emit DeliveryClosed(id, d.winner, d.balance, true);
        } else {
            t.token.safeTransfer(t.buyer, d.balance + d.fee);
            emit DeliveryClosed(id, t.buyer, d.balance + d.fee, false);
        }
    }

    /// @notice Pays a bounty from forfeited bonds to whoever found a hole in the evaluator. One payment per evidence hash.
    /// @dev ponytail: treasury-only, so the operator decides what earns a bounty; every payment is public with its
    ///      evidence hash. Upgrade path: require approver votes per bounty if the pool grows large.
    function payBounty(address token, address to, uint256 amount, bytes32 evidenceHash) external nonReentrant {
        if (msg.sender != treasury) revert NotApprover();
        if (to == address(0) || amount == 0 || evidenceHash == 0 || bountyPaid[evidenceHash] || amount > bountyPool[token]) revert InvalidParams();
        bountyPaid[evidenceHash] = true;
        bountyPool[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit BountyPaid(token, to, amount, evidenceHash);
    }

    /// @dev Records the caller's vote on `action`; true once `quorum` approvers voted for it.
    function _vote(bytes32 action) internal returns (bool) {
        if (!isApprover[msg.sender]) revert NotApprover();
        if (voted[action][msg.sender]) revert AlreadyVoted();
        voted[action][msg.sender] = true;
        uint256 n = ++votes[action];
        emit Voted(action, msg.sender, n);
        return n >= quorum;
    }

    /// @notice Safety valve against a buyer who disappears: bidders reclaim their bond after the settle deadline.
    function withdraw(uint256 id) external nonReentrant {
        Tender storage t = tenders[id];
        if (t.settled || block.timestamp < t.settleDeadline) revert WrongPhase();
        Bid storage b = bids[id][msg.sender];
        if (b.commitment == 0 || b.closed) revert WrongPhase();
        b.closed = true;
        t.token.safeTransfer(msg.sender, b.bond);
        emit BondWithdrawn(id, msg.sender, b.bond);
    }

    /// @notice All bidders of tender `id`, in commit order.
    function biddersOf(uint256 id) external view returns (address[] memory) {
        return bidderList[id];
    }
}
