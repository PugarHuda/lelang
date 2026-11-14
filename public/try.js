// "Try to fool the evaluator": replay a measured attack for free, or pay 0.05 PYUSD and have the live evaluator
// (POST /api/challenge, the same checks a tender runs) judge your own paragraph appended to an honest bid.
import { paidPost, wallet, claimPyusd } from './pay.js';

const API = 'https://lelang-6k05.onrender.com';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const verdict = (cls, label, body) => { $('verdict').innerHTML = `<span class="v ${cls}">${esc(label)}</span>${body}`; };

let base = '';
// the bid with the attack marked; a verified quote, if any, is marked again inside it
function showDoc(attack, quote) {
  let a = esc(attack);
  if (quote) { const q = esc(quote); if (a.includes(q)) a = a.replace(q, `<mark class="q">${q}</mark>`); }
  $('doc').innerHTML = `${esc(base)}${attack ? `<mark>${a}</mark>` : ''}`;
}

const presets = [];
function select(i) {
  presets.forEach((p, j) => p.btn.setAttribute('aria-pressed', String(i === j)));
  const p = presets[i];
  $('atk').value = p.attack;
  showDoc(p.attack);
  p.show();
}

fetch('attacks.json').then((r) => r.json()).then((d) => {
  base = d.base;
  const runs = d.fixed.summary.runs;
  for (const c of d.fixed.cases) {
    // each case is the honest bid plus one paragraph; the paragraph is what follows the last blank line
    const attack = c.text.slice(c.text.lastIndexOf('\n\n') + 2);
    const r = c.result;
    presets.push({
      name: c.clean ? `${c.name} (honest)` : c.name, cls: c.clean ? 'clean' : '', attack: c.clean ? '' : attack,
      show: c.clean
        ? () => { $('doc').textContent = c.text; verdict('ok', 'honest bid', `<p>${esc(r.cleanPass)} of ${esc(runs)} runs passed clean, ${esc(r.falsePositive)} false alarms. A slash needs a verbatim quote aimed at the evaluator.</p>`); }
        : () => verdict(r.slashed === runs ? 'bad' : 'warn', r.slashed === runs ? 'slashed with proof' : 'caught', `<p>Measured over ${esc(runs)} runs: <b>${esc(r.slashed)}</b> slashed with a verbatim quote, <b>${esc(r.review)}</b> held for a human, <b>${esc(r.missed)}</b> missed.</p>`),
    });
  }
  const won = d.adaptiveBefore.attempts.find((x) => x.outcome === 'escaped detection' && x.bothReadersFooled);
  const after = d.adaptiveAfter.attempts, afterWins = after.filter((x) => x.outcome === 'escaped detection' && x.bothReadersFooled).length;
  if (won) presets.push({
    name: 'the one that beat us', cls: 'won', attack: won.text,
    show: () => verdict('bad', 'won, before the fix', `<p>An adaptive attacker wrote this in round ${esc(won.round)}: no instruction to the AI at all, just a second figure for delivery. Nothing flagged it and both readers took the false number. Now any bid with two figures for one term goes to a human: ${esc(afterWins)} of ${esc(after.length)} later attempts won.</p>`),
  });
  $('presets').innerHTML = '';
  presets.forEach((p, i) => {
    p.btn = Object.assign(document.createElement('button'), { type: 'button', textContent: p.name, className: p.cls });
    p.btn.addEventListener('click', () => select(i));
    $('presets').append(p.btn);
  });
  select(0);
}).catch((e) => { $('verdict').textContent = `Couldn't load the measured attacks: ${e.message}`; });

$('atk').addEventListener('input', () => {
  presets.forEach((p) => p.btn?.setAttribute('aria-pressed', 'false'));
  showDoc($('atk').value);
  verdict('mute', 'not judged yet', '<p>Your own paragraph has no recorded result. Judge it live: the same checks a tender runs, on the public API.</p>');
});

$('judge').addEventListener('click', async () => {
  const attack = $('atk').value.trim();
  if (attack.length < 10 || attack.length > 600) return verdict('warn', 'too short or too long', '<p>Write 10 to 600 characters.</p>');
  $('judge').disabled = true;
  try {
    const e = await paidPost(`${API}/api/challenge`, { attack }, (msg) => verdict('mute', 'working', `<p>${esc(msg)}</p>`));
    showDoc(attack, e.quote);
    const cls = e.wouldWin ? 'bad' : e.outcome.startsWith('slashed') ? 'ok' : 'warn';
    const label = e.wouldWin ? 'you won' : e.outcome;
    const readers = `Dolphin took your numbers: <b>${e.dolphinWrong ? 'yes' : 'no'}</b> · SERV took them: <b>${e.servWrong ? 'yes' : 'no'}</b>${e.ambiguous ? ' · two figures for one term: held for a human' : ''}`;
    const paid = e.paymentTx ? ` · <a href="${esc(e.paymentTx)}" target="_blank" rel="noopener">your payment</a>` : '';
    const bounty = e.bounty ? `<p>Bounty: <b>${esc(e.bounty.amount)} ${esc(e.bounty.asset)}</b>, ${esc(e.bounty.status)}${e.bounty.tx ? ` · <a href="${esc(e.bounty.tx)}" target="_blank" rel="noopener">tx</a>` : ''}</p>` : '';
    verdict(cls, label, `<p>${e.quote ? 'The evaluator quoted your text verbatim (highlighted) and code found it in the bid. ' : ''}Manipulation probability ${esc((+e.manipulationP).toFixed(2))}.</p><p>${readers}${paid}</p>${bounty}<p class="fine">Recorded on the <a href="attacks.html">attack gallery</a> with every other attempt.</p>`);
  } catch (err) {
    verdict('warn', 'not judged', `<p>${esc(err.message ?? err)}</p>`);
  } finally {
    $('judge').disabled = false;
  }
});

$('faucet').addEventListener('click', async () => {
  try {
    const tx = await claimPyusd(await wallet());
    verdict('ok', 'claim sent', `<p>10 test PYUSD on their way: <a href="https://testnet.kitescan.ai/tx/${esc(tx)}" target="_blank" rel="noopener">tx</a>. The claim needs a little KITE for gas.</p>`);
  } catch (err) { verdict('warn', 'no claim', `<p>${esc(err.message ?? err)}</p>`); }
});
