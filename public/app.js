// Dashboard (classic script, so render() and approveHeld() are globals the proof module can reach).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
let current = null;
let lastBody = '';

function bidCard(b, rfq) {
  const won = rfq.award?.winner === b.label && rfq.award?.decision === 'award';
  const status = b.appeal?.outcome === 'overturned' ? '<span class="st warn">Slash overturned on appeal · bond refunded</span>'
    : b.disqualified ? `<span class="st bad">Disqualified${b.slash ? ' · bond slashed' : ''}</span>`
    : won ? '<span class="st ok">Winner</span>' : b.terms ? '<span class="st mute">Eligible</span>' : '<span class="st mute">Sealed</span>';
  const t = b.terms;
  const p = rfq.award?.probabilities?.[b.label];
  return `<div class="card bid ${won ? 'win' : ''}">
    <h3>${esc(b.label)}</h3>${status}
    ${t ? `<div class="kv">$${esc(t.total_usd)} · ${esc(t.delivery_days)}d · ${esc(t.warranty_months)}mo<br>${esc(t.specs?.ram_gb)}GB RAM · ${esc(t.specs?.storage_gb)}GB · ${esc(t.specs?.battery_hours)}h</div>` : ''}
    ${b.disqualified ? `<div class="kv bad">${esc(b.disqualified)}</div>` : ''}
    ${b.slash && staticMode && rfq.phase === 'settled' ? `<div class="kv"><a href="slash.html?t=${encodeURIComponent(rfq.id)}&b=${encodeURIComponent(b.label)}">proof page: verify this slash yourself →</a></div>` : ''}
    ${b.evidence ? `<details class="kv"><summary>evidence</summary><pre>${esc(b.evidence)}</pre>${b.evidenceHash ? `keccak256 on-chain: <code>${esc(b.evidenceHash.slice(0, 18))}…</code>` : ''}</details>` : ''}
    ${b.review ? `<div class="kv warn">review: ${esc(b.review)}</div>` : ''}
    ${p != null ? `<div class="kv">p=${p.toFixed(2)}</div><div class="bar"><i style="width:${p * 100}%"></i></div>` : ''}
    <div class="kv">${b.bondTx ? `<a href="https://testnet.kitescan.ai/tx/${esc(b.bondTx)}" target="_blank">bond tx</a>` : ''}
      ${b.revealTx ? ` · <a href="https://testnet.kitescan.ai/tx/${esc(b.revealTx)}" target="_blank">reveal tx</a>` : ''}</div>
  </div>`;
}

