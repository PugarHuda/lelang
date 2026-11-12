# 01 · Audit (Tech Lead)

Date: 2026-11-12 · Commit at audit: `2a859ed`+ · Deadline: 2026-11-15 23:59 UTC

## Summary

Lelang runs sealed-bid tenders between agents: bids are committed and bonded in an escrow contract on Kite testnet, every bid is checked for evaluator manipulation by SERV, the award is audited by Reppo, and settlement happens in one escrow transaction. The core loop works end to end on testnet (3 settled tenders, tx hashes below).

**Submission readiness at audit: ~70%.** Core product and evidence are real; missing are contract verification on the explorer, a local contract test suite with coverage/fuzz, static analysis, an in-repo E2E suite, CI, live on-chain reads in the public dashboard, and the submission itself.

Architecture note that shapes several phases: buyers and suppliers are **agents** holding their own testnet keys server-side. There is no browser wallet in the flow; the dashboard is a read/approve console. Wallet-connect test scenarios from the mission template therefore don't apply as written. Equivalent coverage is done at the agent/contract layer (Phase 3, 6).

Scan results: no `mock|fake|dummy|TODO|FIXME|lorem|placeholder|coming soon|0x000` in code; `npm audit --omit=dev`: 0 vulnerabilities. The five demo bid documents are scripted supplier-agent inputs (labelled "Demo tender" in the UI); everything done with them is real on-chain.

## Findings

| ID | Area | Severity | Location | Finding |
|---|---|---|---|---|
| C1 | Contract | High | `contracts/LelangEscrow.sol` | Not source-verified on Kitescan: judges can't read the code at the address |
| C2 | Contract | High | — | No local unit/fuzz/invariant tests or coverage; only testnet `eth_call` checks (`scripts/escrow-test.js`) |
| C3 | Contract | Medium | `.env` | Deployed address lives in `.env`/README only; no `deployments/kite-testnet.json` read by the app |
| C4 | Contract | Medium | — | No static analysis (Slither/Aderyn) run |
| C5 | Contract | Low | `LelangEscrow.sol` | Raw `IERC20` without SafeERC20: tokens that return no bool (USDT mainnet style) would revert on `transfer` |
| D1 | dApp | Medium | `public/index.html` | Static dashboard shows a snapshot; it does not read escrow state from the chain, so a visitor must trust the JSON |
| D2 | dApp | Medium | — | No Playwright suite in repo (QA so far was ad-hoc via MCP) |
| D3 | DevOps | Medium | — | No CI |
| D4 | Security | Low | `vercel.json` | No security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy) |
| D5 | Integration | Low | `src/kite.js` | Single RPC endpoint; relies on viem defaults for retry/timeout |
| I1 | Sponsor | — | `src/ai.js` | Dolphin key authenticates but has $0 credit (coupon requested); Jev not enabled for our SERV org (ticket-0522 opened) |
| I2 | Sponsor | — | `src/lelang.js` | Reppo panel often routes `review` on safety of moving money, so settlement usually needs the human approve path |
| X1 | Submission | High | — | Not submitted; X post not made |

## Integration inventory (depth)

| Sponsor | What we use | Depth | Bounty/track fit |
|---|---|---|---|
| SERV Reasoning | Prompt Guard, strict-schema decision nodes, Kronos model suffix, Shadow Agent with dynamic hint, prompt-cache control | Deep | Required for every track ✅ |
| Reppo | Eval API (`action`), rubric-routed repair loop, strictest-round gate, retries | Deep | Reppo track: "real-time feedback into measurable improvement" ✅ |
| Kite | Custom escrow contract on Kite testnet, commit/reveal/settle, evidence-hashed slashing | Medium-deep (chain only; Passport/x402 not used) | Kite track not targeted |
| Dolphin | Wired + tried first, 402 fallback documented | Shallow until credits | Dolphin track not targeted |

## On-chain status

| Item | Value |
|---|---|
| Network | Kite testnet (chain 2368) |
| LelangEscrow | `0x4921030bacde7a1975191aef054c6684d0acb4fb` (verification: **no**, see C1) |
| Deploy tx | `0x3e276b3a7fbf581c8c7464f10a7e97108f8020ea0458439a2816ff0f835b209d` |
| Settled tender (published) | escrow tender #3, settle tx `0x…` in `public/tender.json` (13 tx hashes, all `success` on RPC) |
| Stablecoin | Kite faucet USDT `0x0ff5393387ad2f9f691fd6fd28e07e3969e27e63` |

## Priorities (impact on judging: creativity, user readiness, revenue potential)

1. X1 submission + X post (hard requirement).
2. C1 verify contract, C3 deployments file, D1 live on-chain verification in the public dashboard (user readiness + trust).
3. C2 contract tests with coverage/fuzz, C4 static analysis, C5 SafeERC20.
4. D2 E2E suite, D3 CI, D4 headers.
5. Sponsor blockers I1 (waiting on credits/support).
