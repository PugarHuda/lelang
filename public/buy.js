// "Open a tender" for a human buyer: pays the x402 tender fee with a browser wallet (EIP-3009, no gas for the payment)
// and gets the owner token that closes and evaluates the tender. Optional: prefill from an OCDS release.
// ?api=http://localhost:3000 points the page at a local server (tests); the hosted page's CSP only allows the public API
// Only a local server may replace the public API: a link with ?api=<someone else> must never get a payment signed.
const override = new URLSearchParams(location.search).get('api');
const API = override && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(override) ? override : 'https://lelang-6k05.onrender.com';
const KITE = { chainId: '0x940', chainName: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: ['https://rpc-testnet.gokite.ai'], blockExplorerUrls: ['https://testnet.kitescan.ai'] };
const PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const status = (msg, cls = '') => { $('status').className = `status ${cls}`; $('status').innerHTML = msg; };

// --- fee preview ------------------------------------------------------------------------------------------------
const fee = () => +(0.2 + 0.06 * Number($('bids').value || 0)).toFixed(6);
const showFee = () => { $('fee').textContent = fee(); };
$('bids').addEventListener('input', showFee);
showFee();

// --- OCDS import --------------------------------------------------------------------------------------------------
// Accepts a release, a release package or a record package; takes the latest release's tender.
function tenderFromOcds(json) {
  const releases = json.releases ?? (json.records ?? []).flatMap((r) => (r.compiledRelease ? [r.compiledRelease] : r.releases ?? []));
  const rel = (releases.length ? releases : [json]).filter((r) => r?.tender).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0];
  if (!rel) throw new Error('no release with a "tender" object found');
  const t = rel.tender;
  const period = t.contractPeriod ?? t.deliveryPeriod ?? {};
  const days = period.durationInDays ?? (period.startDate && period.endDate ? Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000) : null);
  return { ocid: rel.ocid, title: t.title ?? t.description?.slice(0, 200) ?? rel.ocid, amount: t.value?.amount ?? t.maxValue?.amount ?? null, currency: t.value?.currency ?? t.maxValue?.currency ?? null, days, items: (t.items ?? []).length };
}
$('file').addEventListener('change', async () => { const f = $('file').files[0]; if (f) $('ocds').value = await f.text(); });
$('import').addEventListener('click', () => {
  try {
    const t = tenderFromOcds(JSON.parse($('ocds').value));
    $('title').value = String(t.title).slice(0, 200);
    if (t.amount > 0) $('budget').value = t.amount;
    if (t.days > 0) $('days').value = t.days;
    for (const id of ['ram', 'sto', 'bat']) $(id).value = ''; // a generic tender has no laptop specs
    const notes = [`Imported ${esc(t.ocid ?? 'release')}${t.items ? ` (${t.items} item${t.items > 1 ? 's' : ''})` : ''}.`];
    if (t.currency && t.currency !== 'USD') notes.push(`<span class="warn">Budget is in ${esc(t.currency)}, not USD: check the cap before opening.</span>`);
    if (!(t.days > 0)) notes.push('<span class="warn">No contract period in the release: delivery limit left as is.</span>');
    $('importNote').innerHTML = notes.join(' ');
  } catch (e) {
    $('importNote').innerHTML = `<span class="bad">Could not read it: ${esc(e.message)}</span>`;
  }
});

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
$('claim').addEventListener('click', async () => {
  try {
    const from = await wallet();
    // the testnet PYUSD contract mints 10 PYUSD to whoever calls claim()
    const tx = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to: PYUSD, data: '0x4e71d92d' }] });
    status(`Claim sent: <a href="https://testnet.kitescan.ai/tx/${esc(tx)}">tx</a>`, 'ok');
  } catch (e) { status(esc(e.message), 'bad'); }
});

const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const hex32 = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
async function payHeader(from, req) {
  const authorization = { from, to: req.payTo, value: req.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds), nonce: hex32() };
  const typed = {
    domain: { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(':')[1]), verifyingContract: req.asset },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };
  const signature = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] });
  return b64({ x402Version: 2, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepted: req, payload: { signature, authorization } });
}

