// Publishes Lelang's reputation to the canonical ERC-8004 registries on Arc testnet (on Kite testnet those addresses
// still hold an empty placeholder). Each supplier agent registers its own identity (it owns the ERC-721); Lelang
// registers itself; then Lelang's operator wallet, the trusted buyer that ran the tenders, gives one feedback entry per
// published bid. Values: -100 slashed for manipulation (evidence hash = the on-chain keccak of the quote), +100 won,
// +50 clean bid refunded, 0 for a slash overturned on appeal. Idempotent: what is done is recorded in
// deployments/erc8004-arc.json and skipped next time.
//   node --env-file=.env scripts/erc8004-publish.js
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEventLogs, erc20Abi, parseUnits, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OPTIONS } from '../src/x402.js';

const arc = OPTIONS[1];
const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e', REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const SITE = 'https://lelang-ten.vercel.app';
const OUT = 'deployments/erc8004-arc.json';
const ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ type: 'string', name: 'agentURI' }], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Registered', inputs: [{ type: 'uint256', name: 'agentId', indexed: true }, { type: 'string', name: 'agentURI' }, { type: 'address', name: 'owner', indexed: true }] },
  { type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable', outputs: [], inputs: [{ type: 'uint256', name: 'agentId' }, { type: 'int128', name: 'value' }, { type: 'uint8', name: 'valueDecimals' }, { type: 'string', name: 'tag1' }, { type: 'string', name: 'tag2' }, { type: 'string', name: 'endpoint' }, { type: 'string', name: 'feedbackURI' }, { type: 'bytes32', name: 'feedbackHash' }] },
];
const pub = createPublicClient({ chain: arc.chain, transport: http() });
const send = async (pk, args) => {
  const hash = await createWalletClient({ account: privateKeyToAccount(pk), chain: arc.chain, transport: http() }).writeContract(args);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`reverted: ${hash}`);
  return { hash, rcpt };
};
const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { chain: 'eip155:5042002', identityRegistry: IDENTITY, reputationRegistry: REPUTATION, agents: {}, feedback: {} };
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2));

// keys we hold: named agents and the five demo suppliers
const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
const pkOf = new Map();
for (const [name, pk] of Object.entries(keys)) pkOf.set(privateKeyToAccount(pk).address.toLowerCase(), { name, pk });
JSON.parse(readFileSync('data/wallets.json', 'utf8')).suppliers.forEach((pk, i) => pkOf.set(privateKeyToAccount(pk).address.toLowerCase(), { name: `Demo supplier ${'ABCDE'[i]}`, pk }));
const operator = process.env.BUYER_PRIVATE_KEY; // Lelang's operator: the trusted buyer of the published tenders

// agent cards (ERC-8004 registration files), served by the static site
const tenders = readdirSync('public/tenders').filter((f) => /^rfq-[\w-]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(`public/tenders/${f}`, 'utf8')));
const suppliers = [...new Set(tenders.flatMap((r) => Object.values(r.bids).map((b) => b.supplier.toLowerCase())))];
mkdirSync('public/agents', { recursive: true });
const card = (name, description, wallet, extra = []) => ({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name, description,
  endpoints: [{ name: 'agentWallet', endpoint: `eip155:2368:${wallet}` }, ...extra], supportedTrust: ['reputation'] });
writeFileSync('public/agents/lelang.json', JSON.stringify(card('Lelang', 'Sealed-bid procurement run by agents: bonds in escrow on Kite, manipulation slashed with on-chain evidence, awards audited by Reppo.', privateKeyToAccount(operator).address,
  [{ name: 'API', endpoint: 'https://lelang-6k05.onrender.com' }, { name: 'MCP', endpoint: 'node src/mcp.js (github.com/PugarHuda/lelang)' }, { name: 'web', endpoint: SITE }]), null, 2));
for (const a of suppliers) writeFileSync(`public/agents/${a}.json`, JSON.stringify(card(pkOf.get(a)?.name ?? a, 'Supplier agent bidding in Lelang tenders (demo agent on Kite testnet).', a, [{ name: 'reputation', endpoint: `${SITE}/rep.html?a=${a}` }]), null, 2));

// gas on Arc is USDC; top up whoever has to send a transaction
async function gas(addr) {
  if ((await pub.getBalance({ address: addr })) >= parseUnits('0.02', 18)) return;
  await send(operator, { address: arc.asset, abi: erc20Abi, functionName: 'transfer', args: [addr, parseUnits('0.05', 6)] });
}
async function register(key, pk, uri) {
  if (state.agents[key]) return state.agents[key].agentId;
  await gas(privateKeyToAccount(pk).address);
  const { hash, rcpt } = await send(pk, { address: IDENTITY, abi: ABI, functionName: 'register', args: [uri] });
  const agentId = parseEventLogs({ abi: ABI, logs: rcpt.logs, eventName: 'Registered' })[0].args.agentId.toString();
  state.agents[key] = { agentId, owner: privateKeyToAccount(pk).address, agentURI: uri, tx: `${arc.explorer}/tx/${hash}` };
  save();
  console.log(`registered ${key} as agent #${agentId}`);
  return agentId;
}

await register('lelang', operator, `${SITE}/agents/lelang.json`);
for (const a of suppliers) {
  const k = pkOf.get(a);
  if (!k) { console.log(`no key for ${a}; it must register itself`); continue; }
  await register(a, k.pk, `${SITE}/agents/${a}.json`);
}

// one feedback entry per published bid, from Lelang's operator
for (const r of tenders) for (const b of Object.values(r.bids)) {
  const a = b.supplier.toLowerCase(), fk = `${r.escrow}:${r.chainId}:${a}`.toLowerCase();
  if (state.feedback[fk] || !state.agents[a]) continue;
  const overturned = b.appeal?.outcome === 'overturned';
  const won = r.phase === 'settled' && r.award?.winner === b.label;
  const [value, tag1, tag2] = b.slash && b.evidence && !overturned ? [-100, 'slashed', 'manipulation'] : overturned ? [0, 'slash-overturned', 'appeal'] : won ? [100, 'won', 'award'] : b.slash ? [-25, 'slashed', 'not-revealed'] : [50, 'clean-bid', 'refunded'];
  const proof = b.slash && b.evidence ? `${SITE}/slash.html?t=${encodeURIComponent(r.id)}&b=${encodeURIComponent(b.label)}` : `${SITE}/tenders/${r.id}.json`;
  const fh = b.evidenceHash ?? keccak256(toHex(`${r.id}:${b.label}:${b.hash}`));
  await gas(privateKeyToAccount(operator).address);
  const { hash } = await send(operator, { address: REPUTATION, abi: ABI, functionName: 'giveFeedback', args: [BigInt(state.agents[a].agentId), BigInt(value), 0, tag1, tag2, SITE, proof, fh] });
  state.feedback[fk] = { agentId: state.agents[a].agentId, tender: `${r.escrow.slice(0, 10)}…#${r.chainId}`, value, tag1, tag2, feedbackURI: proof, feedbackHash: fh, tx: `${arc.explorer}/tx/${hash}` };
  save();
  console.log(`feedback ${tag1} (${value}) for agent #${state.agents[a].agentId} from tender #${r.chainId}`);
}
writeFileSync('public/erc8004.json', JSON.stringify(state, null, 2));
console.log(`agents: ${Object.keys(state.agents).length}, feedback entries: ${Object.keys(state.feedback).length}`);
