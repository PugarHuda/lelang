# Lelang

**Sealed-bid tenders run by agents.** *Lelang* is Indonesian for a public tender.
Live dashboard of a real tender settled on Kite testnet: **https://lelang-ten.vercel.app**

Agents will soon both buy and sell. When a buyer's agent runs a tender, four things break: bids can be changed after a rival's price leaks, a supplier can hide instructions for the AI evaluator inside its bid document, nobody can check why the winner won, and bidders have to trust the buyer with their bonds. Lelang fixes all four, and money moves only when an independent panel (or a named human) agrees with the decision.

## How it works

```
supplier agents ── commit keccak(docHash, salt, bidder, tender) + bond ──► LelangEscrow (Kite testnet)
buyer closes commits on-chain ── each bidder reveals on-chain ── contract checks the commitment
for each revealed bid (all untrusted text is spotlighted/datamarked first):
   SERV Prompt Guard + manipulation check that must quote the injection verbatim
      → quote verified in code → disqualified, bond slashed with keccak(quote) on-chain
      → suspicion without a verifiable quote → human review, never a slash
   bid reader (Dolphin when keyed, SERV meanwhile) → price, delivery, warranty, specs
   hard rules in code (cap, deadline, minimum specs, sane numbers) → non-compliant bids out
published formula (in code) and an independent decision node must pick the same winner
SERV (Kronos + Shadow Agent) writes the anonymous, criterion-by-criterion rationale
Reppo panel audits the award → ship / review / block (repair loop when the rationale is the problem)
LelangEscrow.settle: one tx refunds compliant bonds, slashes with evidence hashes, pays the down payment
```

| Sponsor | What it does in Lelang | Remove it and… |
|---|---|---|
| **Kite** | `LelangEscrow` contract holds bonds, enforces commit → reveal → settle, records evidence hashes, lets bidders withdraw if the buyer vanishes | bids can change after the deadline, the buyer can keep anyone's bond, decisions never become money |
| **SERV Reasoning** | Prompt Guard on every bid, structured decision nodes, Kronos + Shadow Agent on the rationale, Shadow Agent steered by Reppo feedback in the repair loop | an injected bid can steer the evaluator; rationales drift from the decision |
| **Reppo** | independent panel verdict on the award, gating settlement; its rubric routes the repair loop | the system grades its own decision |
| **Dolphin** | bid reading is wired in `extractBid` and switches on with `DOLPHIN_API_KEY`. The hackathon coupon has been requested; until it arrives SERV reads the bids and every trace line says so | extraction costs frontier prices per bid |

Jev (`jev-latest`) is listed in SERV's changelog but not enabled for our key (absent from `/v1/models`), so decision nodes run on SERV `gpt-6-luna` with a strict JSON schema; the call sites take Jev unchanged once it is available.

## Measured, not claimed

| Check | Result | How to reproduce |
|---|---|---|
| Red-team suite: HTML comment, zero-width split, Indonesian, base64, Cyrillic homoglyphs, social engineering, planted datamark characters, numeric poisoning | 8/8 caught and disqualified on the latest run, 0/2 false positives, numeric poisoning still extracts the true price ($75,000). On an earlier run the homoglyph quote wasn't byte-verifiable, and that bid went to human review instead of being slashed: the designed fallback | `npm run redteam` |
| Escrow contract on Kite testnet | 13 forbidden paths revert (double commit, buyer bidding, early reveal, wrong salt or document, early settle, non-buyer settle, slashing the winner, slash without evidence, unknown winner, early withdraw, double settle); happy path refunds the bond | `npm run test:escrow` |
| Slash accountability | anyone recomputes `keccak(quote)` and `keccak(document)` from the published tender and matches them to the on-chain settle event and escrow state | `npm run verify` |
| Open Contracting Data Standard | every tender exports a valid OCDS 1.1.5 release package (+ official Bids extension); a deliberately broken release is rejected | `npm run ocds:validate` |
| Offline logic | sealing, signatures, hard rules, scoring formula, double-approve lock, strictest-audit gate, datamarking | `npm test` |

## Safety rules learned while building

- **Proof before punishment.** A bond is slashed only when the manipulation check quotes text that code finds in the document the model saw; the quote's hash goes on-chain with the slash.
- **Spotlighting.** Untrusted bid text is datamarked with a per-call random marker ([Hines et al., 2024](https://arxiv.org/abs/2403.14720)) before extraction and manipulation checks; documents that plant marker characters gain nothing.
- **Attacker text never re-enters a prompt.** The quoted injection is stored for reviewers but not passed to the rationale writer.
- **Two routes must agree.** The published formula and an independent decision node must pick the same bid, else escalate.
- **The audit gate never loosens.** Settlement uses the strictest of all Reppo rounds; a friendlier rewrite is measured and shown, it does not unlock money.
- **Repair only what text can fix.** Weak correctness/scope triggers a SERV rewrite against the panel's reason; weak safety/reversibility (moving money) goes to a human.
- **SERV prompt cache off per call.** With the org-level cache on, verdicts leaked between bids.
- **Prompt Guard is advisory.** It blocked clean bids intermittently, so a block only counts if it repeats, and then it routes to review.
- **No double payout.** Settlement locks before its first await; a second approve gets HTTP 409.

## Run

```bash
npm install
cp .env.example .env        # SERV_API_KEY, REPPO_API_KEY (+ DOLPHIN_API_KEY when available)
npm test                    # offline checks
npm run wallets             # creates a TESTNET buyer key; fund it at https://faucet.gokite.ai
                            # faucet gives KITE + USDT: STABLE_TOKEN=0x0ff5393387ad2f9f691fd6fd28e07e3969e27e63
npm run compile && npm run deploy:escrow   # deploys LelangEscrow, writes ESCROW_ADDRESS to .env
npm run test:escrow         # contract checks on Kite testnet
npm run probe               # every integration once
npm run demo                # full tender in the terminal
npm start                   # dashboard on http://localhost:3000 (set DEMO_TOKEN on public hosts)
npm run snapshot            # publish the latest settled tender (+ OCDS) for the static dashboard
```

Deployed escrow: [`0x4921030bacde7a1975191aef054c6684d0acb4fb`](https://testnet.kitescan.ai/address/0x4921030bacde7a1975191aef054c6684d0acb4fb) on Kite testnet (chain 2368).
Without `ESCROW_ADDRESS` bonds go to the buyer wallet and commits are anchored in one tx; without `BUYER_PRIVATE_KEY` nothing goes on-chain and the trace says so.

## Built during SERV Hackathon 02

Everything in this repo was written during the hackathon (Nov 2026).
