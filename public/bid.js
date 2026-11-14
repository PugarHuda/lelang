// "Bid on a tender" for a human supplier: the same sealed-bid protocol as scripts/supplier-agent.js and the MCP server,
// with a browser wallet. Commitment = keccak256(abi.encode(docHash, salt, bidder, escrow tender id)), the bond is locked
// in the escrow from the supplier's own wallet, and the salt stays in this browser (and in a receipt file) until reveal.
// ?api=http://localhost:3000 points the page at a local server (tests); the hosted page's CSP only allows the public API.
// Only a local server may replace the public API: a link with ?api=<someone else> must never get a bond locked.
import { createPublicClient, http, defineChain, keccak256, toHex, encodeAbiParameters, parseAbiParameters, encodeFunctionData, parseUnits, erc20Abi } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

const override = new URLSearchParams(location.search).get('api');
const API = override && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override) ? override : 'https://lelang-6k05.onrender.com';
const KITE = { chainId: '0x940', chainName: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: ['https://rpc-testnet.gokite.ai'], blockExplorerUrls: ['https://testnet.kitescan.ai'] };
const pub = createPublicClient({ chain: defineChain({ id: 2368, name: KITE.chainName, nativeCurrency: KITE.nativeCurrency, rpcUrls: { default: { http: KITE.rpcUrls } } }), transport: http() });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const status = (msg, cls = '') => { $('status').className = `status ${cls}`; $('status').innerHTML = msg; };
const txLink = (h) => (h ? `<a href="https://testnet.kitescan.ai/tx/${esc(h)}">${esc(h.slice(0, 10))}…</a>` : '');
const hex32 = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
// same as src/commitment.js (and LelangEscrow.commitmentOf)
const docHashOf = (doc) => keccak256(toHex(doc));
const commitHash = (doc, salt, bidder, chainId) => keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256'), [docHashOf(doc), salt, bidder, BigInt(chainId)]));

const api = async (path, body) => {
  const res = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `status ${res.status}`);
  return out;
};
const ESCROW = await fetch('deployment.json').then((r) => r.json()).then((d) => ({ address: d.escrow.address, abi: d.abi }));

