# Security and known limits

Lelang runs on testnets. What has been checked, and what has not:

**Checked**
- Escrow (`contracts/LelangEscrow.sol`, V1–V3): 23 Hardhat tests including a 200-tender fuzz, 100% line coverage, Slither with 0 high/medium findings, source verified on Kitescan.
- Payment paths: an independent review found 7 issues, then 4 more in our fixes (one was a replayable payment we introduced), and an automated review 3 more. All fixed; listed in [docs/DETAILS.md](docs/DETAILS.md#security-review-of-the-money-paths).
- Every x402 payment nonce is accepted once; paid tenders hold a slot before charging and refund if the escrow can't open.

**Not done (yet)**
- No professional audit of the contract. Don't hold real value in it.
- No mainnet deploy. Testnet bonds are faucet-sized.
- The operator still names the approvers. `APPEAL_QUORUM` stops one person from overturning a slash alone, but the approver set is not an independent on-chain court.
- The public API is a single Render free instance; its tender state resets on restart (settled tenders are published to the static site, their proofs live on Kite).
- Model-based checks can be fooled. A fooled check can send a bid to a human or let a bad bid compete; a slash needs a verbatim quote that a second, separate check confirms is aimed at the evaluator. Break Lelang pays a bounty for any attack that gets through.

**Reporting**: open an issue on github.com/PugarHuda/lelang, or win the bounty on [Break Lelang](https://lelang-ten.vercel.app/attacks.html).
