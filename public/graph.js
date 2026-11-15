// Decision graph for one tender: every pipeline step as a node, labelled by what made the call.
// Reads only the published tender JSON (works offline); nothing here is inferred beyond what the trace records.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NR = 'not recorded';
const txUrl = (h) => (!h ? null : String(h).startsWith('http') ? h : `https://testnet.kitescan.ai/tx/${h}`);
const short = (h) => { const s = String(h).split('/').pop(); return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s; };
const usd = (n) => (n == null ? '?' : `$${Number(n).toLocaleString('en-US')}`);
const ev = (rfq, step, pred = () => true) => (rfq.events ?? []).filter((e) => e.step === step && pred(e));
const forBid = (label) => (e) => e.msg?.startsWith(`${label} `) || e.msg?.startsWith(`${label}:`);

export const KINDS = {
  code: { name: 'code', what: 'deterministic rule, same input same output' },
  chain: { name: 'on-chain', what: 'Kite testnet transaction' },
  llm: { name: 'LLM read', what: 'a model reads or screens text into fixed fields or a fixed label (Dolphin, SERV, Prompt Guard)' },
  decision: { name: 'decision node', what: 'SERV strict-schema choice with probabilities' },
  audit: { name: 'independent audit', what: 'Reppo panel scores the action' },
  human: { name: 'human', what: 'named approver or supplier signs' },
};
export const BANDS = [
  { name: 'Fixed logic', what: 'Rules and the chain. No model can change these.', kinds: ['code', 'chain'] },
  { name: 'Bounded AI', what: 'Models fill a schema or pick from listed options; code checks what they return.', kinds: ['llm', 'decision'] },
  { name: 'Oversight', what: 'Outside checks on the machine verdicts.', kinds: ['audit', 'human'] },
];