// --- wallet -------------------------------------------------------------------------------------------------------
async function wallet() {
  if (!window.ethereum) throw new Error('no browser wallet found (install MetaMask or a similar EVM wallet)');
  const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: KITE.chainId }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [KITE] });
  }
  return from;
}
async function send(from, to, data) {
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

// --- your bids: salts live here (and in the receipt file); a key per tender and address ---------------------------
const KEY = 'lelang.bids';
let mem = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } })();
const keep = (k, v) => { mem = { ...mem, [k]: { ...mem[k], ...v } }; try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch {} return mem[k]; };
function download(b) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ lelang: 'sealed bid receipt: keep it, the salt is needed to reveal', ...b }, null, 2)], { type: 'application/json' }));
  a.download = `lelang-bid-${b.tender}-${b.address.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('restore').addEventListener('change', async () => {
  try {
    const b = JSON.parse(await $('restore').files[0].text());
    if (!/^[\w-]+$/.test(b.tender ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(b.address ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(b.salt ?? '') || typeof b.doc !== 'string') throw new Error('not a Lelang bid receipt');
    keep(`${b.tender}:${b.address.toLowerCase()}`, { tender: b.tender, address: b.address, doc: b.doc, salt: b.salt, api: API, ...(/^0x[0-9a-fA-F]{64}$/.test(b.bondTx ?? '') && { bondTx: b.bondTx }) });
    renderMine();
  } catch (e) { status(`Could not restore: ${esc(e.message)}`, 'bad'); }
});

// --- open tenders -------------------------------------------------------------------------------------------------
let tenders = [];
const terms = (r) => [
  `Budget cap <strong>$${esc(r.budgetCapUsd)}</strong>`, `max delivery <strong>${esc(r.maxDeliveryDays)} days</strong>`, `bond <strong>${esc(r.bondPie)}</strong>`,
  `weights ${Object.entries(r.weights ?? {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')}`,
  `min specs ${Object.entries(r.minSpecs ?? {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ') || 'none'}`,
  `${Object.keys(r.bids ?? {}).length}/${esc(r.maxBids ?? 100)} bids`,
].join(' · ');
async function loadTenders() {
  try {
    const { rfqs } = await api('/api/rfqs');
    // ponytail: newest 15 open tenders only; paginate if there are ever more
    tenders = await Promise.all(rfqs.filter((r) => r.phase === 'commit').slice(0, 15).map((r) => api(`/api/rfqs/${encodeURIComponent(r.id)}`)));
  } catch (e) {
    $('tenders').innerHTML = `<p class="bad" style="margin:0">API not reachable (it may be waking up): ${esc(e.message)}</p>`;
    return;
  }
  $('tenders').innerHTML = tenders.length ? tenders.map((r) => `<div class="tender">
    <strong>${esc(r.title)}</strong> <span class="kv">${esc(r.id)}${r.chainId ? ` · escrow tender #${esc(r.chainId)}` : ''}</span>
    <p class="kv" style="margin:4px 0 0">${terms(r)}</p>
    ${r.qualitative?.criterion ? `<p class="kv" style="margin:4px 0 0">Quality criterion: “${esc(r.qualitative.criterion)}”</p>` : ''}
  </div>`).join('') : '<p class="kv" style="margin:0">No tender is taking bids right now. <a href="buy.html">Open one</a>.</p>';
  $('tender').innerHTML = tenders.map((r) => `<option value="${esc(r.id)}">${esc(r.title)} (${esc(r.id)})</option>`).join('');
}

// --- quote and seal -----------------------------------------------------------------------------------------------
let me = null;
async function quote() {
  const id = $('tender').value;
  if (!me || !id) return;
  try {
    const q = await api(`/api/rfqs/${encodeURIComponent(id)}/bond?supplier=${me}`);
    $('quote').innerHTML = `Wallet <code>${esc(me)}</code>. Bond to lock: <strong>${esc(q.required)}</strong> (tender base ${esc(q.base)}). The bond doubles for every proven slash on record for your address, up to 16×; you have ${esc(q.provenSlashes?.length ?? 0)}. It comes back when your revealed bid complies.`;
    $('seal').disabled = false;
  } catch (e) { $('quote').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
$('tender').addEventListener('change', quote);
$('connect').addEventListener('click', async () => {
  try { me = await wallet(); await quote(); } catch (e) { status(esc(e.message ?? e), 'bad'); }
});

$('seal').addEventListener('click', async () => {
  $('seal').disabled = true;
  try {
    const r = tenders.find((t) => t.id === $('tender').value);
    const doc = $('doc').value;
    if (!r) throw new Error('pick a tender');
    if (!doc.trim()) throw new Error('write your bid document first');
    if (!r.chainId || String(r.escrow).toLowerCase() !== ESCROW.address.toLowerCase()) throw new Error('this tender is not on the current escrow contract');
    me = await wallet();
    const k = `${r.id}:${me.toLowerCase()}`;
    const prev = mem[k];
    if (prev?.label) throw new Error(`you already bid in this tender as ${prev.label}`);
    // a retry after a partial failure must not lock a second bond or swap the document under a sealed commitment
    if (prev?.bondTx && prev.doc !== doc) throw new Error('a bond is already locked for a different document in this tender: put that exact document back (see your receipt)');
    // the salt is stored, and the receipt downloaded, before anything is sent
    const b = keep(k, { tender: r.id, chainId: r.chainId, address: me, doc, salt: prev?.salt ?? hex32(), api: API });
    download(b);
    const hash = commitHash(doc, b.salt, me, r.chainId);
    if (!b.bondTx) {
      // token and minimum bond come from the escrow itself; the API's quote may only raise it (at most 16×)
      const [, token, bond] = await pub.readContract({ ...ESCROW, functionName: 'tenders', args: [BigInt(r.chainId)] });
      const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
      const q = await api(`/api/rfqs/${encodeURIComponent(r.id)}/bond?supplier=${me}`);
      const posted = parseUnits(String(q.required), decimals);
      if (posted < bond || posted > bond * 16n) throw new Error(`the server quotes a bond of ${q.required}, outside this tender's range; not locking`);
      status(`1/3 · Approve ${esc(q.required)} of the tender token for the escrow in your wallet…`);
      await send(me, token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ESCROW.address, posted] }));
      status('2/3 · Lock the bond with your sealed commitment…');
      keep(k, { hash, bond: q.required, bondTx: await send(me, ESCROW.address, encodeFunctionData({ abi: ESCROW.abi, functionName: 'commit', args: [BigInt(r.chainId), hash, posted] })) });
    }
    status('3/3 · Registering the commitment with Lelang…');
    const { label } = await api(`/api/rfqs/${encodeURIComponent(r.id)}/commit`, { supplier: me, hash, bondTx: mem[k].bondTx });
    keep(k, { label });
    status(`Sealed as <strong>${esc(label)}</strong>. Bond locked: ${txLink(mem[k].bondTx)}. Your receipt was downloaded; come back to reveal when the buyer closes commits.`, 'ok');
    renderMine();
  } catch (e) {
    status(esc(e.shortMessage ?? e.message ?? e), 'bad');
  } finally {
    $('seal').disabled = false;
  }
});

