// Bidder reputation, recomputed in the browser from Kite: the same rule the evaluator applies (src/lelang.js
// provenPriors + requiredBond), so anyone can check what a bidder will be asked to lock before it bids.
import { slashEvents, esc } from './verify.js';

const $ = (s) => document.querySelector(s);
const explorer = 'https://testnet.kitescan.ai';
const key = (escrow, tender, bidder) => `${escrow.toLowerCase()}:${tender}:${bidder.toLowerCase()}`;

// Published tenders tell us which slashes were overturned on appeal (refunded; they never count) and where proofs live.
async function published() {
  const index = await (await fetch('tenders.json')).json();
  const tenders = await Promise.all(index.map((t) => fetch(`tenders/${t.id}.json`).then((r) => r.json())));
  const byKey = new Map();
  for (const r of tenders) for (const b of Object.values(r.bids)) byKey.set(key(r.escrow ?? '', r.chainId, b.supplier), { rfq: r, bid: b });
  return byKey;
}

async function show(addr) {
  const view = $('#result');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { view.innerHTML = '<p class="bad">Enter a 0x… address (40 hex characters).</p>'; return; }
  view.innerHTML = '<p class="kv">Reading slash events from both escrows on Kite testnet…</p>';
  try {
    const [{ events, trustedBuyer }, pub] = await Promise.all([slashEvents(addr), published()]);
    const rows = events.map((e) => {
      const p = pub.get(key(e.escrow, e.tender, addr));
      const status = BigInt(e.evidenceHash) === 0n ? ['mute', 'never revealed: not proof of manipulation, does not count']
        : e.buyer.toLowerCase() !== trustedBuyer.toLowerCase() ? ['mute', 'tender opened by an untrusted buyer: does not count']
        : p?.bid.appeal?.outcome === 'overturned' ? ['ok', 'overturned on appeal and refunded: does not count']
        : ['bad', 'proven manipulation: counts'];
      return { e, p, status, counts: status[1].endsWith(': counts') };
    });
    const n = rows.filter((r) => r.counts).length;
    const mult = 2 ** Math.min(n, 4);
    view.innerHTML = `
      <div class="card ${n ? 'warn' : 'ok'}">
        <p style="margin:0"><b>${n} proven slash${n === 1 ? '' : 'es'}</b> for <code>${esc(addr)}</code></p>
        <p class="kv" style="margin:6px 0 0">Bond it is asked to lock: <b>${mult}× the tender bond</b>${n ? ` (base × 2^${Math.min(n, 4)}${n > 4 ? ', capped at 16×' : ''}). Locking less, it can still bid, but it can't win without a human looking first.` : '. No history: it bids at the tender bond like anyone else.'}</p>
      </div>
      <h2>Every slash on record (${events.length})</h2>
      ${events.length ? `<table><tr><th>Escrow tender</th><th>Status</th><th>Evidence</th><th>Links</th></tr>
        ${rows.map(({ e, p, status }) => `<tr>
          <td>#${esc(e.tender)}<br><span class="kv">escrow ${esc(e.escrow.slice(0, 8))}… · ${esc(e.amount)} lost</span></td>
          <td class="${status[0]}">${esc(status[1])}</td>
          <td><code>${esc(e.evidenceHash.slice(0, 18))}…</code></td>
          <td><a href="${explorer}/tx/${esc(e.tx)}" target="_blank" rel="noopener">tx</a>${p?.bid.slash ? ` · <a href="slash.html?t=${encodeURIComponent(p.rfq.id)}&b=${encodeURIComponent(p.bid.label)}">proof page</a>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="kv">No BondSlashed event for this address on any Lelang escrow.</p>'}
      <p class="kv">Read live from the Kite RPC in your browser; only the list of published tenders (to know which slashes were overturned) comes from this site. Trusted buyer: <code>${esc(trustedBuyer)}</code>.</p>`;
    window.__repDone = { addr, n, mult };
  } catch (e) {
    view.innerHTML = `<p class="bad">Couldn't reach Kite testnet: ${esc(e.shortMessage ?? e.message)}</p>`;
    window.__repDone = { addr, error: true };
  }
}

$('#view').innerHTML = `
  <h1>Bidder reputation</h1>
  <p class="kv">A bidder slashed with on-chain evidence can bid again, but its bond doubles per proven slash. This page recomputes that from the escrow contracts on Kite, so a bidder (or a buyer) can check the price of a history before a tender starts.</p>
  <form id="f" class="card" style="display:flex;gap:8px;flex-wrap:wrap"><input id="a" placeholder="0x… bidder address" aria-label="bidder address" style="flex:1;min-width:220px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:13px ui-monospace,monospace"><button>Check</button></form>
  <div id="result" style="margin-top:16px"></div>`;
const a = new URLSearchParams(location.search).get('a') ?? '';
$('#a').value = a;
$('#f').addEventListener('submit', (ev) => { ev.preventDefault(); history.replaceState(null, '', `?a=${$('#a').value.trim()}`); show($('#a').value.trim()); });
if (a) show(a);
