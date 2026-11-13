// Proof page for one slash.
import { checkSlash, esc } from './verify.js';

const q = new URLSearchParams(location.search);
const view = document.querySelector('#view');
const fail = (msg) => { view.innerHTML = `<p class="warn">${esc(msg)}</p>`; };

// Highlight the quote inside the document (whitespace-insensitive), without trusting either as HTML.
function highlight(doc, quote) {
  const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = words.length ? doc.match(new RegExp(words.join('\\s+'))) : null;
  return m ? `${esc(doc.slice(0, m.index))}<mark>${esc(m[0])}</mark>${esc(doc.slice(m.index + m[0].length))}` : esc(doc);
}

// A slashed supplier can appeal once, signed with its own key; an independent Reppo panel re-checks the evidence.
function appealHtml(a) {
  if (!a) return `<h2>Appeal</h2><div class="card kv">No appeal. The supplier can appeal once, signed with its own key; an independent panel then re-checks this slash.</div>`;
  const label = { upheld: '<strong class="ok">Slash upheld</strong>', overturned: '<strong class="warn">Slash overturned by a signed human decision: bond refunded, it no longer counts against the supplier</strong>', human: '<strong class="warn">The panel did not confirm the slash: a named approver decides, signed</strong>', pending: 'Pending' }[a.outcome] ?? esc(a.outcome);
  return `<h2>Appeal</h2><div class="card">
    <p class="kv">The supplier appealed (signed with its key):</p><pre>${esc(a.reason)}</pre>
    <p style="margin-top:12px">${label}${a.audit?.score != null ? ` <span class="kv">· independent Reppo panel: ${esc(a.audit.route)} ${esc(a.audit.score)}</span>` : ''}</p>
    ${a.audit?.reason ? `<p class="kv">${esc(a.audit.reason)}</p>` : ''}
    ${a.refundTx ? `<p class="kv"><a href="${esc(a.refundTx)}" target="_blank" rel="noopener">refund transaction</a></p>` : ''}</div>`;
}

try {
  const id = q.get('t') ?? '';
  if (!/^rfq-[\w-]+$/.test(id)) throw new Error('No tender given.');
  const res = await fetch(`tenders/${encodeURIComponent(id)}.json`);
  if (!res.ok) throw new Error('Tender not found.');
  const rfq = await res.json();
  const bid = rfq.bids[q.get('b') ?? ''];
  if (!bid?.slash) throw new Error('That bid was not slashed.');
  const settle = rfq.settlement.find((s) => s.tx)?.tx;
  view.innerHTML = `
    <h1>${esc(bid.label)}'s bond was slashed</h1>
    <p class="kv">Escrow tender #${esc(rfq.chainId)} · ${esc(rfq.title)} · <a href="${esc(settle)}" target="_blank" rel="noopener">settle transaction on Kitescan</a></p>
    <div class="card"><strong>Why:</strong> ${esc(bid.disqualified)}</div>
    ${bid.evidence ? `<h2>The text the supplier hid for the AI evaluator</h2><div class="card"><pre>${esc(bid.evidence)}</pre></div>` : ''}
    <h2>Its revealed bid document</h2><div class="card"><pre>${bid.evidence ? highlight(bid.doc, bid.evidence) : esc(bid.doc)}</pre>
      <p class="kv">This is the exact document the supplier committed to before the deadline (sealed hash) and revealed after it.</p></div>
    <div id="fund"></div>
    ${appealHtml(bid.appeal)}
    <h2>Verify it yourself</h2>
    <div class="card">
      <p class="kv">Your browser hashes the quote and the document above and reads the slash event and the escrow's storage straight from Kite testnet. Nothing on our server is trusted.</p>
      <button id="go">Verify against Kite testnet</button>
      <div id="result" aria-live="polite"></div>
    </div>`;
  // Attackers pay for audits. On escrows V1-V3 the slashed bond went to the buyer; on V4 it goes to the bounty pool.
  const v4 = (rfq.settlement ?? []).some((e) => e.event === 'SlashPending');
  fetch('audit-fund.json').then((r) => (r.ok ? r.json() : null)).then((f) => {
    if (!f) return;
    document.querySelector('#fund').innerHTML = `<h2>Who pays for the audits</h2><div class="card">
      <p>${bid.appeal?.outcome === 'overturned' ? `This bond (${esc(bid.bondPie ?? rfq.bondPie)} USDT) was refunded after the appeal and is not counted.` : `This bond (${esc(bid.bondPie ?? rfq.bondPie)} USDT) ${v4 ? 'goes to the bounty pool that pays whoever finds a hole in the evaluator, never to the buyer (escrow V4)' : 'went to the buyer on-chain (escrow before V4)'}.`} Slashed bonds so far: <strong>${esc(f.slashedUsd)} USDT</strong> from ${esc(f.slashes)} manipulators,
      against ${esc(f.audits)} independent Reppo audits (${esc(f.auditCostUsd)} USD at ${esc(f.auditUsd)} USD each): <strong>${esc(f.coveredPct)}% paid by attackers</strong>.</p>
      ${f.feesUsd ? `<p>Buyers paid <strong>${esc(f.feesUsd)} USD</strong> on top (${esc(f.tenderFees)} tender fee${f.tenderFees === 1 ? '' : 's'} over x402, ${esc(f.successFees)} success fee${f.successFees === 1 ? '' : 's'} at settle): attackers and buyers together cover <strong>${esc(f.coveredWithFeesPct)}%</strong>.</p>` : ''}
      <p class="kv">Testnet bonds are faucet-sized. With a 10 USD bond, one slash pays for ${esc(f.auditsPerSlashAt10UsdBond)} audits.</p></div>`;
  }).catch(() => {});
  const go = document.querySelector('#go');
  const run = async () => {
    go.disabled = true;
    const out = document.querySelector('#result');
    out.innerHTML = '<p class="kv">Reading Kite testnet…</p>';
    try {
      const r = await checkSlash(rfq, bid);
      const row = (what, a, b) => `<tr><th>${what}</th><td>computed here<br><code>${esc(a)}</code></td><td>on Kite<br><code>${esc(b)}</code></td><td class="${a === b ? 'ok' : 'bad'}">${a === b ? '✓ match' : '✗ MISMATCH'}</td></tr>`;
      out.innerHTML = `<p><strong class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ The slash and its evidence match Kite testnet' : '✗ Something does not match Kite testnet'}</strong> <span class="kv">· block ${esc(r.block)}</span></p>
        ${r.status ? `<p>Slash status on-chain: <strong>${esc(r.status)}</strong></p>` : ''}
        <table>${row('keccak256(quote)', r.evidenceComputed, r.evidenceOnChain)}${row('keccak256(document)', r.docComputed, r.docOnChain)}
        <tr><th>quote is in the document</th><td colspan="2">${r.quoteInDoc ? 'yes, character for character (whitespace-insensitive)' : 'no'}</td><td class="${r.quoteInDoc ? 'ok' : 'bad'}">${r.quoteInDoc ? '✓' : '✗'}</td></tr></table>`;
    } catch (e) {
      out.innerHTML = `<p class="warn">Couldn't reach Kite testnet (${esc(e.shortMessage ?? e.message)}). Try again; the settle link above still opens Kitescan.</p>`;
    } finally {
      go.disabled = false;
    }
  };
  go.onclick = run;
  run();
} catch (e) {
  fail(e.message);
}