// --- reveal and results -------------------------------------------------------------------------------------------
async function reveal(k) {
  const b = mem[k];
  const r = await api(`/api/rfqs/${encodeURIComponent(b.tender)}`);
  if (r.phase !== 'reveal') throw new Error(`tender is in ${r.phase}; reveal opens when the buyer closes commits`);
  const from = await wallet();
  if (from.toLowerCase() !== b.address.toLowerCase()) throw new Error(`switch your wallet to ${b.address}, the address that sealed this bid`);
  if (!b.revealTx) keep(k, { revealTx: await send(from, ESCROW.address, encodeFunctionData({ abi: ESCROW.abi, functionName: 'reveal', args: [BigInt(r.chainId), docHashOf(b.doc), b.salt] })) });
  await api(`/api/rfqs/${encodeURIComponent(b.tender)}/reveal`, { supplier: from, doc: b.doc, salt: b.salt, revealTx: mem[k].revealTx });
}
async function renderMine() {
  const list = Object.entries(mem).filter(([, b]) => b.api === API);
  if (!list.length) { $('mine').innerHTML = '<p class="kv">Bids you seal from this browser appear here.</p>'; return; }
  const rows = await Promise.all(list.map(async ([k, b]) => {
    const r = await api(`/api/rfqs/${encodeURIComponent(b.tender)}`).catch(() => null);
    const bid = Object.values(r?.bids ?? {}).find((x) => x.supplier.toLowerCase() === b.address.toLowerCase());
    const result = !r ? 'API not reachable' : !bid ? 'not registered with Lelang yet (seal again to retry)'
      : [`${bid.revealOk ? '<span class="ok">revealed, matches the commitment</span>' : 'sealed'}`,
        bid.slash && '<span class="bad">bond slashed</span>', bid.disqualified && `<span class="warn">disqualified: ${esc(bid.disqualified)}</span>`,
        r.award?.winner && (r.award.winner === bid.label ? '<span class="ok">you won</span>' : `winner ${esc(r.award.winner)}`)].filter(Boolean).join(' · ');
    return `<div class="tender" data-k="${esc(k)}">
      <strong>${esc(bid?.label ?? b.label ?? 'your bid')}</strong> in <span class="kv">${esc(b.tender)}</span> from <code>${esc(b.address.slice(0, 10))}…</code>
      <p class="kv" style="margin:4px 0 0">Phase <strong data-phase>${esc(r?.phase ?? '?')}</strong> · ${result}${b.bondTx ? ` · bond ${txLink(b.bondTx)}` : ''}${b.revealTx ? ` · reveal ${txLink(b.revealTx)}` : ''}</p>
      ${r?.phase === 'reveal' && bid && !bid.revealOk ? '<button data-a="reveal" type="button">Reveal</button>' : ''}
      <button class="ghost" data-a="receipt" type="button">Download receipt</button>
      <button class="ghost" data-a="refresh" type="button">Refresh</button>
    </div>`;
  }));
  $('mine').innerHTML = rows.join('');
  for (const el of $('mine').querySelectorAll('[data-k]')) for (const btn of el.querySelectorAll('[data-a]')) btn.addEventListener('click', async () => {
    const k = el.dataset.k;
    if (btn.dataset.a === 'receipt') return download(mem[k]);
    btn.disabled = true;
    try {
      if (btn.dataset.a === 'reveal') { status('Reveal your bid in your wallet…'); await reveal(k); status(`Revealed: ${txLink(mem[k].revealTx)}`, 'ok'); }
    } catch (e) { status(esc(e.shortMessage ?? e.message ?? e), 'bad'); }
    renderMine();
  });
}
loadTenders();
renderMine();
