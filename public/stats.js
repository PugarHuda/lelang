// "Lelang in numbers": every count read live (Kite RPC from the browser, the Break Lelang API, the published red-team
// file). A source that can't be reached shows "couldn't reach" on its own tiles; nothing is ever filled in.
import { createPublicClient, http, defineChain, formatUnits, parseEventLogs } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

// Same rule as buy.js: only a local server may replace the public API (?api=http://localhost:3000 for tests).
const override = new URLSearchParams(location.search).get('api');
const API = override && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override) ? override : 'https://lelang-6k05.onrender.com';
const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 20_000, retryCount: 2 }) });
const X = 'https://testnet.kitescan.ai';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? '?'));
const addr = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `<a href="${X}/address/${esc(a)}" title="${esc(a)}"><code>${esc(short(a))}</code></a>` : esc(a ?? '?'));
const TX = (h) => `<a href="${X}/tx/${esc(h)}">tx</a>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errMsg = (e) => esc(e?.shortMessage ?? e?.message ?? e);
const ERC20 = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

async function chain() {
  const d = await (await fetch('deployment.json')).json();
  const escrows = [d, ...(d.previous ?? [])].map((e, i) => ({ address: e.escrow.address.toLowerCase(), block: BigInt(e.escrow.block), abi: e.abi, label: i ? `V${d.previous.length - i + 1}` : 'V4 (current)' }));
  // every event any escrow version emits, deduplicated by signature, so one getLogs call decodes them all
  const seen = new Set();
  const events = escrows.flatMap((e) => e.abi).filter((f) => f.type === 'event' && !seen.has(JSON.stringify([f.name, f.inputs])) && seen.add(JSON.stringify([f.name, f.inputs])));
  const fromBlock = escrows.reduce((m, e) => (e.block < m ? e.block : m), escrows[0].block);
  // ponytail: one getLogs over the whole range (Kite's RPC returns it unchunked today); chunk it if the RPC starts capping ranges
  const [raw, latest] = await Promise.all([client.getLogs({ address: escrows.map((e) => e.address), fromBlock }), client.getBlock()]);
  const logs = parseEventLogs({ abi: events, logs: raw });
  const of = (name, at = null) => logs.filter((l) => l.eventName === name && (!at || l.address.toLowerCase() === at));

  const tokenOf = Object.fromEntries(of('TenderOpened').map((l) => [`${l.address.toLowerCase()}:${l.args.id}`, l.args.token.toLowerCase()]));
  const tokens = [...new Set([...Object.values(tokenOf), ...of('BountyPaid').map((l) => l.args.token.toLowerCase())])];
  const meta = Object.fromEntries(await Promise.all(tokens.map(async (t) => [t, {
    decimals: await client.readContract({ address: t, abi: ERC20, functionName: 'decimals' }),
    symbol: await client.readContract({ address: t, abi: ERC20, functionName: 'symbol' }),
  }])));
  const sum = (pairs) => {
    const m = new Map();
    for (const [t, v] of pairs) m.set(t, (m.get(t) ?? 0n) + v);
    const parts = [...m].filter(([, v]) => v > 0n).map(([t, v]) => `${formatUnits(v, meta[t]?.decimals ?? 18)} ${meta[t]?.symbol ?? short(t)}`);
    return parts.length ? parts.join(' + ') : '0';
  };
  const fees = (at) => sum(of('FeePaid', at).map((l) => [tokenOf[`${l.address.toLowerCase()}:${l.args.id}`], l.args.amount]));

  const v4 = escrows[0];
  const hasPool = v4.abi.some((f) => f.name === 'bountyPool');
  const pool = hasPool ? sum(await Promise.all(tokens.map(async (t) => [t, await client.readContract({ address: v4.address, abi: v4.abi, functionName: 'bountyPool', args: [t] })]))) : null;

  const key = (l) => `${l.address.toLowerCase()}:${l.args.id}:${l.args.bidder.toLowerCase()}`;
  const closed = new Set([...of('BondSlashed'), ...of('SlashOverturned')].map(key));
  const slashed = of('BondSlashed');
  return {
    escrows, latest, meta, fees, pool, v4,
    tenders: of('TenderOpened').length, bids: of('Committed').length,
    proven: slashed.filter((l) => BigInt(l.args.evidenceHash) !== 0n).length, forfeited: slashed.filter((l) => BigInt(l.args.evidenceHash) === 0n).length,
    pending: of('SlashPending').filter((l) => !closed.has(key(l))).length, overturned: of('SlashOverturned').length,
    bounties: of('BountyPaid'), bountyTotal: sum(of('BountyPaid').map((l) => [l.args.token.toLowerCase(), l.args.amount])),
    perEscrow: escrows.map((e) => ({ ...e, tenders: of('TenderOpened', e.address).length, bids: of('Committed', e.address).length, slashes: of('BondSlashed', e.address).length, fees: fees(e.address) })),
  };
}

const api = async () => {
  const r = await fetch(`${API}/api/challenge`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const redteam = async () => (await (await fetch('attacks.json')).json()).fixed.summary;

const verdict = (e) => (e.wouldWin ? ['bad', 'would win'] : /^slashed/.test(e.outcome) ? ['ok', 'caught: slashed'] : /^held/.test(e.outcome) ? ['warn', 'held for a human'] : ['kv', 'harmless']);

const [c, a, r] = await Promise.allSettled([chain(), api(), redteam()]);
const C = c.value, A = a.value, R = r.value;
const down = (res, what) => `<span class="warn">couldn't reach ${what}</span><br><span class="kv">${errMsg(res.reason)}</span>`;
const tile = (label, href, res, what, value, sub) => `<a class="card tile" href="${esc(href)}"><div class="label">${esc(label)}</div>${
  res.status === 'fulfilled' ? `<div class="big">${value()}</div><div class="kv">${sub()}</div>` : `<div class="big warn">${down(res, what)}</div>`}</a>`;

