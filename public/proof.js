// In-browser chain check for the tender on screen.
import { checkTender, esc } from './verify.js';
const cache = new Map();
window.verifyOnChain = async (rfq) => {
  const el = () => document.querySelector('#proof');
  const key = `${rfq.id}:${rfq.settlement?.length}`;
  try {
    if (!cache.has(key)) cache.set(key, checkTender(rfq));
    const { rows, block } = await cache.get(key);
    const all = rows.every((r) => r.ok);
    // the visitor may have switched tenders while the RPC answered: never show one tender's proof under another
    if (!el() || window.__lastRfq?.id !== rfq.id) return;
    el().innerHTML = `<p><strong class="${all ? 'ok' : 'bad'}">${all ? '✓ Everything above matches Kite testnet' : '✗ Mismatch with Kite testnet'}</strong>
      <span class="kv"> · read live from rpc-testnet.gokite.ai at block ${block}</span></p>
      <ol>${rows.map((r) => `<li><span class="t"></span><span class="s ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'match' : 'MISMATCH'}</span><span>${esc(r.text)}</span></li>`).join('')}</ol>`;
  } catch (e) {
    cache.delete(key);
    if (el() && window.__lastRfq?.id === rfq.id) el().innerHTML = `<p class="warn">Couldn't reach Kite testnet to verify (${esc(e.shortMessage ?? e.message)}). The tender above is shown unverified; every tx link still opens Kitescan.</p>`;
  }
};
// The classic script may have rendered before this module loaded.
if (window.__lastRfq && document.querySelector('#proof')) window.verifyOnChain(window.__lastRfq);
