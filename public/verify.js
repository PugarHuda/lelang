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
const rcptBlock = (pre, ev) => ev.blockNumber ?? pre?.rcpt?.blockNumber ?? 0n;
const supplierOf = (rfq, a) => Object.values(rfq.bids).find((b) => b.supplier.toLowerCase() === a.toLowerCase());

// One slash, in full detail: what the browser computed next to what the chain holds.
export async function checkSlash(rfq, bid, pre) {
  pre ??= await settleLogs(rfq);
  const { logs, settleTx, block } = pre;
  // V4 escrows record a slash as SlashPending at settle; it becomes BondSlashed (to the bounty pool) after the window,
  // or SlashOverturned if a quorum of approvers reverses it. The evidence hash is in the settle tx either way.
  const ev = logs.find((l) => (l.eventName === 'BondSlashed' || l.eventName === 'SlashPending') && l.args.bidder.toLowerCase() === bid.supplier.toLowerCase());
  const [, docHashOnChain] = await client.readContract({ address: rfq.escrow, abi: await abi(rfq.escrow), functionName: 'bids', args: [BigInt(rfq.chainId), bid.supplier] });
  const quote = bid.evidence ?? bid.disqualified;
  const r = {
    settleTx, block, amount: ev?.args.amount,
    evidenceComputed: keccak256(toHex(quote)), evidenceOnChain: ev?.args.evidenceHash ?? null,
    docComputed: keccak256(toHex(bid.doc)), docOnChain: docHashOnChain,
    quoteInDoc: !bid.evidence || norm(bid.doc).includes(norm(bid.evidence)),
  };
  r.ok = Boolean(ev) && r.evidenceComputed === r.evidenceOnChain && r.docComputed === r.docOnChain && r.quoteInDoc;
  if (ev?.eventName === 'SlashPending') {
    const a = await abi(rfq.escrow);
    const args = { id: BigInt(rfq.chainId), bidder: bid.supplier };
    const [fin, over] = await Promise.all(['BondSlashed', 'SlashOverturned'].map((eventName) => client.getContractEvents({ address: rfq.escrow, abi: a, eventName, args, fromBlock: rcptBlock(pre, ev) })));
    r.status = over.length ? 'overturned on appeal: the escrow returned the bond' : fin.length ? 'final: the bond went to the bounty pool, not to the buyer'
      : `pending until ${new Date(Number(ev.args.finalAt) * 1000).toISOString()}: a quorum of approvers can still overturn it`;
  }
  return r;
}

// Same canonical form as qualityRows/qualityHash in src/lelang.js: change both together.
const qualityHash = (bids) => keccak256(toHex(JSON.stringify([...bids].filter((b) => b.quality).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  .flatMap((b) => b.quality.readers.map(({ engine, score, quote }) => ({ label: b.label, engine, score, quote }))))));
// A hash anchored by anchorHash (src/kite.js): a tx from the tender's buyer to itself with data "LELANG" + hash.
async function anchored(rfq, hash, txUrl) {
  const [tx, [buyer]] = await Promise.all([
    client.getTransaction({ hash: txUrl.split('/tx/')[1] }),
    client.readContract({ address: rfq.escrow, abi: await abi(rfq.escrow), functionName: 'tenders', args: [BigInt(rfq.chainId)] }),
  ]);
  const b = buyer.toLowerCase();
  return tx.input.toLowerCase() === `0x4c454c414e47${hash.slice(2)}`.toLowerCase() && tx.from.toLowerCase() === b && tx.to?.toLowerCase() === b;
}

// The whole settlement: tx went to the escrow, every slash checks out, refunds and award match the published result.
export async function checkTender(rfq) {
  const pre = await settleLogs(rfq);
  const { rcpt, code, block, logs } = pre;
  const rows = [];
  const add = (ok, text) => rows.push({ ok, text });
  add(rcpt.status === 'success' && rcpt.to?.toLowerCase() === rfq.escrow.toLowerCase(), `Settle tx succeeded and was sent to the escrow contract (block ${rcpt.blockNumber})`);
  add(Boolean(code && code !== '0x'), 'Escrow address holds deployed contract code');
  for (const l of logs.filter((x) => (x.eventName === 'BondSlashed' && x.args.evidenceHash !== `0x${'0'.repeat(64)}`) || x.eventName === 'SlashPending')) {
    const bid = supplierOf(rfq, l.args.bidder);
    const s = await checkSlash(rfq, bid, pre);
    add(s.ok, `${bid.label} slash: keccak(published quote) = on-chain evidence ${l.args.evidenceHash.slice(0, 10)}…, revealed document hash matches escrow storage, quote appears in the document${s.status ? ` (${s.status})` : ''}`);
  }
  const refunded = logs.filter((x) => x.eventName === 'BondRefunded').map((x) => supplierOf(rfq, x.args.bidder)?.label).sort();
  const expected = Object.values(rfq.bids).filter((b) => !b.slash).map((b) => b.label).sort();
  add(JSON.stringify(refunded) === JSON.stringify(expected), `Bonds refunded on-chain to exactly the compliant bids: ${refunded.join(', ')}`);
  const award = logs.find((x) => x.eventName === 'Awarded');
  add(award && supplierOf(rfq, award.args.winner)?.label === rfq.award.winner, `Awarded event pays ${rfq.award.winner}`);
  if (rfq.qualityAnchor?.tx) {
    const h = qualityHash(Object.values(rfq.bids));
    add(h === rfq.qualityAnchor.hash && await anchored(rfq, h, rfq.qualityAnchor.tx), `keccak256 of the published quality ratings and quotes (${h.slice(0, 10)}…) matches the hash the buyer anchored on Kite`);
  }
  if (rfq.deliveryDispute?.anchorTx) {
    const h = keccak256(toHex(rfq.deliveryDispute.evidence));
    add(h === rfq.deliveryDispute.evidenceHash && await anchored(rfq, h, rfq.deliveryDispute.anchorTx), `keccak256 of the published delivery report (${h.slice(0, 10)}…) matches the hash the buyer anchored on Kite`);
  }
  return { rows, block };
}

// Reputation straight from Kite: every BondSlashed event for `bidder` on every escrow Lelang deployed, with the buyer
// that opened each tender (only slashes by a trusted buyer count; anyone can open a tender on the permissionless escrow).
export async function slashEvents(bidder) {
  const d = await (depP ??= fetch('deployment.json').then((r) => r.json()));
  const out = [];
  for (const e of [d, ...(d.previous ?? [])]) {
    const logs = await client.getContractEvents({ address: e.escrow.address, abi: e.abi, eventName: 'BondSlashed', args: { bidder }, fromBlock: BigInt(e.escrow.block) });
    for (const l of logs) {
      const [buyer, token] = await client.readContract({ address: e.escrow.address, abi: e.abi, functionName: 'tenders', args: [l.args.id] });
      const decimals = await client.readContract({ address: token, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' });
      out.push({ escrow: e.escrow.address, tender: String(l.args.id), buyer, evidenceHash: l.args.evidenceHash, amount: Number(l.args.amount) / 10 ** decimals, tx: l.transactionHash });
    }
  }
  return { events: out, trustedBuyer: d.escrow.deployer };
}
