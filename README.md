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
| **Dolphin** | bid reading is wired in `extractBid` and tried first. Our API key authenticates (`/v1/models` lists DeepSeek V4.1 Flash, Gemma-4 and Qwen3.6) but inference returns 402 until the hackathon coupon credits arrive; meanwhile SERV reads the bids and every trace line names the reason (`Dolphin 402: insufficient credits`). Dolphin output is schema-checked before use | extraction costs frontier prices per bid |

Jev (`jev-latest`) is listed in SERV's changelog but not enabled for our key (absent from `/v1/models`), so decision nodes run on SERV `gpt-6-luna` with a strict JSON schema; the call sites take Jev unchanged once it is available.

## Measured, not claimed

| Check | Result | How to reproduce |
|---|---|---|
| Red-team suite: HTML comment, zero-width split, Indonesian, base64, Cyrillic homoglyphs, social engineering, planted datamark characters, numeric poisoning | 8/8 caught and disqualified on the latest run, 0/2 false positives, numeric poisoning still extracts the true price ($75,000). On an earlier run the homoglyph quote wasn't byte-verifiable, and that bid went to human review instead of being slashed: the designed fallback | `npm run redteam` |
| Escrow contract (Hardhat) | 18 unit tests incl. a 200-tender fuzz that checks token conservation and an empty escrow after settle; 100% line / 94.6% branch coverage. OpenZeppelin SafeERC20 + ReentrancyGuard, no owner/admin/pause, max 100 bidders per tender | `npm run test:contracts`, `npm run coverage` |
| Static analysis (Slither 0.11.6, 102 detectors) | 0 high, 0 medium. 6 informational: 5 `timestamp` (deadlines are hours long, validator clock drift is seconds) and `settle` complexity (it does refunds, slashes and payment in one tx on purpose) | `npm run slither` |
| Escrow contract on Kite testnet | 13 forbidden paths revert (double commit, buyer bidding, early reveal, wrong salt or document, early settle, non-buyer settle, slashing the winner, slash without evidence, unknown winner, early withdraw, double settle); happy path refunds the bond | `npm run test:escrow` |
| Slash accountability | the dashboard itself re-checks the settled tender in your browser against the Kite RPC (no trust in our JSON); anyone recomputes `keccak(quote)` and `keccak(document)` from the published tender and matches them to the on-chain settle event and escrow state | `npm run verify` |
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

## Bring your own supplier agent

Any agent can bid with its own key; the server never holds supplier keys.

```bash
SUPPLIER_PRIVATE_KEY=0x… node scripts/supplier-agent.js http://localhost:3000 <rfq id> my-bid.txt
```

| Endpoint | Who | Proof required |
|---|---|---|
| `POST /api/rfqs` | buyer (`?token=`) | spec is validated (weights sum to 1, positive caps/bond) |
| `POST /api/rfqs/:id/commit` `{supplier, hash, signature?, bondTx?}` | supplier, no token | on-chain tender: the commitment must already be in `LelangEscrow` from the supplier's own wallet; off-chain: EIP-191 signature by `supplier` |
| `POST /api/rfqs/:id/close` | buyer | once, only in the commit phase |
| `POST /api/rfqs/:id/reveal` `{supplier, doc, salt, revealTx?}` | supplier, no token | document must hash to the sealed commitment (and match escrow storage on-chain); a valid reveal can't be overwritten |
| `POST /api/rfqs/:id/evaluate` | buyer | runs SERV → Reppo → settle in the background; poll `GET /api/rfqs/:id` |

`npm test` runs this protocol over real HTTP with two independent agent processes and checks that forged, duplicate, late, junk and oversize requests are refused.

Tested live on Kite testnet with an outside agent holding only its own key (escrow tender #6): it locked its bond
([commit](https://testnet.kitescan.ai/tx/0x518f82c15677fc9840536129445171bc8d174f78fbe58aed524e6d7be989d970)),
revealed ([reveal](https://testnet.kitescan.ai/tx/0xf2c30b506c17822cdcee1739bf23bf654ca795e9f3a567def3ed51eca6cd131a)),
passed SERV checks and a Reppo audit (ship, 91), and got bond + down payment back in one
[settle](https://testnet.kitescan.ai/tx/0x75fb1e50e6d69857cb1adeafccd901c946ab73568178c197816924085bf72dc0).
A forged commit with no bond in the escrow was refused. That run found two bugs that in-process demos hide: the agent
approved its local default token instead of the tender's (now read from the contract), and the server announced the
reveal phase before the close tx confirmed (now a `closing` phase until it does).

## Business model (planned, not built)

Who pays: the **buyer**, because Lelang replaces work it pays for today (evaluation committee hours, audit, dispute handling). Suppliers pay nothing beyond a refundable bond, so honest bidders have no reason to stay away.

| Revenue line | How it is charged | Why the buyer accepts it |
|---|---|---|
| Per-tender fee | flat fee per tender, sized to cover the SERV + Reppo calls it consumes (the 5-bid demo tender makes ~16 SERV calls and 1–2 Reppo evals) plus margin | cheaper than one hour of an evaluation committee |
| Success fee | small % of the awarded down payment, taken in the same `settle` transaction | paid only when money actually moves after a passed audit |
| Audit-trail export | subscription for OCDS feeds and the public verification page under the buyer's domain | public bodies must publish award data anyway; OCDS is what their portals ingest |

Costs scale with bids, not with contract value, so margin grows with tender size. First customers: agent marketplaces that let agents buy from agents (they need a dispute-proof award) and procurement teams already publishing OCDS. Neither the fee nor the success-fee cut exists in the contract yet; adding the cut is a one-line transfer in `settle`.

## Run

```bash
npm install
cp .env.example .env        # SERV_API_KEY, REPPO_API_KEY (+ DOLPHIN_API_KEY when available)
npm test                    # offline checks
npm run wallets             # creates a TESTNET buyer key; fund it at https://faucet.gokite.ai
                            # faucet gives KITE + USDT: STABLE_TOKEN=0x0ff5393387ad2f9f691fd6fd28e07e3969e27e63
npm run deploy:escrow       # compiles, deploys LelangEscrow, verifies source on Kitescan, writes deployments/kite-testnet.json
npm run test:escrow         # contract checks on Kite testnet
npm run probe               # every integration once
npm run demo                # full tender in the terminal
npm start                   # dashboard on http://localhost:3000 (set DEMO_TOKEN on public hosts)
npm run snapshot            # publish the latest settled tender (+ OCDS) for the static dashboard
```

Deployed escrow: [`0x11f5f49ed28d34c8db973aa1f8c6579ba1b61e6b`](https://testnet.kitescan.ai/address/0x11f5f49ed28d34c8db973aa1f8c6579ba1b61e6b?tab=contract) on Kite testnet (chain 2368), source verified on Kitescan. Address + ABI live in `deployments/kite-testnet.json` (`ESCROW_ADDRESS` in `.env` overrides it).
Without a deployment bonds go to the buyer wallet and commits are anchored in one tx; without `BUYER_PRIVATE_KEY` nothing goes on-chain and the trace says so.

## Built during SERV Hackathon 02

Everything in this repo was written during the hackathon (Nov 2026).