// node: { k, title, v, tone: ok|bad|warn, d, tx, tag, skip }
function bidLane(rfq, b) {
  const n = [];
  const g = b.guard ?? {};
  const m = g.manipulation;
  const stoppedAtReveal = b.revealOk === false;
  const slashed = Boolean(b.slash) || /hidden instructions/.test(b.disqualified ?? '');
  const skip = (k, title, why) => n.push({ k, title, v: why, skip: true });

  n.push({ k: 'chain', title: 'Sealed commit + bond', v: b.bondTx ? `bond ${b.bondPie ?? rfq.bondPie ?? '?'} locked` : NR, tx: b.bondTx });
  n.push({ k: b.revealTx ? 'chain' : 'code', title: b.revealTx ? 'Reveal matches commit (enforced by the escrow)' : 'Reveal matches commit', v: b.revealOk == null ? NR : b.revealOk ? 'hash matches' : 'does not match', tone: b.revealOk ? 'ok' : b.revealOk === false ? 'bad' : '', tx: b.revealTx });
  if (stoppedAtReveal) { skip('code', 'Rest of evaluation', 'skipped: bid not valid at reveal'); return n; }

  const rep = ev(rfq, 'reputation', forBid(b.label));
  n.push({ k: 'code', title: 'Reputation (escrow slash history)',
    v: b.priorSlashes?.length ? `${b.priorSlashes.length} proven prior slash(es)` : rep.length ? 'flag raised' : 'no prior slash on record',
    tone: b.priorSlashes?.length || rep.length ? 'warn' : 'ok', d: rep[0]?.msg?.replace(`${b.label}: `, ''), tx: b.priorSlashes?.[0]?.tx });

  const pg = g.servPromptGuard;
  n.push({ k: 'llm', tag: 'classifier', title: 'SERV Prompt Guard', v: pg ? (pg.blocked ? 'blocked' : 'passed') : NR, tone: pg ? (pg.blocked ? 'warn' : 'ok') : '' });
  n.push({ k: 'decision', title: 'Manipulation check', v: m ? `p = ${Number(m.p).toFixed(2)}` : NR, tone: m ? (m.p > 0.8 ? 'bad' : 'ok') : '', d: m?.engine });
  if (m) {
    const aimed = g.addressedToEvaluator;
    const verdict = m.p > 0.8 ? (m.verified ? 'quote found verbatim' : 'quote not found in document: human review, no slash') : 'nothing to verify';
    n.push({ k: 'code', title: 'Quote verified in document', v: verdict, tone: m.p > 0.8 ? (m.verified ? 'bad' : 'warn') : 'ok',
      d: m.verified && m.evidence ? `“${m.evidence.slice(0, 140)}${m.evidence.length > 140 ? '…' : ''}”` : '' });
    // The slash itself also needs a second SERV decision node (confirmAddressedToEvaluator in src/ai.js), not code alone.
    if (m.p > 0.8 && m.verified) n.push({ k: 'decision', title: 'Addressed to the evaluator?', v: aimed == null ? NR : `p = ${Number(aimed).toFixed(2)}: ${slashed ? 'slash' : 'states terms, human review'}`, tone: slashed ? 'bad' : 'warn' });
  }
  if (slashed) { skip('code', 'Rest of evaluation', 'skipped: bid slashed'); appeal(n, b); return n; }

  const ex = ev(rfq, 'extract', forBid(b.label))[0];
  const engine = ex?.msg.match(/read by (.+?): \$/)?.[1];
  const t = b.terms;
  n.push({ k: 'llm', title: 'Terms read', v: t ? `${usd(t.total_usd)} · ${t.delivery_days ?? '?'}d · ${t.warranty_months ?? '?'}mo` : NR, d: engine ?? (t ? 'reader not recorded' : '') });

  const s = b.secondRead;
  n.push(s
    ? { k: 'llm', title: 'Second reader', v: s.disagree?.length ? `disagrees on ${s.disagree.map((x) => x.field).join(', ')}` : 'same terms', tone: s.disagree?.length ? 'warn' : 'ok', d: s.engine }
    : { k: 'llm', title: 'Second reader', v: engine && !engine.startsWith('Dolphin') ? 'skipped: SERV was the only reader' : NR, skip: true });

  n.push({ k: 'llm', title: 'Stated alternatives (ambiguity)', v: b.ambiguous?.length ? b.ambiguous.map((a) => `${a.field} ${a.values.join(' / ')}`).join(', ') : 'no second figure recorded', tone: b.ambiguous?.length ? 'warn' : '' });

  if (rfq.qualitative?.criterion && rfq.weights?.quality) { // same condition as src/lelang.js: only a weighted criterion is read
    const q = b.quality;
    n.push({ k: 'llm', title: 'Quality readers', v: q ? `${q.score}/10${q.disagree ? ', readers disagree' : ''}` : NR, tone: q?.disagree ? 'warn' : '',
      d: q?.readers?.map((r) => `${r.engine} ${r.score}${r.verified ? '' : ' (quote not found → 0)'}`).join(' · ') });
  }

  const dq = b.disqualified;
  n.push({ k: 'code', title: 'Rules: cap, delivery, specs', v: dq ? `disqualified: ${dq}` : t ? 'passes' : NR, tone: dq ? 'bad' : t ? 'ok' : '' });
  if (b.review || b.trustFlag) n.push({ k: 'code', title: 'Hold flag', v: 'cannot win automatically', tone: 'warn', d: b.review });
  appeal(n, b);
  return n;
}

function appeal(n, b) {
  const a = b.appeal;
  if (!a) return;
  n.push({ k: 'human', title: 'Supplier appeal (signed)', v: a.signature ? 'signed by the slashed supplier' : NR, d: a.reason?.slice(0, 160) });
  n.push({ k: 'audit', title: 'Appeal panel (Reppo)', v: `${a.outcome ?? NR}${a.audit?.score != null ? ` · ${a.audit.route} ${a.audit.score}` : ''}`, tone: a.outcome === 'upheld' ? 'ok' : 'warn', tx: a.refundTx });
}