const v4url = C ? `${X}/address/${C.v4.address}?tab=logs` : X;
const live = A ? A.entries.filter((e) => !e.wouldWin && /^(slashed|held)/.test(e.outcome)).length : 0;
$('tiles').innerHTML = [
  tile('Tenders opened', v4url, c, 'Kite testnet', () => C.tenders, () => `TenderOpened on ${plural(C.escrows.length, 'escrow')} · fees ${esc(C.fees(null))}`),
  tile('Sealed bids committed', v4url, c, 'Kite testnet', () => C.bids, () => 'Committed events: a hash on-chain, the document stays sealed until reveal'),
  tile('Red-team attacks caught', 'attacks.html', r, 'attacks.json', () => `${esc(R.caught)}/${esc(R.attackTrials)}`,
    () => `${esc(R.slashedWithProof)} slashed with proof, ${esc(R.missed)} missed, ${esc(R.falsePositives)} false alarms on ${esc(R.cleanTrials)} honest runs${A ? ` · Break Lelang: ${live} of ${A.entries.length} public attempts caught` : ''}`),
  tile('Slashes verified on Kite', 'pool.html', c, 'Kite testnet', () => C.proven,
    () => `BondSlashed with an evidence hash · ${plural(C.forfeited, 'unrevealed bond')} forfeited · ${C.pending} pending · ${C.overturned} overturned on appeal`),
  tile('Bounty pool (V4)', 'pool.html', c, 'Kite testnet', () => esc(C.pool ?? 'n/a'), () => `bountyPool() on the V4 escrow at block ${esc(C.latest.number)}`),
  tile('Bounties paid', 'pool.html', c, 'Kite testnet', () => C.bounties.length, () => `BountyPaid events, ${esc(C.bountyTotal)} in total`),
].join('');

$('escrows').innerHTML = C ? `<table><tr><th>Escrow</th><th class="n">Tenders</th><th class="n">Bids</th><th class="n">Slashes</th><th>Fees paid</th></tr>${C.perEscrow.map((e) => `<tr><td>${esc(e.label)} ${addr(e.address)}</td><td class="n">${e.tenders}</td><td class="n">${e.bids}</td><td class="n">${e.slashes}</td><td>${esc(e.fees)}</td></tr>`).join('')}</table>`
  : `<p>${down(c, 'Kite testnet')}</p>`;

