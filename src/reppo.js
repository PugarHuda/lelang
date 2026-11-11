// Reppo Eval API: independent panel verdict on the award decision.
const BASE = 'https://eval.reppo.xyz/api/v1/agents/evals';
const headers = () => ({ authorization: `Bearer ${process.env.REPPO_API_KEY}`, 'content-type': 'application/json' });

export const reppoEnabled = () => Boolean(process.env.REPPO_API_KEY);

export async function submitEval(input, taskType = 'action') {
  const res = await fetch(BASE, { method: 'POST', headers: headers(), body: JSON.stringify({ taskType, input }) });
  if (!res.ok) throw new Error(`reppo submit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

export async function waitEval(id, { timeoutMs = 240_000, everyMs = 5_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${BASE}/${id}`, { headers: headers() });
    if (!res.ok) throw new Error(`reppo read ${res.status}`);
    const ev = await res.json();
    if (ev.status === 'COMPLETED' || ev.status === 'FAILED') return ev;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`reppo eval ${id} timed out`);
}
