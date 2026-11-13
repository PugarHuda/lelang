// Independent checks, run in the visitor's browser against the Kite RPC: nothing here trusts the published JSON.
// They recompute keccak256 of every published slash quote and revealed document and compare them with the settle
// transaction's events and the escrow contract's storage. Used by the dashboard and by each slash's proof page.
import { createPublicClient, http, defineChain, parseEventLogs, keccak256, toHex } from 'https://cdn.jsdelivr.net/npm/viem@2.57.18/+esm';

const kite = defineChain({ id: 2368, name: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } } });
const client = createPublicClient({ chain: kite, transport: http(undefined, { timeout: 15_000, retryCount: 2 }) });
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Same normalization the server used to verify the quote (src/ai.js findManipulation), so zero-width or
// compatibility-character attacks verify here exactly as they did there.
const norm = (x) => x.normalize('NFKC').replace(/[\p{Cf}\p{Mn}]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
let depP;
// Each tender names its escrow; older escrows (before a contract upgrade) keep their own ABI in deployment.previous.
const abi = async (escrow) => {
  const d = await (depP ??= fetch('deployment.json').then((r) => r.json()));
  const old = (d.previous ?? []).find((p) => p.escrow.address.toLowerCase() === String(escrow).toLowerCase());
  return (old ?? d).abi;
};

async function settleLogs(rfq) {
  const settleTx = rfq.settlement.find((s) => s.tx)?.tx.split('/tx/')[1];
  const [rcpt, code, block] = await Promise.all([
    client.getTransactionReceipt({ hash: settleTx }),
    client.getCode({ address: rfq.escrow }),
    client.getBlockNumber(),
  ]);
  const logs = parseEventLogs({ abi: await abi(rfq.escrow), logs: rcpt.logs }).filter((l) => l.args.id === BigInt(rfq.chainId));
  return { rcpt, code, block, logs, settleTx };
}
const supplierOf = (rfq, a) => Object.values(rfq.bids).find((b) => b.supplier.toLowerCase() === a.toLowerCase());

// One slash, in full detail: what the browser computed next to what the chain holds.
export async function checkSlash(rfq, bid, pre) {
  const { logs, settleTx, block } = pre ?? (await settleLogs(rfq));
  const ev = logs.find((l) => l.eventName === 'BondSlashed' && l.args.bidder.toLowerCase() === bid.supplier.toLowerCase());
  const [, docHashOnChain] = await client.readContract({ address: rfq.escrow, abi: await abi(rfq.escrow), functionName: 'bids', args: [BigInt(rfq.chainId), bid.supplier] });
  const quote = bid.evidence ?? bid.disqualified;
  const r = {
    settleTx, block, amount: ev?.args.amount,
    evidenceComputed: keccak256(toHex(quote)), evidenceOnChain: ev?.args.evidenceHash ?? null,
    docComputed: keccak256(toHex(bid.doc)), docOnChain: docHashOnChain,
    quoteInDoc: !bid.evidence || norm(bid.doc).includes(norm(bid.evidence)),
  };
  r.ok = Boolean(ev) && r.evidenceComputed === r.evidenceOnChain && r.docComputed === r.docOnChain && r.quoteInDoc;
  return r;
}

// The whole settlement: tx went to the escrow, every slash checks out, refunds and award match the published result.
export async function checkTender(rfq) {
  const pre = await settleLogs(rfq);
  const { rcpt, code, block, logs } = pre;
  const rows = [];
  const add = (ok, text) => rows.push({ ok, text });
  add(rcpt.status === 'success' && rcpt.to?.toLowerCase() === rfq.escrow.toLowerCase(), `Settle tx succeeded and was sent to the escrow contract (block ${rcpt.blockNumber})`);
  add(Boolean(code && code !== '0x'), 'Escrow address holds deployed contract code');
  for (const l of logs.filter((x) => x.eventName === 'BondSlashed')) {
    const bid = supplierOf(rfq, l.args.bidder);
    const s = await checkSlash(rfq, bid, pre);
    add(s.ok, `${bid.label} slash: keccak(published quote) = on-chain evidence ${l.args.evidenceHash.slice(0, 10)}…, revealed document hash matches escrow storage, quote appears in the document`);
  }
  const refunded = logs.filter((x) => x.eventName === 'BondRefunded').map((x) => supplierOf(rfq, x.args.bidder)?.label).sort();
  const expected = Object.values(rfq.bids).filter((b) => !b.slash).map((b) => b.label).sort();
  add(JSON.stringify(refunded) === JSON.stringify(expected), `Bonds refunded on-chain to exactly the compliant bids: ${refunded.join(', ')}`);
  const award = logs.find((x) => x.eventName === 'Awarded');
  add(award && supplierOf(rfq, award.args.winner)?.label === rfq.award.winner, `Awarded event pays ${rfq.award.winner}`);
  return { rows, block };
}
