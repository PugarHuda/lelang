# Free audit: LelangEscrow (2026-11-16)

Free static analysis plus a manual checklist review, with a Hardhat test behind each item. **This is not a professional audit.** See "What this is not" at the end.

## Scope

| | |
|---|---|
| File | `contracts/LelangEscrow.sol` (390 lines) |
| Repo commit | `87b6955da2f98fca41f0bd9c2ed521e41f28c618` (`git rev-parse HEAD`); the contract last changed in `7e829fa` |
| Compiler | solc 0.8.28, optimizer 200 runs, evmVersion paris (`hardhat.config.cjs`) |
| Dependencies | OpenZeppelin Contracts 5.1.0 (`SafeERC20`, `ReentrancyGuard`), Hardhat 2.29.2 |

**Source vs deployment.** The source at HEAD is "V5": it adds the delivery timelock (`queuedDelivery`, `deliveryRound`, `executeDelivery`). The ABI in `deployments/kite-testnet.json` (address `0x2924…f952`) has no `executeDelivery`, so the deployed contract is V4. The V4→V5 diff (`git diff 3061165 7e829fa`) only touches `resolveDelivery`. Findings F1–F6 below are in code that is the same in V4 and V5, so they apply to the deployed contract. The delivery-timelock review applies to V5 source only.

Out of scope: the off-chain evaluator, agents, API, front end, and deployment keys.

## Tools

| Tool | Version | Result |
|---|---|---|
| Slither | 0.11.6 (already installed) | Run after `hardhat clean && hardhat compile`, with `node_modules` and `contracts/test` filtered out. **0 high, 0 medium, 9 low, 1 informational, 0 optimization.** The 9 low results are all the `timestamp` detector (the commit, reveal, settle, challenge and delivery windows use `block.timestamp`). They are intended: the windows last hours, and a validator can shift a timestamp by only a few seconds. The informational result is `cyclomatic-complexity` on `settle` (15). Earlier runs were reading old build-info files from previous versions, so line numbers were wrong. Clean before you run it. |
| Aderyn | not run | `npm i -g @cyfrin/aderyn` refuses Windows x64. In WSL Ubuntu, `cyfrinup` now prints "ADERYN HAS BEEN RETIRED AND IS NO LONGER MAINTAINED" and installs nothing. The GitHub releases list only `.sha256` files for the Linux binary; the tarball returns 404. Building from source with cargo was out of scope, so we skipped it. |
| Hardhat tests | mocha via `npx hardhat test` | 37 passing before this review, **52 passing** after (15 new in `test/audit-2026-11-16.test.cjs`, test tokens in `contracts/test/AuditTokens.sol`). |

## Checklist

"Test" names a case in `test/audit-2026-11-16.test.cjs`, or in the existing `test/LelangEscrow.test.cjs`.

| # | Item | Result | Test |
|---|---|---|---|
| 1 | Reentrancy, including token callbacks | OK. Every function that moves tokens is `nonReentrant` with a single contract-wide lock, and state is written before transfers (checks-effects-interactions). A hook token that re-enters `finalizeSlash` during a settle refund is blocked. The unguarded functions (`open`, `closeCommits`, `reveal`) move no tokens. | D1 |
| 2 | Access control per function | OK. `closeCommits`, `settle` and `confirmDelivery` check the buyer. `overturnSlash` and `resolveDelivery` require an approver plus quorum. `payBounty` is treasury-only. `finalizeSlash` and `executeDelivery` are open to anyone, but only after their time gate. `reveal` and `withdraw` are bound to `msg.sender`'s own bid. Centralization note: F6. | existing + F6 |
| 3 | State machine and phase edges | Transitions are OK: the settle and withdraw windows can't overlap, there is no commit after close, and a slash is overturnable before `finalAt` and finalizable from `finalAt` on, with no overlap. **Finding F1**: the tender has no path that penalizes non-revealers when nobody reveals. **Finding F4**: a zero commitment gets around the "already committed" check. | D3, D6, F1, F4 |
| 4 | Commit-reveal binding | OK within one deployment. The hash binds `docHash`, `salt`, `bidder` and `id`, so a copied commitment can't be revealed by the copier or replayed into another tender. Info F5: it does not bind `address(this)` or `chainid`. | D2, F5 |
| 5 | Griefing / DoS: unbounded loops | OK. `MAX_BIDDERS = 100`. Worst case (100 revealed bidders, 100 refund transfers) costs 3,879,083 gas in settle. The Kite block gas limit was not checked here. The `slash` array is supplied by the buyer, so a long one only costs the buyer gas. | D8, existing cap test |
| 6 | Griefing / DoS: a bidder that can't receive | **Finding F2.** Refunds are pushed inside `settle`, so one recipient the token refuses to pay reverts the whole settle. | F2 |
| 7 | Griefing / DoS: slot filling | **Finding F1.** One actor can fill all 100 slots, never reveal, and get every bond back. | F1 |
| 8 | Integer / rounding in fee and bounty math | OK. The fee is `floor(amount * feeBps / 10000)`, at most 5%, paid by the buyer on top of the price. Dust rounds the fee down to 0, which favours the buyer by under 1 token unit. Overflow is only possible at absurd amounts, and Solidity 0.8 checked math reverts it. The bounty pool only grows by booked bonds and is capped on payout. The existing 200-tender fuzz test checks token conservation. | D5, existing fuzz |
| 9 | Challenge-window timing edges | OK at the exact boundaries (`finalAt-1` / `finalAt`). An overturn that has not reached quorum is a harmless no-op. | D3 |
| 10 | Quorum double counting / signature replay | OK. There are no signatures, only on-chain votes keyed `(action, approver)`. An action key includes the tender id and bidder (overturn) or the tender id, outcome and round (delivery), so votes don't carry over. Approvers are fixed at deployment. | D4, existing 2-of-3 and round tests |
| 11 | Non-standard ERC20 | No-bool-return tokens work (SafeERC20, existing test), and an EOA "token" reverts because OZ 5 checks for code. **Finding F3**: fee-on-transfer and rebasing tokens break the accounting. Blocklist tokens lead to F2. | existing USDT test, F3, F2 |
| 12 | Front-running reveal/settle | OK for theft: a reveal seen in the mempool can't be used by anyone else, because the bidder is in the hash. Trust items: the buyer can `closeCommits` ahead of a pending commit, and the buyer picks any revealed bidder as winner; price isn't enforced on-chain (I1, I2). A bidder can watch others reveal and then decide not to reveal, at the cost of its bond (I4). | design |

