// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Sealed-bid tender escrow. Bonds sit in this contract, not with the buyer.
/// - commit: bidder locks its bond with keccak256(abi.encode(docHash, salt, bidder, tenderId))
/// - reveal: bidder proves which document it committed to; nobody can change a bid after commits close
/// - settle: buyer refunds bonds and pays the winner; slashing a revealed bid requires an evidence hash on-chain
/// - withdraw: if the buyer never settles, bidders take their bonds back after settleDeadline
contract LelangEscrow {
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

    uint256 public tenderCount;
    mapping(uint256 => Tender) public tenders;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) internal bidderList;

    event TenderOpened(uint256 indexed id, address indexed buyer, address token, uint256 bond, uint64 commitDeadline);
    event Committed(uint256 indexed id, address indexed bidder, bytes32 commitment);
    event CommitsClosed(uint256 indexed id, uint256 bidders);
    event Revealed(uint256 indexed id, address indexed bidder, bytes32 docHash);
    event BondRefunded(uint256 indexed id, address indexed bidder, uint256 amount);
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
    error TransferFailed();

    function open(IERC20 token, uint256 bond, uint64 commitSeconds, uint64 revealSeconds, uint64 settleSeconds) external returns (uint256 id) {
        id = ++tenderCount;
        uint64 c = uint64(block.timestamp) + commitSeconds;
        tenders[id] = Tender(msg.sender, token, bond, c, c + revealSeconds, c + revealSeconds + settleSeconds, false, 0, 0);
        emit TenderOpened(id, msg.sender, address(token), bond, c);
    }

    function commitmentOf(bytes32 docHash, bytes32 salt, address bidder, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(docHash, salt, bidder, id));
    }

    function commit(uint256 id, bytes32 commitment) external {
        Tender storage t = tenders[id];
        if (block.timestamp >= t.commitDeadline) revert WrongPhase();
        if (msg.sender == t.buyer) revert NotBidder(); // the buyer can't bid on (and then slash into) its own tender
        Bid storage b = bids[id][msg.sender];
        if (b.commitment != 0) revert AlreadyCommitted();
        b.commitment = commitment;
        t.committed++;
        bidderList[id].push(msg.sender);
        if (!t.token.transferFrom(msg.sender, address(this), t.bond)) revert TransferFailed();
        emit Committed(id, msg.sender, commitment);
    }

    /// Buyer may end the commit window early (e.g. all invited suppliers are in).
    function closeCommits(uint256 id) external {
        Tender storage t = tenders[id];
        if (msg.sender != t.buyer) revert NotBuyer();
        if (block.timestamp >= t.commitDeadline) revert WrongPhase();
        uint64 shift = t.commitDeadline - uint64(block.timestamp);
        t.commitDeadline -= shift;
        t.revealDeadline -= shift;
        t.settleDeadline -= shift;
        emit CommitsClosed(id, bidderList[id].length);
    }

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

    /// Unrevealed bids lose their bond automatically. A revealed bid can only be slashed with an evidence hash
    /// (keccak256 of the offending text), so the reason is public and checkable against the revealed document.
    function settle(uint256 id, address winner, address[] calldata slash, bytes32[] calldata evidence, uint256 downPayment) external {
        Tender storage t = tenders[id];
        if (msg.sender != t.buyer) revert NotBuyer();
        // Settling early would auto-slash bidders who simply haven't revealed yet, so the reveal window must be over
        // unless every bidder has already revealed.
        bool revealDone = block.timestamp >= t.revealDeadline || (t.revealed == t.committed && block.timestamp >= t.commitDeadline);
        if (t.settled || !revealDone || block.timestamp >= t.settleDeadline) revert WrongPhase();
        if (slash.length != evidence.length) revert MissingEvidence();
        Bid storage w = bids[id][winner];
        if (!w.revealed) revert InvalidWinner();
        t.settled = true;

        for (uint256 i; i < slash.length; i++) {
            Bid storage s = bids[id][slash[i]];
            if (s.closed || s.commitment == 0) continue;
            if (slash[i] == winner) revert InvalidWinner();
            if (evidence[i] == 0) revert MissingEvidence();
            s.closed = true;
            _pay(t.token, t.buyer, t.bond);
            emit BondSlashed(id, slash[i], t.bond, evidence[i]);
        }
        address[] storage list = bidderList[id];
        for (uint256 i; i < list.length; i++) {
            Bid storage b = bids[id][list[i]];
            if (b.closed) continue;
            b.closed = true;
            if (b.revealed) {
                _pay(t.token, list[i], t.bond);
                emit BondRefunded(id, list[i], t.bond);
            } else {
                _pay(t.token, t.buyer, t.bond);
                emit BondSlashed(id, list[i], t.bond, bytes32(0));
            }
        }
        if (downPayment > 0 && !t.token.transferFrom(msg.sender, winner, downPayment)) revert TransferFailed();
        emit Awarded(id, winner, downPayment);
    }

    /// Safety valve against a buyer who disappears: bidders reclaim bonds after the settle deadline.
    function withdraw(uint256 id) external {
        Tender storage t = tenders[id];
        if (t.settled || block.timestamp < t.settleDeadline) revert WrongPhase();
        Bid storage b = bids[id][msg.sender];
        if (b.commitment == 0 || b.closed) revert WrongPhase();
        b.closed = true;
        _pay(t.token, msg.sender, t.bond);
        emit BondWithdrawn(id, msg.sender, t.bond);
    }

    function biddersOf(uint256 id) external view returns (address[] memory) {
        return bidderList[id];
    }

    function _pay(IERC20 token, address to, uint256 amount) private {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
