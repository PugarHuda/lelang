// Approver console: anyone can read what the V4 escrow's approvers could act on; an approver connects a browser wallet
// and votes (overturnSlash / resolveDelivery). Every number comes from Kite testnet; the tender JSON only adds labels,
// evidence links and the advisory AI recommendation.
import { createPublicClient, http, defineChain, formatUnits, encodeFunctionData, encodeAbiParameters, keccak256 } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const KITE = { chainId: '0x940', chainName: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: ['https://rpc-testnet.gokite.ai'], blockExplorerUrls: ['https://testnet.kitescan.ai'] };
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 15_000, retryCount: 2 }) });
const ERC20 = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TX = (h, label = 'tx') => `<a href="https://testnet.kitescan.ai/tx/${esc(h)}" target="_blank" rel="noopener">${label}</a>`;
const ADDR = (a) => `<a href="https://testnet.kitescan.ai/address/${esc(a)}" target="_blank" rel="noopener"><code>${esc(a)}</code></a>`;
const utc = (s) => `${new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const status = (msg, cls = '') => { $('status').className = `status ${cls}`; $('status').innerHTML = msg; };

// Exactly the keys LelangEscrow._vote counts: keccak256(abi.encode("overturn", id, bidder)) / ("delivery", id, payWinner).
const overturnKey = (id, bidder) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'address' }], ['overturn', id, bidder]));
const deliveryKey = (id, pay) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'bool' }], ['delivery', id, pay]));

let D; // deployment
let S; // chain snapshot
let me = null, meApprover = false;

async function load() {
  const { address, block } = D.escrow, abi = D.abi;
  const ev = (eventName) => client.getContractEvents({ address, abi, eventName, fromBlock: BigInt(block) });
  const [pending, overturned, slashed, held, closed, voted, latest, quorum] = await Promise.all([
    ev('SlashPending'), ev('SlashOverturned'), ev('BondSlashed'), ev('BalanceHeld'), ev('DeliveryClosed'), ev('Voted'), client.getBlock(),
    client.readContract({ address, abi, functionName: 'quorum' }),
  ]);
  const approvers = await Promise.all((D.escrow.approvers ?? []).map(async (a) => [a, await client.readContract({ address, abi, functionName: 'isApprover', args: [a] })]));
  const key = (l) => `${l.args.id}:${l.args.bidder.toLowerCase()}`;
  const done = new Set([...overturned, ...slashed].map(key));
  const closedIds = new Set(closed.map((l) => String(l.args.id)));
  const slashes = pending.filter((l) => !done.has(key(l)));
  const deliveries = held.filter((l) => !closedIds.has(String(l.args.id)));
  // votes per action: the Voted event carries the running count; keep every voter too
  const tally = new Map();
  for (const l of voted) {
    const t = tally.get(l.args.action) ?? { n: 0n, voters: [] };
    t.n = l.args.votes > t.n ? l.args.votes : t.n;
    t.voters.push(l.args.approver.toLowerCase());
    tally.set(l.args.action, t);
  }
  // token units per tender
  const ids = [...new Set([...slashes, ...deliveries].map((l) => l.args.id))];
  const tokenOf = Object.fromEntries(await Promise.all(ids.map(async (id) => [String(id), (await client.readContract({ address, abi, functionName: 'tenders', args: [id] }))[1]])));
  const meta = Object.fromEntries(await Promise.all([...new Set(Object.values(tokenOf))].map(async (t) => [t, {
    decimals: await client.readContract({ address: t, abi: ERC20, functionName: 'decimals' }),
    symbol: await client.readContract({ address: t, abi: ERC20, functionName: 'symbol' }),
  }])));
  const fmt = (amount, id) => { const m = meta[tokenOf[String(id)]]; return `${formatUnits(amount, m?.decimals ?? 18)} ${m?.symbol ?? ''}`; };
  // our tender JSON for these escrow ids (only the ones that ran on this escrow)
  const rfqs = {};
  try {
    const index = await (await fetch('tenders.json')).json();
    await Promise.all(index.filter((t) => ids.some((id) => String(id) === String(t.chainId))).map(async (t) => {
      const r = await fetch(`tenders/${encodeURIComponent(t.id)}.json`);
      const rfq = r.ok ? await r.json() : null;
      if (rfq && String(rfq.escrow ?? '').toLowerCase() === address.toLowerCase()) rfqs[String(rfq.chainId)] = rfq;
    }));
  } catch { /* labels and evidence links are extras; the chain data stands alone */ }
  S = { quorum, approvers, slashes, deliveries, tally, fmt, rfqs, now: Number(latest.timestamp), block: latest.number };
}

const votesHtml = (action) => {
  const t = S.tally.get(action);
  const mine = me && t?.voters.includes(me.toLowerCase());
  return `<strong>${t ? t.n : 0n} of ${S.quorum}</strong> votes${t ? ` <span class="kv">(${t.voters.map((v) => `<code>${esc(v.slice(0, 8))}…</code>`).join(', ')})</span>` : ''}${mine ? ' <span class="ok">· you voted</span>' : ''}`;
};
const canVote = (action) => meApprover && !S.tally.get(action)?.voters.includes(me.toLowerCase());
const btn = (label, fn, args, action, enabled) => `<button type="button" data-fn="${fn}" data-args="${esc(JSON.stringify(args))}" ${enabled && canVote(action) ? '' : 'disabled'}>${label}</button>`;

function advisory(rfq) {
  const d = rfq?.deliveryDispute;
  if (!d) return '';
  const rec = typeof d.recommendation === 'string' ? d.recommendation : JSON.stringify(d.recommendation);
  const readers = Array.isArray(d.readers) ? d.readers.map((r) => (typeof r === 'string' ? r : (r.engine ? `${r.engine}: ${r.met === true ? 'met' : r.met === false ? 'not met' : 'no verified quote'}` : r.model ?? r.name ?? JSON.stringify(r)))).join(', ') : d.readers;
  return `<div class="advice"><strong>AI recommendation (advisory only, approvers decide):</strong> ${esc(rec)}
    <div class="kv">${readers ? `read by ${esc(readers)} · ` : ''}${d.evidenceHash ? `evidence <code>${esc(String(d.evidenceHash).slice(0, 18))}…</code>` : ''}${d.anchorTx ? ` · ${String(d.anchorTx).startsWith('http') ? `<a href="${esc(d.anchorTx)}" target="_blank" rel="noopener">anchor tx</a>` : TX(d.anchorTx, 'anchor tx')}` : ''}</div></div>`;
}

function render() {
  $('set').innerHTML = `<p>Quorum: <strong>${esc(S.quorum)}</strong> of ${S.approvers.length} listed approvers must vote for the same action.</p>
    ${S.approvers.map(([a, ok]) => `<div>${ADDR(a)} ${ok ? '<span class="ok">approver on-chain</span>' : '<span class="bad">not an approver on-chain</span>'}</div>`).join('')}
    <p class="kv">Escrow ${ADDR(D.escrow.address)} · block ${esc(S.block)}. The contract has no owner and no way to add approvers after deployment; the set above is fixed in its constructor.</p>`;

  $('slashes').innerHTML = S.slashes.length ? S.slashes.map((l) => {
    const { id, bidder, amount, evidenceHash, finalAt } = l.args;
    const open = Number(finalAt) > S.now;
    const rfq = S.rfqs[String(id)];
    const label = rfq?.settlement?.find((e) => e.event === 'SlashPending' && e.bidder?.toLowerCase() === bidder.toLowerCase())?.label;
    const proof = rfq && label ? `<a href="slash.html?t=${encodeURIComponent(rfq.id)}&b=${encodeURIComponent(label)}">evidence: the quote and the bid document →</a>` : TX(l.transactionHash, 'settle tx');
    const action = overturnKey(id, bidder);
    return `<div class="item"><div><strong>Tender #${esc(id)}</strong>${rfq ? ` · ${esc(rfq.title)}` : ''}${label ? ` · ${esc(label)}` : ''} · bond ${esc(S.fmt(amount, id))}</div>
      <div class="kv">Bidder ${ADDR(bidder)} · evidence hash <code>${esc(evidenceHash.slice(0, 18))}…</code> · ${open ? `<span class="warn">overturnable until ${esc(utc(finalAt))}</span>` : '<span class="kv">window over: anyone can finalize it, no vote possible</span>'}</div>
      <div>${proof}</div>
      <div>Overturn: ${votesHtml(action)}</div>
      ${btn('Vote to overturn', 'overturnSlash', [String(id), bidder], action, open)}</div>`;
  }).join('') : '<p class="kv">Nothing pending: no slash is waiting out its challenge window.</p>';

  $('deliveries').innerHTML = S.deliveries.length ? S.deliveries.map((l) => {
    const { id, winner, balance, deadline } = l.args;
    const due = Number(deadline) <= S.now;
    const rfq = S.rfqs[String(id)];
    const pay = deliveryKey(id, true), refund = deliveryKey(id, false);
    return `<div class="item"><div><strong>Tender #${esc(id)}</strong>${rfq ? ` · ${esc(rfq.title)}` : ''} · ${esc(S.fmt(balance, id))} held for ${ADDR(winner)}</div>
      <div class="kv">${due ? `<span class="warn">delivery deadline passed ${esc(utc(deadline))}; the buyer has not confirmed: approvers decide</span>` : `buyer can confirm until ${esc(utc(deadline))}; approvers can only vote after that`} · ${TX(l.transactionHash, 'settle tx')}${rfq ? ` · <a href="tenders/${encodeURIComponent(rfq.id)}.json">tender record</a>` : ''}</div>
      ${advisory(rfq)}
      <div>Pay winner: ${votesHtml(pay)} · Refund buyer: ${votesHtml(refund)}</div>
      ${btn('Vote: pay winner', 'resolveDelivery', [String(id), true], pay, due)}${btn('Vote: refund buyer', 'resolveDelivery', [String(id), false], refund, due)}</div>`;
  }).join('') : '<p class="kv">Nothing held: every balance was confirmed or resolved.</p>';
}

function renderMe() {
  if (!me) return;
  $('me').innerHTML = `Connected as ${ADDR(me)}: ${meApprover ? '<strong class="ok">you are an approver on this escrow</strong>. Your vote counts once per action.' : '<strong class="warn">not an approver on this escrow</strong>. You see everything read-only; the vote buttons stay disabled. Want to be one? Send us your address: the next escrow deployment can include it.'}`;
  $('connect').textContent = 'Reconnect';
}

async function setAccount(a) {
  me = a;
  meApprover = await client.readContract({ address: D.escrow.address, abi: D.abi, functionName: 'isApprover', args: [a] });
  renderMe();
  render();
}

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

$('connect').addEventListener('click', async () => {
  try { await setAccount(await wallet()); status(''); } catch (e) { status(esc(e.message), 'bad'); }
});

document.querySelector('main').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-fn]');
  if (!b || b.disabled) return;
  const fn = b.dataset.fn, [id, x] = JSON.parse(b.dataset.args);
  b.disabled = true;
  try {
    const from = await wallet();
    const data = encodeFunctionData({ abi: D.abi, functionName: fn, args: [BigInt(id), x] });
    const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to: D.escrow.address, data }] });
    status(`Vote sent: ${TX(hash)}. Waiting for Kite…`);
    const r = await client.waitForTransactionReceipt({ hash });
    status(r.status === 'success' ? `Vote recorded: ${TX(hash)}` : `Reverted: ${TX(hash)}`, r.status === 'success' ? 'ok' : 'bad');
    await load();
    await setAccount(from);
  } catch (err) {
    status(esc(err.shortMessage ?? err.message), 'bad');
    b.disabled = false;
  }
});

try {
  D = await (await fetch('deployment.json')).json();
  if (!D.abi.some((f) => f.name === 'resolveDelivery')) throw new Error('the current escrow is not V4');
  await load();
  render();
  // an already-connected wallet shows up without a prompt
  const [a] = window.ethereum ? await window.ethereum.request({ method: 'eth_accounts' }).catch(() => []) : [];
  if (a) await setAccount(a);
} catch (e) {
  for (const id of ['set', 'slashes', 'deliveries']) $(id).innerHTML = `<p class="warn">Couldn't read Kite testnet: ${esc(e.shortMessage ?? e.message)}</p>`;
} finally {
  window.__approverDone = true;
}