// --- open ---------------------------------------------------------------------------------------------------------
function spec() {
  const num = (id) => Number($(id).value);
  const minSpecs = Object.fromEntries([['ram_gb', 'ram'], ['storage_gb', 'sto'], ['battery_hours', 'bat']].filter(([, id]) => $(id).value !== '').map(([k, id]) => [k, num(id)]));
  const s = { title: $('title').value.trim(), budgetCapUsd: num('budget'), maxDeliveryDays: num('days'), maxBids: num('bids'), bondPie: String(num('bond')), weights: { price: num('wp'), warranty: num('ww'), delivery: num('wd'), ...(num('wq') > 0 && { quality: num('wq') }) }, minSpecs };
  if (s.weights.quality) s.qualitative = { criterion: $('crit').value.trim() };
  if (s.weights.quality && !s.qualitative.criterion) throw new Error('a quality weight needs a criterion');
  if (!s.title) throw new Error('title required');
  if (Math.abs(s.weights.price + s.weights.warranty + s.weights.delivery + (s.weights.quality ?? 0) - 1) > 1e-6) throw new Error('weights must sum to 1');
  if (!Number.isInteger(s.maxBids) || s.maxBids < 1 || s.maxBids > 20) throw new Error('bid slots must be 1 to 20');
  return s;
}
$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('open').disabled = true;
  try {
    const body = JSON.stringify(spec());
    const from = await wallet();
    status('Asking Lelang for its payment terms…');
    const first = await fetch(`${API}/api/rfqs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (first.status !== 402) throw new Error(`expected a payment request, got ${first.status}: ${(await first.json().catch(() => ({}))).error ?? ''}`);
    const req = (await first.json()).accepts.find((a) => a.network === 'eip155:2368' && a.extra?.name === 'PYUSD');
    if (!req) throw new Error('Lelang did not offer PYUSD on Kite testnet');
    status(`Sign the payment of ${fee()} PYUSD in your wallet (an authorization, not a transaction)…`);
    const header = await payHeader(from, req);
    status('Paying and opening the escrow tender on Kite…');
    const res = await fetch(`${API}/api/rfqs`, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': header }, body });
    const out = await res.json();
    if (res.status !== 201) throw new Error(out.error ?? `status ${res.status}`);
    remember({ id: out.id, token: out.ownerToken, title: JSON.parse(body).title, payTx: out.payment?.tx, at: new Date().toISOString() });
    status(`Opened <strong>${esc(out.id)}</strong> (escrow tender #${esc(out.chainId)}). Fee paid: <a href="https://testnet.kitescan.ai/tx/${esc(out.payment?.tx)}">tx</a>.`, 'ok');
    render();
  } catch (e) {
    status(esc(e.message ?? e), 'bad');
  } finally {
    $('open').disabled = false;
  }
});

// --- your tenders (owner tokens stay in this browser) -------------------------------------------------------------
const KEY = 'lelang.mine';
const mine = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const remember = (t) => { try { localStorage.setItem(KEY, JSON.stringify([t, ...mine()].slice(0, 20))); } catch {} };
async function act(id, token, action) {
  const res = await fetch(`${API}/api/rfqs/${id}/${action}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error ?? res.status);
  return out;
}
async function render() {
  const list = mine();
  if (!list.length) return;
  $('mine').innerHTML = list.map((t) => `<div data-id="${esc(t.id)}" style="padding:10px 0;border-bottom:1px solid var(--line)">
    <strong>${esc(t.title)}</strong> <span class="kv">${esc(t.id)}</span>
    <p class="kv" data-phase>loading…</p>
    <button class="ghost" data-a="close" type="button">Close commits</button>
    <button class="ghost" data-a="evaluate" type="button">Evaluate</button>
    <details><summary class="kv">How supplier agents bid on it</summary>
      <pre>npx -y lelang-mcp   # MCP tools: list, read, bond quote, bid, reveal (tender ${esc(t.id)})
node scripts/supplier-agent.js ${esc(API)} ${esc(t.id)} bid.txt   # or plain HTTP, own key in SUPPLIER_PRIVATE_KEY</pre>
      <p class="kv">Owner token (keep it private): <code>${esc(t.token)}</code></p>
    </details>
  </div>`).join('');
  for (const el of $('mine').querySelectorAll('[data-id]')) {
    const t = list.find((x) => x.id === el.dataset.id);
    const phase = el.querySelector('[data-phase]');
    const refresh = async () => {
      try {
        const r = await (await fetch(`${API}/api/rfqs/${t.id}`)).json();
        const last = r.events?.at(-1);
        phase.innerHTML = `Phase <strong>${esc(r.phase)}</strong> · ${Object.keys(r.bids ?? {}).length} sealed bid(s)${last ? ` · ${esc(last.msg)}` : ''}`;
      } catch { phase.textContent = 'API not reachable (it may be waking up)'; }
    };
    for (const b of el.querySelectorAll('[data-a]')) b.addEventListener('click', async () => {
      b.disabled = true;
      try { await act(t.id, t.token, b.dataset.a); } catch (e) { phase.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
      b.disabled = false;
      refresh();
    });
    refresh();
  }
}
render();