function render(rfq) {
  const bids = Object.values(rfq.bids);
  const r = rfq.reppo;
  $('#view').innerHTML = `
    <h2>Tender · ${esc(rfq.phase)}</h2>
    <div class="card"><strong>${esc(rfq.title)}</strong>
      <div class="kv">Cap $${rfq.budgetCapUsd} · max ${rfq.maxDeliveryDays} days · min ${esc(JSON.stringify(rfq.minSpecs))} · weights ${esc(JSON.stringify(rfq.weights))}
      ${rfq.anchorTx ? ` · <a href="https://testnet.kitescan.ai/tx/${esc(rfq.anchorTx)}" target="_blank">${rfq.chainId ? 'commits closed on-chain' : 'sealed commits on Kite'}</a>` : ''}
      ${rfq.escrow ? ` · bonds held by <a href="https://testnet.kitescan.ai/address/${esc(rfq.escrow)}" target="_blank">escrow contract</a> (tender #${esc(rfq.chainId)})` : ''}
      · <a id="ocds" href="${staticMode ? `tenders/${esc(rfq.id)}.ocds.json` : `/api/rfqs/${esc(rfq.id)}/ocds`}" target="_blank">export OCDS 1.1</a></div></div>
    <h2>Bids</h2><div class="grid">${bids.map((b) => bidCard(b, rfq)).join('')}</div>
    ${rfq.award ? `<h2>Decision</h2><div class="card">
      <strong class="${rfq.award.decision === 'award' ? 'ok' : 'warn'}">${esc(rfq.award.decision?.toUpperCase())} ${esc(rfq.award.winner ?? '')}</strong>
      <span class="kv"> · ${esc(rfq.award.engine)} · confidence ${rfq.award.confidence?.toFixed?.(2) ?? '-'}</span>
      ${rfq.award.rationale ? `<pre style="margin-top:10px">${esc(rfq.award.rationale)}</pre>` : ''}</div>` : ''}
    ${r ? `<h2>Independent audit (Reppo)</h2><div class="card">
      <strong class="${r.route === 'ship' ? 'ok' : r.route === 'block' ? 'bad' : 'warn'}">${esc(r.route ?? r.status)}</strong>
      <span class="kv"> · score ${esc(r.score ?? '-')}</span><p class="kv">${esc(r.reason ?? '')}</p>
      ${(r.rounds?.length ?? 0) > 1 ? `<p class="kv"><strong>Repair loop:</strong> ${r.rounds.map((x) => `${esc(x.label)}: ${esc(x.route ?? x.status)} ${esc(x.score ?? '')}`).join(' → ')}</p>` : ''}</div>` : ''}
    ${rfq.settlement?.length ? `<h2>Settlement</h2><div class="card"><ol>${rfq.settlement.map((s) => `<li><span class="t"></span><span class="s">${esc(s.event ?? 'transfer')}</span><span>${esc(s.label ?? s.why ?? '')} ${esc(s.amount)}${s.tx ? ` <a href="${esc(s.tx)}" target="_blank">tx</a>` : ''}</span></li>`).join('')}</ol></div>` : ''}
    ${rfq.escrow && rfq.phase === 'settled' ? `<h2>Verified by your browser</h2><div class="card" id="proof" aria-live="polite"><p class="kv">Checking against Kite testnet…</p></div>` : ''}
    ${rfq.phase === 'held' && rfq.award?.winner ? `<h2>Human review</h2><div class="card">
      <p class="kv">Money is held. A reviewer can release the award to ${esc(rfq.award.winner)} by signing with their own wallet; the signature goes into the trace.</p>
      <button class="approve" data-id="${esc(rfq.id)}" data-winner="${esc(rfq.award.winner)}">Sign and release to ${esc(rfq.award.winner)}</button></div>` : ''}
    ${rfq.humanApproval ? `<h2>Human review</h2><div class="card ok">Released by <code>${esc(rfq.humanApproval.approver)}</code>${rfq.humanApproval.note ? `: ${esc(rfq.humanApproval.note)}` : ''}
      ${rfq.humanApproval.signature ? `<details class="kv"><summary>signed message (EIP-191)</summary><pre>${esc(rfq.humanApproval.message)}
${esc(rfq.humanApproval.signature)}</pre></details>` : ''}</div>` : ''}
    <h2>Trace</h2><div class="card"><ol>${rfq.events.map((e) => `<li><span class="t">${e.t.slice(11, 19)}</span><span class="s">${esc(e.step)}</span><span>${esc(e.msg)}
      ${e.data?.tx ? ` <a href="${esc(e.data.tx)}" target="_blank">tx</a>` : ''}</span></li>`).join('')}</ol></div>`;
  // values travel as data attributes, never interpolated into inline JS
  document.querySelector('#view .approve')?.addEventListener('click', (ev) => approveHeld(ev.currentTarget.dataset.id, ev.currentTarget.dataset.winner));
  window.__lastRfq = rfq;
  if (document.querySelector('#proof')) window.verifyOnChain?.(rfq);
}

// Static deploys (e.g. Vercel) have no tender server: show the recorded run from tender.json instead.
let staticMode = false;
async function loadStatic() {
  staticMode = true;
  $('#run').hidden = true;
  $('#note').hidden = false;
  const index = await (await fetch('tenders.json')).json();
  let wanted = null;
  const show = async (id) => {
    wanted = id;
    for (const b of document.querySelectorAll('#tenders button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
    const rfq = await (await fetch(`tenders/${encodeURIComponent(id)}.json`)).json();
    if (wanted === id) render(rfq); // a slower earlier click must not overwrite the tab the visitor chose last
  };
  const nav = $('#tenders');
  nav.innerHTML = index.map((t) => `<button type="button" data-id="${esc(t.id)}" aria-pressed="false">${esc(t.label)}</button>`).join('');
  nav.hidden = index.length < 2;
  nav.onclick = (e) => { const id = e.target.closest('button')?.dataset.id; if (id) show(id); };
  await show((index.find((t) => t.featured) ?? index[0]).id);
}

async function tick() {
  if (staticMode) return;
  try {
    const res = await fetch('/api/rfqs');
    if (!res.ok) return loadStatic();
    const { rfqs, running } = await res.json();
    $('#run').disabled = Boolean(running);
    const id = running || current || rfqs[0]?.id;
    if (!id) return;
    const body = await (await fetch(`/api/rfqs/${id}`)).text();
    if (body !== lastBody) { lastBody = body; render(JSON.parse(body)); } // re-render only on change, so buttons stay clickable
  } catch {}
}
$('#run').onclick = async () => {
  const token = new URLSearchParams(location.search).get('token') || '';
  const res = await fetch(`/api/demo?token=${encodeURIComponent(token)}`, { method: 'POST' });
  const body = await res.json();
  if (body.id) current = body.id; else alert(body.error);
  tick();
};
// The approver signs the release with their own wallet (EIP-191); the server verifies it and keeps the signature in
// the trace. Same message as approvalMessage() in src/lelang.js.
async function approveHeld(id, winner) {
  if (!window.ethereum) return alert('Approving needs a browser wallet to sign the release (or use scripts/approve.js with a key).');
  const note = (prompt('Why are you releasing it? (optional)') || '').slice(0, 200);
  try {
    const [approver] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const message = `LELANG approve ${id} award ${winner}${note ? ` note: ${note}` : ''}`;
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, approver] });
    const token = new URLSearchParams(location.search).get('token') || '';
    const q = new URLSearchParams({ token, approver, note, winner, signature });
    const res = await fetch(`/api/rfqs/${id}/approve?${q}`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error);
  } catch (e) {
    alert(`Not approved: ${e.message}`);
  }
  tick();
}
tick(); setInterval(tick, 2000);
