// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only (free audit 2026-11-16). Takes 1% of every transfer, like a fee-on-transfer token.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee USD", "FUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev Test-only. Refuses transfers to blocked addresses, like USDC/USDT blacklists.
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Block USD", "BUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @dev Test-only. On every transfer out of `escrow`, tries to re-enter it with `payload` and records whether that worked.
contract ReentrantToken is ERC20 {
    address public escrow;
    bytes public payload;
    bool public attempted;
    bool public reentered;

    constructor() ERC20("Hook USD", "HUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address escrow_, bytes calldata payload_) external {
        escrow = escrow_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == escrow && escrow != address(0) && !attempted) {
            attempted = true;
            (bool ok, ) = escrow.call(payload);
            reentered = ok;
        }
    }
}
