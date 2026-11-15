# Security and known limits

Lelang runs on testnets. What has been checked, and what has not:

**Checked**
- Escrow (`contracts/LelangEscrow.sol`; V1–V4 deployed and verified on Kitescan, the source at HEAD is V5, which only adds a 1-hour delivery timelock): 52 Hardhat tests including a 200-tender fuzz, 100% line coverage, Slither 0.11.6 with 0 high/medium findings.
- A free, tool-assisted review (16 Nov, one reviewer, not a professional audit): [docs/reports/free-audit-2026-11-16.md](docs/reports/free-audit-2026-11-16.md). No way found for an outsider to take another user's funds with a standard ERC20; 15 new tests. Open findings, each with a test that demonstrates it and a proposed patch: **F1 (medium, availability)** an attacker can fill every bidder slot, never reveal and withdraw its bonds in full, blocking a tender; F2 (low) a bidder whose token transfer reverts blocks settle (push refunds); F3 (low) fee-on-transfer tokens are not supported; F4 (low) a zero commitment is accepted; F5/F6 informational. They apply to the deployed V4. **All six are fixed in escrow V5** (53 Hardhat tests, 100% line coverage, Slither 0 high/medium), deployed separately and verified on Kitescan: [0x0b38…821a](https://testnet.kitescan.ai/address/0x0b38d1f087e0f25f930a9227a3dc882fbc16821a?tab=contract). The live API stays on V4 (its bounty pool, proofs and tenders) until after the hackathon; the bid tools still build the V1–V4 commitment and need the V5 domain before anyone bids there.
- Payment paths: an independent review found 7 issues, then 4 more in our fixes (one was a replayable payment we introduced), and an automated review 3 more. All fixed; listed in [docs/DETAILS.md](docs/DETAILS.md#security-review-of-the-money-paths).
- Every x402 payment nonce is accepted once; paid tenders hold a slot before charging and refund if the escrow can't open.

**Not done (yet)**
- No professional audit of the contract. Don't hold real value in it.
- No mainnet deploy. Testnet bonds are faucet-sized.
- The operator still names the approvers. `APPEAL_QUORUM` stops one person from overturning a slash alone, but the approver set is not an independent on-chain court.
- The public API is a single Render free instance; its tender state resets on restart (settled tenders are published to the static site, their proofs live on Kite).
- Model-based checks can be fooled. A fooled check can send a bid to a human or let a bad bid compete; a slash needs a verbatim quote that a second, separate check confirms is aimed at the evaluator. Break Lelang pays a bounty for any attack that gets through.

**Reporting**: open an issue on github.com/PugarHuda/lelang, or win the bounty on [Break Lelang](https://lelang-ten.vercel.app/attacks.html).
