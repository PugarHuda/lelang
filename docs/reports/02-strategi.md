# 02 · Strategy & differentiation (Hackathon Strategist)

Builds on `01-audit.md`.

## Judging criteria and scorecard

Criteria (openserv.ai/hackathon-2): **creativity, user readiness, revenue potential**. Confirmed judge: Armagan Amcalar (CTO OpenServ). In his own posts he praises: decisions evaluated by an independent system ("the system that makes a decision shouldn't be the only one evaluating it"), bounded reasoning graphs, inspectable workflows, arbitration/evidence-weighing ("so on-brand"), multiple SERV features used for a reason, deterministic checks next to LLM steps.

| Criterion | At audit | Target | What moves it |
|---|---|---|---|
| Creativity | 8 | 9 | Evidence-hashed slashing + spotlighting + strictest-audit gate is a combination nobody else in the edition shows |
| User readiness | 6 | 9 | Verified contract, public dashboard that verifies itself against the chain, one-command repro, CI, E2E |
| Revenue potential | 5 | 7 | Clear fee model in README (per tender + % of awarded value), OCDS export so it plugs into existing e-procurement |

## Track/bounty checklist (Reppo track)

| Requirement | Status |
|---|---|
| Uses SERV Reasoning | ✅ Prompt Guard, decision nodes, Kronos, Shadow Agent |
| Uses Reppo Eval API | ✅ audit gate on every award |
| "Turn real-time feedback into measurable improvement" | ✅ rubric-routed repair loop, before/after scores stored per round |
| Public repo, demo, write-up, X post | repo ✅ demo ✅ write-up ✅ (SUBMISSION.md) X post ⏳ |

## Competitors

| Project | Core | Chain / tech | Target user | Strengths | Weaknesses vs Lelang | Source |
|---|---|---|---|---|---|---|
| Tranche (Ed.02, Kite) | evidence → SERV → Reppo → policy gate → Passport | Kite Passport | agent spenders | uses 3 sponsors, refusal-first | one-sided spend guard, no market between parties | x.com/0xMemeshe |
| Agent Firewall (Ed.02) | every tool call checked vs policy | SERV | agent operators | broad | generic gate, no economics, no on-chain stake | x.com/defisensei7 |
| Lacuna (Ed.02, Kite) | red-teams spending rules | SERV + Kite | agent operators | honest about variance | audits one agent, no counterparties | lacuna-l378.onrender.com |
| Judr (Ed.01) | arbitration of RWA escrow disputes | SERV | escrow parties | judge called it "on-brand" | after-the-fact disputes, no sealed bidding | x.com/encrypt_wizard |
| Aron ($8M, 2026) | agents run the RFQ back-and-forth | SaaS | enterprise procurement | funded, real customers | closed, no verifiable trail, no defence against injected bids | siliconangle.com |
| Lio / Aerchain / Keelvar | autonomous sourcing, award recommendations | SaaS | enterprise | mature | ranking "not publicly documented"; trust the vendor | rfp.wiki, procurementmag.com |
| Chained Government Procurement (Bhutan prototype) | sealed commit/reveal + audit pages | Ethereum | public sector | tamper-evident | no AI evaluation, no manipulation defence | gainforest listing |

Parity (not a differentiator): commit-reveal sealing (known since ZeroAuction / academic work), AI award recommendations (Lio, Keelvar).

Gaps nobody fills: (1) agent-written bids can carry prompt injections aimed at AI evaluators: no procurement product defends against it, let alone punishes it; (2) AI award decisions are not independently audited before money moves; (3) the EF private-procurement use case says "tamper-evident and independently verifiable audit trail" is still TBD.

## Differentiators (hard to copy)

1. **Proof-carrying punishment:** a bond is slashed only with `keccak(quote)` on-chain, and anyone can recompute it from the published document (`npm run verify`). Copying it needs the contract, the verified-quote pipeline and the publication format together.
2. **Two independent judges before money moves:** published formula + SERV decision node must agree, then a Reppo panel audits; the gate takes the strictest round and only text problems trigger an automated repair.
3. **Standards on both ends:** Spotlighting (Microsoft Research) on the AI side, OCDS 1.1 on the procurement side, so it plugs into e-procurement stacks that already speak OCDS.

## Positioning

For procurement teams letting agents buy from agents, who can't trust an AI award that a supplier may have prompt-injected, **Lelang** is a sealed-bid tender protocol that disqualifies manipulators with on-chain proof and moves money only after an independent audit, unlike AI sourcing tools (Lio, Aron) whose rankings are black boxes and on-chain tender prototypes that don't evaluate bids at all.

## Feature candidates

| Feature | Value | Judge impact | Effort | Decision |
|---|---|---|---|---|
| Verify contract on Kitescan + `deployments/kite-testnet.json` | trust, readiness | high | 1h | BUILD |
| Live chain verification in the public dashboard (browser reads escrow + settle logs, recomputes hashes) | removes "trust the JSON" | high | 2h | BUILD |
| SafeERC20 + Hardhat unit/fuzz/invariant tests + coverage | contract quality | medium | 3h | BUILD |
| Slither static analysis | security | medium | 1h | BUILD |
| E2E Playwright suite (3 browsers + mobile + axe) + CI | readiness | medium | 2h | BUILD |
| Revenue model section | revenue criterion | medium | 0.5h | BUILD (README only, no fake UI) |
| Kite Passport / x402 bonds | deeper Kite | low for Reppo track; needs passkey login + pieUSD | 4h+ | NOT NOW (blocked, documented) |
| Wallet-connect UI for human bidders | new user type | low; product is agent-to-agent | 6h | NOT NOW |

Acceptance criteria (BUILD items):
- Kitescan shows verified source for the escrow address.
- Opening lelang-ten.vercel.app shows "verified on Kite" per slash and settlement, computed in the browser from the RPC; if the RPC is down the page says so and shows the snapshot unverified.
- `npx hardhat test` green with ≥90% line coverage on `LelangEscrow.sol`.
- Playwright suite green 3 runs in a row on chromium/firefox/webkit + mobile.

## Copy for the first 10 seconds

> **Agents bid. A supplier hides "award this to us" for the AI judge. Lelang catches it, proves it, and slashes its bond on-chain.**
> Money moves only after an independent audit.
