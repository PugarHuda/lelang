// "Clean win" certificate for one tender's winner, re-verified in the visitor's browser against the Kite RPC.
// Mirror of slash.js. Only the Reppo audit comes from the published JSON (it is off-chain); everything else is read from Kite.
import { esc } from './verify.js';
import { createPublicClient, http, defineChain, parseEventLogs, parseAbi, decodeFunctionData, keccak256, toHex, encodeAbiParameters, parseAbiParameters, verifyMessage, isAddressEqual } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

// ponytail: verify.js keeps its client and ABI lookup private, so the same few lines live here too.
const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 15_000, retryCount: 2 }) });
const TX = 'https://testnet.kitescan.ai/tx/';
const erc20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const view = document.querySelector('#view');
const txHash = (s) => String(s ?? '').split('/tx/').pop();
const txLink = (h, text = 'tx') => (h ? `<a href="${TX}${esc(h)}" target="_blank" rel="noopener">${esc(text)} ${esc(h.slice(0, 10))}…</a>` : '');

// Same formula as LelangEscrow.commitmentOf and src/commitment.js commitHash. V1-V4 escrows hash (docHash, salt, bidder, id);
// a V5 escrow also binds its own address and the chain id (audit F5), so pass `escrow` for those.
const commitmentOf = (docHash, salt, bidder, id, escrow) => keccak256(escrow
  ? encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256, address, uint256'), [docHash, salt, bidder, BigInt(id), escrow, BigInt(kite.id)])
  : encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256'), [docHash, salt, bidder, BigInt(id)]));

// The award passed Reppo either outright ("ship"), or it was routed to review and a named approver released it, signed.
async function auditCheck(rfq) {
  const r = rfq.reppo, h = rfq.humanApproval;
  if (!r?.score && r?.score !== 0) return { ok: false, text: 'No Reppo audit in the published record.' };
  let ok = r.status === 'COMPLETED' && r.route === 'ship';
  let text = `Reppo audit ${esc(r.status)}: score <strong>${esc(r.score)}/100</strong>, route <strong>${esc(r.route)}</strong>.`;
  if (r.status === 'COMPLETED' && r.route === 'review') {
    // bound to this tender and winner exactly (approvalMessage in src/lelang.js), so a release signed for another tender can't be pasted in
    const want = `LELANG approve ${rfq.id} award ${rfq.award.winner}`;
    const signed = (h?.message === want || h?.message?.startsWith(`${want} note: `)) && await verifyMessage({ address: h.approver, message: h.message, signature: h.signature }).catch(() => false);
    ok = Boolean(signed);
    text += signed ? ` Routed to human review, then released by approver <code>${esc(h.approver.slice(0, 10))}…</code> (its signature over "${esc(h.message)}" verified here).` : ' Routed to human review with no valid signed release.';
  }
  return { ok, text: `${text} <span class="kv">From the published record (the audit itself is off-chain).</span>` };
}

async function verify(rfq, bid) {
  const d = await fetch('deployment.json').then((r) => r.json());
  // Only Lelang's own escrows (V1-V4): a record naming any other contract could point at a look-alike that emits anything.
  const known = [d, ...(d.previous ?? [])].find((p) => isAddressEqual(p.escrow.address, rfq.escrow));
  if (!known) throw new Error(`escrow ${rfq.escrow} is not a Lelang escrow listed in deployment.json`);
  const abi = known.abi;
  const id = BigInt(rfq.chainId);
  const settleTx = txHash((rfq.settlement.find((s) => s.event === 'Awarded') ?? rfq.settlement.find((s) => s.tx)).tx);
  const [revealTx, revealRcpt, stored, rcpt, block, tender] = await Promise.all([
    client.getTransaction({ hash: bid.revealTx }),
    client.getTransactionReceipt({ hash: bid.revealTx }),
    client.readContract({ address: rfq.escrow, abi, functionName: 'bids', args: [id, bid.supplier] }),
    client.getTransactionReceipt({ hash: settleTx }),
    client.getBlockNumber(),
    client.readContract({ address: rfq.escrow, abi, functionName: 'tenders', args: [id] }),
  ]);
  const rows = [];

  // 1. Commit matches reveal: the reveal tx calldata carries (id, docHash, salt); recompute the commitment.
  const { functionName, args } = decodeFunctionData({ abi, data: revealTx.input });
  const [rid, docHash, salt] = args;
  // ponytail: no version flag in the published JSON, so try the V1-V4 form, then the V5 form bound to the escrow revealed to
  let computed = commitmentOf(docHash, salt, revealTx.from, rid);
  if (computed !== stored[0] && revealTx.to) computed = commitmentOf(docHash, salt, revealTx.from, rid, revealTx.to);
  const docComputed = keccak256(toHex(bid.doc ?? ''));
  rows.push({
    ok: functionName === 'reveal' && rid === id && revealRcpt.status === 'success' && isAddressEqual(revealTx.to, rfq.escrow)
      && isAddressEqual(revealTx.from, bid.supplier) && computed === stored[0] && docHash === stored[1] && docComputed === docHash && stored[2] === true,
    title: 'Sealed commit matches the reveal',
    text: `keccak256(abi.encode(docHash, salt, bidder, ${esc(id)})) from the reveal calldata = <code>${esc(computed.slice(0, 18))}…</code>; commitment in escrow storage <code>${esc(stored[0].slice(0, 18))}…</code>. keccak256 of the published winning document = <code>${esc(docComputed.slice(0, 18))}…</code>, revealed docHash <code>${esc(docHash.slice(0, 18))}…</code>.`,
    tx: bid.revealTx,
  });

  // 2. Not slashed: settle refunded the winner's bond and no slash event for it exists on this tender, ever.
  // only events the escrow itself emitted: the tender token runs inside settle and could emit look-alike events
  const logs = parseEventLogs({ abi, logs: rcpt.logs.filter((l) => isAddressEqual(l.address, rfq.escrow)) }).filter((l) => l.args.id === id);
  const mine = (l) => isAddressEqual(l.args.bidder ?? l.args.winner ?? '0x0000000000000000000000000000000000000000', bid.supplier);
  const slashNames = ['BondSlashed', 'SlashPending'].filter((n) => abi.some((x) => x.type === 'event' && x.name === n));
  const later = (await Promise.all(slashNames.map((eventName) => client.getContractEvents({ address: rfq.escrow, abi, eventName, args: { id, bidder: bid.supplier }, fromBlock: rcpt.blockNumber })))).flat();
  const refunded = logs.some((l) => l.eventName === 'BondRefunded' && mine(l));
  rows.push({
    ok: refunded && later.length === 0 && !bid.slash,
    title: 'Winning bid was not slashed',
    text: refunded ? `The settle tx refunded its bond (BondRefunded), and the escrow has ${later.length ? `<strong>${later.length} slash event(s)</strong>` : 'no BondSlashed or SlashPending event'} for this bidder on tender #${esc(id)}.` : 'No BondRefunded event for the winner in the settle tx.',
    tx: settleTx,
  });

  // 3. Settle paid the winner: Awarded(winner) from the escrow, and the down payment really moved to the winner.
  const award = logs.find((l) => l.eventName === 'Awarded');
  const down = award?.args.downPayment ?? 0n;
  // the tender's own token, from the buyer (settle's sender) to the winner: a bond refund (from the escrow) of the same size doesn't count
  const paid = parseEventLogs({ abi: erc20, logs: rcpt.logs.filter((l) => isAddressEqual(l.address, tender[1])) })
    .some((l) => isAddressEqual(l.args.from, rcpt.from) && isAddressEqual(l.args.to, bid.supplier) && l.args.value === down);
  rows.push({
    ok: rcpt.status === 'success' && isAddressEqual(rcpt.to, rfq.escrow) && Boolean(award) && isAddressEqual(award.args.winner, bid.supplier) && (down === 0n || paid),
    title: 'Settle transaction paid the winner',
    text: award ? `Awarded event names <code>${esc(award.args.winner)}</code>; ${down ? `token Transfer of the down payment (${esc(down)} base units) to the winner ${paid ? 'is in the same tx' : 'is <strong>missing</strong>'}` : 'no down payment'} · block ${esc(rcpt.blockNumber)}.` : 'No Awarded event in the settle tx.',
    tx: settleTx,
  });

  rows.push({ ...(await auditCheck(rfq)), title: 'Award passed the Reppo audit', tx: null });
  return { rows, block };
}

function share(rfq, bid) {
  const text = `${bid.label} won "${rfq.title}" cleanly on Lelang: sealed bid, matching reveal, never slashed, paid on Kite testnet. Verify it in your browser:`;
  return `<a class="cta" href="https://x.com/intent/post?text=${encodeURIComponent(text)}&amp;url=${encodeURIComponent(location.href)}" target="_blank" rel="noopener">Share on X</a>`;
}

try {
  const t = new URLSearchParams(location.search).get('t') ?? '';
  if (!/^rfq-[\w-]+$/.test(t)) throw new Error('No tender given. Open this page as win.html?t=rfq-…');
  const res = await fetch(`tenders/${encodeURIComponent(t)}.json`);
  if (!res.ok) throw new Error(`Tender ${t} is not published.`);
  const rfq = await res.json();
  const bid = rfq.bids?.[rfq.award?.winner];
  const settled = rfq.phase === 'settled' && (rfq.settlement ?? []).some((s) => s.event === 'Awarded' && s.tx);
  if (!settled || rfq.award?.decision !== 'award') throw new Error(`Tender ${t} has no settled award yet, so there is no winner to certify.`);
  if (!bid?.supplier || !bid.revealTx) throw new Error(`The published winner of ${t} has no revealed bid on record, so this certificate cannot be issued.`);
  document.title = `${bid.label} won · clean win certificate · Lelang`;
  view.innerHTML = `
    <section class="cert">
      <p class="kv">Clean win certificate · escrow tender #${esc(rfq.chainId)} on Kite testnet</p>
      <h1>${esc(bid.label)} won this tender<span id="clean">: checking…</span></h1>
      <p class="lede">${esc(rfq.title)}</p>
      <p class="kv">Winner <code>${esc(bid.supplier)}</code> · score ${esc(rfq.award.scores?.[bid.label] ?? '–')} · <a href="index.html">all tenders</a></p>
      <p id="verdict" class="verdict">Checking Kite testnet…</p>
      <p>${share(rfq, bid)}</p>
    </section>
    <h2>Checked in your browser</h2>
    <div class="card"><p class="kv">Your browser reads the reveal and settle transactions and the escrow's storage directly from rpc-testnet.gokite.ai. Nothing on our server is trusted, except the Reppo audit, which is off-chain.</p>
      <ol id="checks"></ol><button id="go" class="ghost">Run again</button></div>`;
  const go = document.querySelector('#go');
  const run = async () => {
    go.disabled = true;
    const v = document.querySelector('#verdict'), list = document.querySelector('#checks');
    v.className = 'verdict'; v.textContent = 'Checking Kite testnet…'; list.innerHTML = ''; document.querySelector('#clean').textContent = ': checking…';
    try {
      const { rows, block } = await verify(rfq, bid);
      const all = rows.every((r) => r.ok);
      document.querySelector('.cert').classList.toggle('ok', all);
      document.querySelector('#clean').textContent = all ? (rfq.humanApproval ? ' cleanly, released by a named approver after escalation' : ' cleanly') : ', but the clean-win checks did not all pass';
      v.className = `verdict ${all ? 'ok' : 'bad'}`;
      v.innerHTML = all ? `✓ Verified clean win · ${rows.length}/${rows.length} checks pass at block ${esc(block)}` : `✗ Not a verified clean win: ${rows.filter((r) => !r.ok).length} check(s) failed`;
      list.innerHTML = rows.map((r) => `<li><span class="t"></span><span class="s ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'PASS' : 'FAIL'}</span><span><strong>${esc(r.title)}.</strong> ${r.text} ${txLink(r.tx)}</span></li>`).join('');
    } catch (e) {
      v.className = 'verdict bad';
      v.textContent = `Couldn't verify against Kite testnet (${e.shortMessage ?? e.message}). Nothing is certified until it does; try again.`;
    } finally {
      go.disabled = false;
    }
  };
  go.onclick = run;
  run();
} catch (e) {
  view.innerHTML = `<p class="warn">${esc(e.message)}</p><p class="kv"><a href="index.html">Browse settled tenders</a></p>`;
}
