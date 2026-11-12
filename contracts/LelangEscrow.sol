// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LelangEscrow
/// @notice Sealed-bid tender escrow for agent-to-agent procurement. Bonds sit in this contract, not with the buyer.
/// @dev Flow: open -> commit (bond in) -> closeCommits -> reveal -> settle (one tx: refunds, evidence-hashed slashes,
///      down payment) or, if the buyer never settles, withdraw. There is no owner, admin or pause: no party can move
///      bonds outside these rules.
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
    }

    struct Bid {
        bytes32 commitment;
        bytes32 docHash;
        bool revealed;
        bool closed; // bond refunded, slashed or withdrawn
    }

    /// @notice Cap on bidders per tender, so `settle` (which loops over bidders) always fits in a block.
    uint256 public constant MAX_BIDDERS = 100;

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

    error WrongPhase();
    error NotBuyer();
    error NotBidder();
    error BadReveal();
    error AlreadyCommitted();
    error InvalidWinner();
    error MissingEvidence();
    error InvalidParams();
    error TooManyBidders();

    /// @notice Opens a tender; the caller becomes its buyer.
    /// @param token ERC-20 used for bonds and the down payment.
    /// @param bond Bond each bidder locks on commit (token units).
    /// @param commitSeconds Length of the commit window from now.
    /// @param revealSeconds Length of the reveal window after commits close.
    /// @param settleSeconds Time the buyer has to settle after the reveal window; afterwards bidders can withdraw.
    /// @return id The new tender id.
    function open(IERC20 token, uint256 bond, uint64 commitSeconds, uint64 revealSeconds, uint64 settleSeconds)
        external
        returns (uint256 id)
    {
        if (address(token) == address(0) || bond == 0 || commitSeconds == 0 || revealSeconds == 0 || settleSeconds == 0) {
            revert InvalidParams();
        }
        id = ++tenderCount;
        uint64 c = uint64(block.timestamp) + commitSeconds;
        tenders[id] = Tender(msg.sender, token, bond, c, c + revealSeconds, c + revealSeconds + settleSeconds, false, 0, 0);
        emit TenderOpened(id, msg.sender, address(token), bond, c);
    }

    /// @notice The commitment a bidder must submit: binds document, salt, bidder and tender (no copying, no reuse).
    function commitmentOf(bytes32 docHash, bytes32 salt, address bidder, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(docHash, salt, bidder, id));
    }

    /// @notice Locks the caller's bond and records its sealed commitment. Requires prior token approval.
    function commit(uint256 id, bytes32 commitment) external nonReentrant {
        Tender storage t = tenders[id];
        if (t.buyer == address(0) || block.timestamp >= t.commitDeadline) revert WrongPhase();
        if (msg.sender == t.buyer) revert NotBidder(); // the buyer can't bid on (and then slash into) its own tender
        Bid storage b = bids[id][msg.sender];
        if (b.commitment != 0) revert AlreadyCommitted();
        if (t.committed >= MAX_BIDDERS) revert TooManyBidders();
        b.commitment = commitment;
        t.committed++;
        bidderList[id].push(msg.sender);
        t.token.safeTransferFrom(msg.sender, address(this), t.bond);
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

    /// @notice Settles the tender in one transaction: slashes listed bids (each needs a non-zero evidence hash),
    ///         slashes unrevealed bids, refunds every other bond, and pays `downPayment` from the buyer to the winner.
    /// @dev Allowed once the reveal window is over, or earlier if every bidder has revealed, so nobody is auto-slashed
    ///      for not having revealed yet.
    function settle(uint256 id, address winner, address[] calldata slash, bytes32[] calldata evidence, uint256 downPayment)
        external
        nonReentrant
    {
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
            t.token.safeTransfer(t.buyer, t.bond);
            emit BondSlashed(id, slash[i], t.bond, evidence[i]);
        }
        address[] storage list = bidderList[id];
        for (uint256 i; i < list.length; i++) {
            Bid storage b = bids[id][list[i]];
            if (b.closed) continue;
            b.closed = true;
            if (b.revealed) {
                t.token.safeTransfer(list[i], t.bond);
                emit BondRefunded(id, list[i], t.bond);
            } else {
                t.token.safeTransfer(t.buyer, t.bond);
                emit BondSlashed(id, list[i], t.bond, bytes32(0));
            }
        }
        if (downPayment > 0) t.token.safeTransferFrom(msg.sender, winner, downPayment);
        emit Awarded(id, winner, downPayment);
    }

    /// @notice Safety valve against a buyer who disappears: bidders reclaim their bond after the settle deadline.
    function withdraw(uint256 id) external nonReentrant {
        Tender storage t = tenders[id];
        if (t.settled || block.timestamp < t.settleDeadline) revert WrongPhase();
        Bid storage b = bids[id][msg.sender];
        if (b.commitment == 0 || b.closed) revert WrongPhase();
        b.closed = true;
        t.token.safeTransfer(msg.sender, t.bond);
        emit BondWithdrawn(id, msg.sender, t.bond);
    }

    /// @notice All bidders of tender `id`, in commit order.
    function biddersOf(uint256 id) external view returns (address[] memory) {
        return bidderList[id];
    }
}
