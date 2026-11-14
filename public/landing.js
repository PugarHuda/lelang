// Overview page: four headline counts read from the Lelang escrows on Kite by the visitor's browser.
// Same reads as stats.js (which runs on load and exports nothing), cut down to what the overview shows.
// A failed read says so on its tile; no number is ever filled in.
import { createPublicClient, http, defineChain, formatUnits, parseEventLogs } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 20_000, retryCount: 2 }) });
const ERC20 = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];
// ---- motion (modelled on the CoreShift shot: blur-in words, parallax, rotating arc, fanned cards) ----
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
for (const h of document.querySelectorAll('[data-words]')) {
  let i = 0;
  for (const n of [...h.childNodes]) {
    if (n.nodeType !== 3) continue;
    const f = document.createDocumentFragment();
    for (const part of n.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { f.append(part); continue; }
      const w = document.createElement('span'); w.className = 'w'; w.style.setProperty('--i', i++); w.textContent = part; f.append(w);
    }
    n.replaceWith(f);
  }
}
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 });
document.querySelectorAll('[data-words], .rise, .card').forEach((el) => io.observe(el));

const movers = [...document.querySelectorAll('[data-speed]')];
const wordmark = document.getElementById('wordmark');
let ticking = false;
const onScroll = () => {
  ticking = false;
  const vh = innerHeight;
  for (const el of movers) {
    const r = el.parentElement.getBoundingClientRect();
    el.style.transform = `translateY(${((r.top + r.height / 2 - vh / 2) * Number(el.dataset.speed)).toFixed(1)}px)`;
  }
  const t = Math.min(1, Math.max(0, (vh - wordmark.getBoundingClientRect().top) / (vh * 0.45)));
  wordmark.style.setProperty('--b', `${(1 - t) * 18}px`);
  wordmark.style.setProperty('--o', (0.2 + 0.8 * t).toFixed(2));
};
if (!still) { addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true }); onScroll(); }

// the AI evaluator's eyes follow the cursor
const pupils = document.querySelector('.eyes .pup');
if (pupils && !still) addEventListener('pointermove', (e) => {
  const r = pupils.closest('svg').getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1;
  pupils.style.transform = `translate(${(dx / d * 1.6).toFixed(2)}px, ${(dy / d * 2.2).toFixed(2)}px)`;
}, { passive: true });

// supplier toast cycles through a bond's life
const toast = document.getElementById('toast');
const toastSteps = [['Bond locked', 'var(--cyan)'], ['Bid revealed · hash matches', 'var(--purple)'], ['Bond refunded at settle', 'var(--green)']];
let ts = 0;
if (!still) setInterval(() => {
  toast.classList.add('out');
  setTimeout(() => { ts = (ts + 1) % toastSteps.length; toast.querySelector('span').textContent = toastSteps[ts][0]; toast.querySelector('i').style.setProperty('--c', toastSteps[ts][1]); toast.classList.remove('out'); }, 350);
}, 2400);

// arc of the pieces Lelang is built with
const ARC = [
  ['Kite', 'The LelangEscrow contract holds bonds, enforces commit, reveal and settle, records evidence hashes and holds the balance until delivery.', 'bids can change after the deadline and the buyer can keep anyone\'s bond'],
  ['SERV', 'Prompt Guard and the verbatim manipulation check on every bid, the decision nodes, Kronos and Shadow Agent on the rationale, and the second reader.', 'an injected bid can steer the evaluator'],
  ['Dolphin', 'Reads every revealed bid (price, delivery, warranty, specs) after spotlighting; its output is schema-checked.', 'extraction runs on the same model that judges the bid'],
  ['Reppo', 'An independent panel verdict on every award, gating settlement; its rubric routes the repair loop.', 'the system grades its own decision'],
  ['x402', 'Buyers pay the tender fee from a browser wallet or an agent, with no gas: POST /api/rfqs answers 402 with terms.', 'opening a tender needs an account and an invoice'],
  ['MCP', 'npx -y lelang-mcp gives any agent tools to list, read, quote a bond, bid and reveal with its own key.', 'agents have to scrape a web form'],
];
const arcBtns = [...document.querySelectorAll('#arc button')];
let active = 0, arcTimer;
const showArc = (k) => {
  active = (k + ARC.length) % ARC.length;
  arcBtns.forEach((b, i) => {
    let d = i - active; if (d > ARC.length / 2) d -= ARC.length; if (d < -ARC.length / 2) d += ARC.length;
    b.style.setProperty('--a', `${d * 22}deg`);
    b.style.opacity = Math.abs(d) > 2 ? 0 : 1;
    b.setAttribute('aria-pressed', String(d === 0));
    b.setAttribute('aria-label', ARC[i][0]);
  });
  document.getElementById('arc-n').textContent = ARC[active][0];
  document.getElementById('arc-d').textContent = ARC[active][1];
  document.getElementById('arc-w').innerHTML = `<b>Remove it:</b> ${ARC[active][2]}.`;
};
const arcAuto = () => { clearInterval(arcTimer); if (!still) arcTimer = setInterval(() => showArc(active + 1), 3200); };
arcBtns.forEach((b, i) => b.addEventListener('click', () => { showArc(i); arcAuto(); }));
document.getElementById('arc').addEventListener('mouseenter', () => clearInterval(arcTimer));
document.getElementById('arc').addEventListener('mouseleave', arcAuto);
showArc(0); arcAuto();

