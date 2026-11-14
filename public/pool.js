// The bounty pool, straight from the V4 escrow on Kite: its balance, every slash with its on-chain status, every bounty.
import { createPublicClient, http, defineChain, formatUnits } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';
import { esc } from './verify.js';

const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 15_000, retryCount: 2 }) });
const TX = (h) => `<a href="https://testnet.kitescan.ai/tx/${esc(h)}">tx</a>`;
const ERC20 = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

try {
  const d = await (await fetch('deployment.json')).json();
  const { address, block } = d.escrow;
  const abi = d.abi;
  if (!abi.some((f) => f.name === 'bountyPool')) throw new Error('the current escrow is not V4');
  const ev = (eventName) => client.getContractEvents({ address, abi, eventName, fromBlock: BigInt(block) });
  const [pending, slashed, overturned, paid, opened, latest] = await Promise.all([ev('SlashPending'), ev('BondSlashed'), ev('SlashOverturned'), ev('BountyPaid'), ev('TenderOpened'), client.getBlock()]);
  const tokens = [...new Set(opened.map((l) => l.args.token))];
  const meta = Object.fromEntries(await Promise.all(tokens.map(async (t) => [t.toLowerCase(), {
    decimals: await client.readContract({ address: t, abi: ERC20, functionName: 'decimals' }),
    symbol: await client.readContract({ address: t, abi: ERC20, functionName: 'symbol' }),
  }])));
  const tokenOf = Object.fromEntries(opened.map((l) => [String(l.args.id), l.args.token.toLowerCase()]));
  const fmt = (amount, token) => `${formatUnits(amount, meta[token]?.decimals ?? 18)} ${meta[token]?.symbol ?? ''}`;

  const balances = await Promise.all(tokens.map(async (t) => [t.toLowerCase(), await client.readContract({ address, abi, functionName: 'bountyPool', args: [t] })]));
  const nonzero = balances.filter(([, v]) => v > 0n);
  document.getElementById('pool').textContent = nonzero.length ? nonzero.map(([t, v]) => fmt(v, t)).join(' + ') : '0';
  const proven = slashed.filter((l) => BigInt(l.args.evidenceHash) !== 0n).length;
  document.getElementById('poolNote').innerHTML = `${proven} proven slash${proven === 1 ? '' : 'es'} finalized and ${slashed.length - proven} unrevealed bond${slashed.length - proven === 1 ? '' : 's'} forfeited into it; ${paid.length} bount${paid.length === 1 ? 'y' : 'ies'} paid out. Escrow <a href="https://testnet.kitescan.ai/address/${esc(address)}?tab=contract">${esc(address.slice(0, 10))}…</a> · block ${esc(latest.number)}.`;

  const key = (l) => `${l.args.id}:${l.args.bidder.toLowerCase()}`;
  const fin = new Map(slashed.map((l) => [key(l), l]));
  const over = new Map(overturned.map((l) => [key(l), l]));
  const now = Number(latest.timestamp);
  document.getElementById('slashes').innerHTML = pending.length ? `<table><tr><th>Tender</th><th>Bidder</th><th>Bond</th><th>Evidence hash</th><th>Status</th></tr>${pending.map((l) => {
    const k = key(l), token = tokenOf[String(l.args.id)];
    const status = over.has(k) ? `<span class="ok">overturned on appeal: bond returned</span> ${TX(over.get(k).transactionHash)}`
      : fin.has(k) ? `<span class="bad">final: bond to the bounty pool</span> ${TX(fin.get(k).transactionHash)}`
      : Number(l.args.finalAt) > now ? `<span class="warn">pending until ${esc(new Date(Number(l.args.finalAt) * 1000).toISOString().slice(0, 16))} UTC</span>`
      : '<span class="warn">window over, waiting to be finalized (anyone can)</span>';
    return `<tr><td>#${esc(l.args.id)} ${TX(l.transactionHash)}</td><td><code>${esc(l.args.bidder)}</code></td><td>${esc(fmt(l.args.amount, token))}</td><td><code>${esc(l.args.evidenceHash.slice(0, 18))}…</code></td><td>${status}</td></tr>`;
  }).join('')}</table>` : '<p class="kv">No slash on V4 yet.</p>';

  document.getElementById('bounties').innerHTML = paid.length ? `<table><tr><th>To</th><th>Amount</th><th>Evidence hash</th><th></th></tr>${paid.map((l) => `<tr><td><code>${esc(l.args.to)}</code></td><td>${esc(fmt(l.args.amount, l.args.token.toLowerCase()))}</td><td><code>${esc(l.args.evidenceHash.slice(0, 18))}…</code></td><td>${TX(l.transactionHash)}</td></tr>`).join('')}</table>`
    : '<p class="kv">None yet. A <a href="attacks.html">Break Lelang</a> attack that would have won is paid from this pool when the pool covers the bounty.</p>';
} catch (e) {
  for (const id of ['slashes', 'bounties']) document.getElementById(id).innerHTML = `<p class="warn">Couldn't read Kite testnet: ${esc(e.shortMessage ?? e.message)}</p>`;
}