$('bounties').innerHTML = !C ? `<p>${down(c, 'Kite testnet')}</p>` : C.bounties.length
  ? `<table><tr><th>To</th><th>Amount</th><th>Evidence hash</th><th></th></tr>${C.bounties.map((l) => { const t = C.meta[l.args.token.toLowerCase()]; return `<tr><td>${addr(l.args.to)}</td><td>${esc(formatUnits(l.args.amount, t?.decimals ?? 18))} ${esc(t?.symbol ?? '')}</td><td><code>${esc(l.args.evidenceHash.slice(0, 18))}…</code></td><td>${TX(l.transactionHash)}</td></tr>`; }).join('')}</table>`
  : '<p class="kv">No BountyPaid event yet. The first Break Lelang attack that would win is paid from the pool.</p>';

if (A) {
  const by = new Map();
  for (const e of A.entries) {
    const p = by.get(e.payer) ?? { payer: e.payer, attempts: 0, caught: 0, won: 0, paid: 0, asset: '' };
    p.attempts++;
    if (e.wouldWin) p.won++; else if (/^(slashed|held)/.test(e.outcome)) p.caught++;
    if (e.bounty?.status === 'sent') { p.paid += Number(e.bounty.amount) || 0; p.asset = String(e.bounty.asset ?? '').split(' ')[0]; }
    by.set(e.payer, p);
  }
  const rows = [...by.values()].sort((x, y) => y.won - x.won || y.attempts - x.attempts);
  const note = `<p class="kv">${plural(A.attempts, 'attempt')} so far, ${plural(A.wins, 'win')}, ${plural(A.bountiesPaid, 'bounty', 'bounties')} sent${A.entries.length < A.attempts ? ` (table covers the latest ${A.entries.length})` : ''}. Each attempt costs a small x402 fee; a win pays up to ${esc(A.poolCap)} ${esc(A.poolToken ?? '')} from the pool. <a href="attacks.html">Try it</a>.</p>`;
  $('board').innerHTML = rows.length
    ? `<table><tr><th>Attacker</th><th class="n">Attempts</th><th class="n">Caught</th><th class="n">Won</th><th class="n">Bounty paid</th></tr>${rows.map((p) => `<tr><td>${addr(p.payer)}</td><td class="n">${p.attempts}</td><td class="n">${p.caught}</td><td class="n ${p.won ? 'bad' : ''}">${p.won}</td><td class="n">${p.paid ? `${esc(p.paid)} ${esc(p.asset)}` : '–'}</td></tr>`).join('')}</table>${note}`
    : `<p class="kv">Nobody has tried yet. Be the first: <a href="attacks.html">Break Lelang</a>.</p>${note}`;
  $('attempts').innerHTML = A.entries.length
    ? `<table><tr><th>When (UTC)</th><th>Who</th><th>Outcome</th><th></th></tr>${A.entries.map((e) => { const [cls, label] = verdict(e); return `<tr><td>${esc(String(e.at ?? '').slice(0, 16).replace('T', ' '))}</td><td>${addr(e.payer)}</td><td class="${cls}">${esc(label)}</td><td>${/^https:\/\/testnet\.kitescan\.ai\//.test(e.paymentTx ?? '') ? `<a href="${esc(e.paymentTx)}">payment</a>` : ''}${/^https:\/\/testnet\.kitescan\.ai\//.test(e.bounty?.tx ?? '') ? ` · <a href="${esc(e.bounty.tx)}">bounty</a>` : ''}</td></tr>`; }).join('')}</table>`
    : '<p class="kv">No attempts recorded yet.</p>';
} else {
  $('board').innerHTML = $('attempts').innerHTML = `<p>${down(a, 'the Break Lelang API')}</p>`;
}
window.__statsDone = true;