// fanned failure cards
const cards = [...document.querySelectorAll('#fan article')];
let cur = 0;
const showFan = (k) => {
  cur = (k + cards.length) % cards.length;
  cards.forEach((c, i) => {
    let d = i - cur; if (d > cards.length / 2) d -= cards.length; if (d < -cards.length / 2) d += cards.length;
    c.dataset.p = Math.abs(d) > 1 ? 'far' : String(d);
    c.inert = d !== 0;
  });
  document.getElementById('fan-n').textContent = `${cur + 1} / ${cards.length}`;
};
document.getElementById('prev').addEventListener('click', () => showFan(cur - 1));
document.getElementById('next').addEventListener('click', () => showFan(cur + 1));
showFan(0);

// ---- live numbers ----
const set = (k, v) => { document.querySelector(`[data-n="${k}"]`).textContent = v; };

try {
  const d = await (await fetch('deployment.json')).json();
  const escrows = [d, ...(d.previous ?? [])].map((e) => ({ address: e.escrow.address.toLowerCase(), block: BigInt(e.escrow.block), abi: e.abi }));
  const seen = new Set();
  const events = escrows.flatMap((e) => e.abi).filter((f) => f.type === 'event' && !seen.has(JSON.stringify([f.name, f.inputs])) && seen.add(JSON.stringify([f.name, f.inputs])));
  const fromBlock = escrows.reduce((m, e) => (e.block < m ? e.block : m), escrows[0].block);
  const [raw, latest] = await Promise.all([client.getLogs({ address: escrows.map((e) => e.address), fromBlock }), client.getBlockNumber()]);
  const logs = parseEventLogs({ abi: events, logs: raw });
  const of = (name) => logs.filter((l) => l.eventName === name);

  set('tenders', of('TenderOpened').length);
  set('bids', of('Committed').length);
  set('slashes', of('BondSlashed').filter((l) => BigInt(l.args.evidenceHash) !== 0n).length);

  const v4 = escrows[0];
  const tokens = [...new Set(of('TenderOpened').filter((l) => l.address.toLowerCase() === v4.address).map((l) => l.args.token.toLowerCase()))];
  const parts = await Promise.all(tokens.map(async (t) => {
    const [amount, decimals, symbol] = await Promise.all([
      client.readContract({ address: v4.address, abi: v4.abi, functionName: 'bountyPool', args: [t] }),
      client.readContract({ address: t, abi: ERC20, functionName: 'decimals' }),
      client.readContract({ address: t, abi: ERC20, functionName: 'symbol' }),
    ]);
    return amount > 0n ? `${formatUnits(amount, decimals)} ${symbol}` : null;
  }));
  set('pool', parts.filter(Boolean).join(' + ') || '0');
  document.getElementById('asof').textContent = `Read from Kite testnet at block ${latest} by your browser, just now.`;
} catch (e) {
  for (const el of document.querySelectorAll('[data-n]')) if (el.textContent === '…') el.textContent = '—';
  document.getElementById('asof').textContent = `Couldn't reach Kite testnet (${e?.shortMessage ?? e?.message ?? e}). Nothing is filled in; try stats.html.`;
  document.getElementById('asof').className = 'warn';
}
window.__landingDone = true;