export function build(rfq) {
  const bids = Object.values(rfq.bids ?? {});
  const pre = [];
  const opened = ev(rfq, 'rfq')[0];
  pre.push({ k: 'chain', title: 'Tender opened', v: rfq.chainId ? `escrow tender #${rfq.chainId}` : NR, d: rfq.title, tx: opened?.data?.tx });
  for (const f of ev(rfq, 'fee')) pre.push({ k: 'chain', title: 'Tender fee (x402)', v: f.msg.replace(/^Tender fee paid over x402 by \S+ /, ''), tx: f.data?.tx });
  pre.push({ k: 'chain', title: 'Commits closed', v: `${bids.length} sealed bid(s), bonds locked`, tx: rfq.anchorTx });

  // A recovered tender was evaluated twice; only the pass after the last interruption decided anything.
  const ri = (rfq.events ?? []).findLastIndex((e) => e.step === 'recover');
  rfq = ri < 0 ? rfq : { ...rfq, events: rfq.events.slice(ri + 1) };
  const post = [];
  const a = rfq.award;
  const sc = a?.scores ? Object.entries(a.scores).sort((x, y) => y[1] - x[1]) : [];
  post.push({ k: 'code', title: 'Published formula', v: sc.length ? sc.map(([l, s]) => `${l} ${Number(s).toFixed(3)}`).join(' · ') : NR,
    d: [rfq.weights ? `weights ${Object.entries(rfq.weights).map(([k, w]) => `${k} ${w}`).join(', ')}` : '', ri >= 0 ? 're-run after an interrupted evaluation; the earlier pass is not shown' : ''].filter(Boolean).join(' · ') });
  if (rfq.qualityAnchor) post.push({ k: 'chain', title: 'Quality ratings anchored', v: `keccak ${short(rfq.qualityAnchor.hash)}`, tx: rfq.qualityAnchor.tx });
  const pr = a?.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([l, p]) => `${l} ${p}`).join(' · ') : '';
  post.push({ k: 'decision', title: 'Award decision node',
    v: a ? `${a.winner ?? a.decision} · confidence ${a.confidence ?? '?'}` : NR, tone: a ? (a.winner === a.formulaWinner ? 'ok' : 'warn') : '',
    d: a ? [a.engine, a.formulaWinner ? `formula says ${a.formulaWinner}${a.winner === a.formulaWinner ? ' (match)' : ' (mismatch)'}` : '', pr && `p: ${pr}`].filter(Boolean).join(' · ') : '' });
  const rat = ev(rfq, 'rationale')[0];
  post.push({ k: 'llm', title: 'Award rationale', tag: 'open-ended', v: a?.rationale ? 'written after the decision; explains, does not decide' : NR, d: rat?.msg });

  const r = rfq.reppo;
  const rounds = r?.rounds ?? (r ? [r] : []);
  post.push({ k: 'audit', title: 'Reppo audit', v: r ? `${r.route ?? r.status} · score ${r.score ?? '?'}` : NR, tone: r ? (r.route === 'ship' ? 'ok' : 'warn') : '',
    d: r ? [r.rubric && Object.entries(r.rubric).map(([k, v]) => `${k} ${v}`).join(', '), rounds.length > 1 ? `${rounds.length} rounds, strictest used` : ''].filter(Boolean).join(' · ') : '' });

  const holds = [...ev(rfq, 'review', (e) => /still under review|under review, but/.test(e.msg)), ...ev(rfq, 'repair'), ...ev(rfq, 'award', (e) => /escalat/.test(e.msg)), ...ev(rfq, 'settle', (e) => /Settlement HELD/.test(e.msg))];
  const human = rfq.humanApproval;
  const held = Boolean(human) || ev(rfq, 'human').length > 0 || /escalat|still under review|Settlement HELD/.test(holds.map((h) => h.msg).join(' '));
  post.push({ k: 'code', title: 'Auto-release gate', v: held ? 'held for a human' : 'released automatically', tone: held ? 'warn' : 'ok',
    d: holds.map((h) => h.msg).join(' · ') || `confidence ≥ ${rfq.minConfidence ?? '?'}, formula match, no flagged bid ahead` });
  if (held) post.push(human
    ? { k: 'human', title: 'Approver signature', v: `released to ${a?.winner ?? '?'}`, d: `${human.approver ?? NR} · ${human.note ?? ''}` }
    : { k: 'human', title: 'Approver signature', v: ev(rfq, 'human')[0]?.msg ?? NR });

  const st = rfq.settlement ?? [];
  if (!st.length) post.push({ k: 'chain', title: 'Settle', v: NR });
  const byTx = {};
  for (const s of st) (byTx[s.tx] ??= []).push(s);
  for (const [tx, list] of Object.entries(byTx)) {
    const bad = list.some((s) => /Slash/.test(s.event));
    post.push({ k: 'chain', title: 'Settle', v: list.map((s) => `${s.event} ${/^0x/.test(s.label) ? short(s.label) : s.label} ${s.amount}`).join(' · '), tone: bad ? 'bad' : 'ok', tx });
  }

  const dd = rfq.deliveryDispute;
  if (dd) {
    post.push({ k: 'llm', title: 'Delivery evidence readers', v: dd.readers?.map((x) => `${x.engine}: ${x.met ? 'met' : 'not met'}`).join(' · ') ?? NR, tone: 'warn', d: dd.recommendation && `advice: ${dd.recommendation}` });
    post.push({ k: 'chain', title: 'Dispute anchored', v: `balance ${rfq.delivery?.status ?? NR}${rfq.delivery?.balance ? ` (${rfq.delivery.balance})` : ''}`, tx: dd.anchorTx });
  }
  return { pre, lanes: bids.map((b) => ({ label: b.label, nodes: bidLane(rfq, b) })), post };
}

