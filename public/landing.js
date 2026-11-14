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