## Findings

Severities are our judgment for a testnet escrow holding faucet-sized bonds. Nothing below lets an outsider steal another user's funds from the contract with a standard ERC20.

### F1 — Medium (availability): nobody revealing means nobody is penalized, and the tender can be blocked by slot filling

`settle` requires a revealed winner (`InvalidWinner`). If no bidder reveals, the buyer can't settle. After `settleDeadline`, `withdraw` returns the full bond to every bidder, revealed or not. Consequences:
- The penalty for not revealing applies only if at least one other bidder revealed.
- An attacker with 100 addresses and 100 × bond can commit to every slot (`MAX_BIDDERS`), lock out honest suppliers (`TooManyBidders`), never reveal, and recover all bonds after the deadline. The cost is gas and locked capital. They can repeat it on every new tender.

Demonstrated by `F1: if nobody reveals…` and `F1: an attacker filling all MAX_BIDDERS slots…`.

Proposed patch (not applied, since the contract is deployed): a bid that was never revealed forfeits in `withdraw` too, as it would at settle.

```solidity
function withdraw(uint256 id) external nonReentrant {
    ...
    b.closed = true;
    if (!b.revealed) {
        bountyPool[address(t.token)] += b.bond;
        emit BondSlashed(id, msg.sender, b.bond, bytes32(0));
        return;
    }
    t.token.safeTransfer(msg.sender, b.bond);
    emit BondWithdrawn(id, msg.sender, b.bond);
}
```
(`withdraw` is then a "close my bid" call that also forfeits. An alternative is to let `settle` accept `winner == address(0)` as "no award".) Trade-off: a bidder that misses its reveal window for an honest reason loses its bond even if the buyer disappears. The existing fuzz test's "nobody revealed → everyone withdraws" branch would need updating.

### F2 — Low: push refunds in `settle`, so one unpayable recipient blocks the whole settle

`settle` refunds every revealed loser with `safeTransfer` inside its loop. If the token refuses one of those transfers, the whole settle reverts. That happens with a USDC/USDT-style blocklist, or with a token that has a receive hook the bidder controls. Here is the only workaround. The buyer lists that bidder in `slash` with some evidence hash, which skips the refund. That marks an innocent bidder as pending-slashed. Even a quorum `overturnSlash` then reverts on the same transfer, so the bond can only end in the bounty pool. With a plain ERC20 (OZ `ERC20`, the test tokens) this can't happen.

Demonstrated by `F2: one revealed bidder the token refuses to pay…` (`BlocklistToken`).

Proposed patch: pull payments. Credit `refundOf[token][bidder] += bond` in `settle` and `overturnSlash`, and add a `claim(token)` that transfers it out.

### F3 — Low: fee-on-transfer / rebasing tokens break the accounting