export function count(g) {
  const c = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
  for (const nd of [...g.pre, ...g.lanes.flatMap((l) => l.nodes), ...g.post]) if (!nd.skip) c[nd.k]++;
  return c;
}

const nodeHtml = (nd, last) => `<div class="node k-${nd.k}${nd.skip ? ' skip' : ''}${last ? ' last' : ''}">
  <div class="kind">${esc(KINDS[nd.k].name)}${nd.tag ? `<span class="tag">${esc(nd.tag)}</span>` : ''}</div>
  <div class="ti">${esc(nd.title)}</div>
  <div class="v ${nd.tone ?? ''}">${esc(nd.v)}</div>
  ${nd.d ? `<div class="d">${esc(nd.d)}</div>` : ''}
  ${nd.tx ? `<div class="d"><a href="${esc(txUrl(nd.tx))}" target="_blank" rel="noopener">tx ${esc(short(nd.tx))}</a></div>` : ''}
</div>`;

function render(rfq) {
  const g = build(rfq);
  const c = count(g);
  const total = Object.values(c).reduce((x, y) => x + y, 0);
  const bands = BANDS.map((b) => `<div class="band"><h3>${esc(b.name)} · ${b.kinds.reduce((s, k) => s + c[k], 0)}</h3><p>${esc(b.what)}</p>
    ${b.kinds.map((k) => `<div class="lg"><span class="sw k-${k}"></span><span><strong>${esc(KINDS[k].name)}</strong> <span class="kv">${esc(KINDS[k].what)}</span></span><b>${c[k]}</b></div>`).join('')}</div>`).join('');
  const ratio = Object.keys(KINDS).map((k) => `<i class="k-${k}" style="width:${(100 * c[k]) / total}%;background:var(--kc)" title="${esc(KINDS[k].name)}: ${c[k]}"></i>`).join('');
  return `<h2>${esc(rfq.title ?? rfq.id)}</h2>
  <p class="kv">${esc(rfq.id)} · phase ${esc(rfq.phase ?? NR)} · ${total} steps · <a href="index.html?t=${encodeURIComponent(rfq.id)}">full tender page</a></p>
  <div class="ratio" aria-hidden="true">${ratio}</div>
  <div class="legend">${bands}</div>
  <div class="flowg">
    ${g.pre.map((nd) => nodeHtml(nd)).join('')}
    <div class="fan"><p class="kv">Fans out: each bid goes through the same steps on its own (${g.lanes.length} bid${g.lanes.length === 1 ? '' : 's'}).</p>
      <div class="lanes">${g.lanes.map((l) => `<div class="lane"><h3>${esc(l.label)}</h3>${l.nodes.map((nd, i) => nodeHtml(nd, i === l.nodes.length - 1)).join('')}</div>`).join('')}</div></div>
    ${g.post.map((nd, i) => nodeHtml(nd, i === g.post.length - 1)).join('')}
  </div>`;
}

if (typeof document !== 'undefined') {
  const view = document.querySelector('#view');
  const sel = document.querySelector('#t');
  const id = new URLSearchParams(location.search).get('t') ?? '';
  try {
    const list = await fetch('tenders.json').then((r) => (r.ok ? r.json() : []));
    sel.innerHTML = `<option value="">Choose a tender…</option>${list.map((t) => `<option value="${esc(t.id)}"${t.id === id ? ' selected' : ''}>${esc(t.label ?? t.id)}</option>`).join('')}`;
    sel.addEventListener('change', () => { if (sel.value) location.search = `?t=${encodeURIComponent(sel.value)}`; });
    const t = id || list.find((x) => x.featured)?.id || list[0]?.id;
    if (!t || !/^rfq-[\w-]+$/.test(t)) throw new Error('No tender given.');
    if (!id) sel.value = t;
    const res = await fetch(`tenders/${encodeURIComponent(t)}.json`);
    if (!res.ok) throw new Error(`Tender ${t} not found.`);
    view.innerHTML = render(await res.json());
  } catch (e) {
    view.innerHTML = `<p class="warn">${esc(e.message)}</p>`;
  }
}