`commit` books `amount` and `_holdBalance` books `balance + fee` without checking what actually arrived. With a token that takes a cut on transfer, the escrow owes more than it holds. The first refunds or withdrawals are paid partly out of other bidders' bonds, other tenders' bonds in the same token, or the bounty pool. The last one reverts. The buyer picks the token for each tender without restriction, so this depends on someone opening a tender in such a token. The loss falls on other users of that same token, never on other tokens.

Demonstrated by `F3: fee-on-transfer tokens…` (`FeeOnTransferToken`, 1% cut).

Proposed patch: book the balance delta, or revert if it differs:
```solidity
uint256 before = t.token.balanceOf(address(this));
t.token.safeTransferFrom(msg.sender, address(this), amount);
if (t.token.balanceOf(address(this)) - before != amount) revert InvalidParams();
```
(Use the same check in `_holdBalance`.) Or keep an allowlist of tokens.

### F4 — Low: a zero commitment is accepted, can be repeated, and strands the earlier bonds

`commit` uses `b.commitment != 0` as its "already committed" check but never rejects `commitment == 0`. A bidder that sends `0` (a client bug, for example) can commit again and again. Each call takes a bond, increments `committed`, pushes a duplicate into `bidderList` and overwrites `b.bond`. The bid can never be revealed, and `withdraw` rejects it (`commitment == 0`). At settle only the last `b.bond` reaches the bounty pool, and the earlier bonds stay in the contract with no accounting entry and no way out. A stray zero commit also makes `revealed == committed` impossible, which disables early settle. Only the caller's own funds are at risk.

Demonstrated by `F4: a zero commitment is accepted…`.

Proposed patch: `if (commitment == 0) revert InvalidParams();` at the top of `commit`.

### F5 — Informational: the commitment does not bind the escrow address or chain

`commitmentOf` = `keccak256(docHash, salt, bidder, id)`. Every deployment (V1–V5 and any future one) numbers tenders from 1, so the same commitment is valid for the same bidder and tender id on every deployment and chain. Nobody else can use it (`msg.sender` is in the hash). But a bidder (agent) that reuses a doc and salt across deployments would leak its sealed bid in one place by revealing it in another.

Demonstrated by `F5 (info)…`. Proposed: add `address(this), block.chainid` to the hash in the next deployment, and update the JS commitment in the agents to match.

### F6 — Informational (centralization): the treasury controls the whole bounty pool

`payBounty` is treasury-only and pays any amount up to the pool, to any address including the treasury itself, for any non-zero unused evidence hash. "The buyer never profits from a forfeit" holds. The operator could, and every payment is public. The `ponytail:` comment in the code already names this, with the upgrade path (approver votes per bounty). Demonstrated by `F6 (info)…`.

### Other notes (design / trust; no test)

- **I1**: the buyer can choose any revealed bidder as winner, and the contract does not enforce lowest price or score. Trust in the off-chain evaluator.
- **I2**: `closeCommits` lets the buyer end the window ahead of a commit pending in the mempool, which excludes a supplier.
- **I3**: A held delivery balance needs the buyer's confirmation or an approver quorum. There is no timeout fallback, so lost approver keys plus a silent buyer lock it for good.
- **I4**: As in any commit-reveal design, a bidder can see others' reveals before choosing to reveal. Not revealing costs the bond, except in the F1 case.
- **I5**: The buyer can't commit from its own address, but nothing stops it bidding from a second address. Forfeits never reach the buyer, so this gains it nothing on-chain.
- **I6**: `challengeSeconds` is immutable. A huge value would make every settle that lists a slash revert on uint64 overflow. The deployed value is 3600.

## Tests added

- `test/audit-2026-11-16.test.cjs`: 15 tests. F1 (×2), F2, F3, F4, F5 and F6 **pass by asserting the current flawed behaviour**, so they demonstrate the issue on the code as deployed; flip the assertion after a patch. D1–D8 attempt an attack or an edge case and show it fails.
- `contracts/test/AuditTokens.sol`: `FeeOnTransferToken`, `BlocklistToken`, `ReentrantToken` (test-only, never deployed).
- `contracts/LelangEscrow.sol` was **not modified**.

Run: `npx hardhat test` → 52 passing (37 existing + 15 new).

## What this is not

- **Not a professional audit.** One reviewer, a few hours, one free static analyzer (Aderyn could not be installed). No formal verification, no independent second review, no economic or game-theory model of the evaluator/bounty incentives.
- Tests prove only the scenarios they script. Passing D-tests mean those attacks fail, not that no attack exists.
- Only the Solidity file was reviewed. The off-chain evaluator, which decides who gets slashed, and the operator and approver key management carry most of the real-world risk and were not reviewed here.
- The reviewed source (V5) is not byte-for-byte the deployed V4. We did not compare bytecode against Kitescan.
- Don't hold real value in the contract on the strength of this report. SECURITY.md's "No professional audit" line still holds.
