// Kite testnet: commit anchoring, bonds and settlement in a stablecoin.
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, erc20Abi, toHex, concat, parseEventLogs } from 'viem';
import { readFileSync, existsSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-testnet.gokite.ai'] } },
  blockExplorers: { default: { name: 'KiteScan', url: 'https://testnet.kitescan.ai' } },
});

// Stablecoin used for bonds and payments. Defaults to pieUSD; set STABLE_TOKEN to e.g. the faucet's USDT.
export const TOKEN = process.env.STABLE_TOKEN || '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A';
let tokenMeta;
export async function tokenInfo() {
  tokenMeta ??= await Promise.all([
    pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'decimals' }),
    pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'symbol' }),
  ]).then(([decimals, symbol]) => ({ decimals, symbol }));
  return tokenMeta;
}
export const explorerTx = (hash) => `${kiteTestnet.blockExplorers.default.url}/tx/${hash}`;

const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain: kiteTestnet, transport: http() });

export const kiteEnabled = () => Boolean(process.env.BUYER_PRIVATE_KEY);
export const buyerAccount = () => privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);

async function confirm(hash) {
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return hash;
}

// One transaction from the buyer to itself whose calldata is every commit hash, sent before reveal.
// Anyone can later check a revealed bid against this on-chain record.
export async function anchorCommits(rfqId, hashes) {
  const data = concat([toHex(`LELANG:${rfqId}:`), ...hashes]);
  const w = wallet(process.env.BUYER_PRIVATE_KEY);
  return confirm(await w.sendTransaction({ to: w.account.address, value: 0n, data }));
}

export async function transferPie(fromPk, to, amount) {
  const w = wallet(fromPk);
  const { decimals } = await tokenInfo();
  const hash = await w.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [to, parseUnits(String(amount), decimals)] });
  return confirm(hash);
}

export async function sendGas(fromPk, to, amountKite) {
  const w = wallet(fromPk);
  return confirm(await w.sendTransaction({ to, value: parseUnits(String(amountKite), 18) }));
}

export async function balances(address) {
  const [kite, bal, { decimals, symbol }] = await Promise.all([
    pub.getBalance({ address }),
    pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    tokenInfo(),
  ]);
  return { kite: formatUnits(kite, 18), [symbol]: formatUnits(bal, decimals) };
}

// --- LelangEscrow contract (bonds held on-chain, see contracts/LelangEscrow.sol) ---------------

// deployments/kite-testnet.json (written by scripts/deploy-escrow.js) is the single source of address + ABI.
const DEPLOYMENT_URL = new URL('../deployments/kite-testnet.json', import.meta.url);
export const deployment = existsSync(DEPLOYMENT_URL) ? JSON.parse(readFileSync(DEPLOYMENT_URL, 'utf8')) : null;
const ESCROW_ABI = deployment?.abi ?? [];
const ESCROW = () => process.env.ESCROW_ADDRESS || deployment?.escrow.address;
export const escrowEnabled = () => kiteEnabled() && Boolean(ESCROW()) && ESCROW_ABI.length > 0;
// Every escrow we deployed: the current one takes new tenders; older ones (deployment.previous) keep their history,
// so reputation and proofs survive a contract upgrade.
export const escrows = () => (ESCROW() ? [{ address: ESCROW(), abi: ESCROW_ABI, block: deployment?.escrow.block ?? 0 }] : [])
  .concat((deployment?.previous ?? []).map((p) => ({ address: p.escrow.address, abi: p.abi, block: p.escrow.block })));
export const escrowFor = (address) => escrows().find((e) => e.address.toLowerCase() === String(address ?? ESCROW()).toLowerCase());

async function send(pk, functionName, args, { address, abi } = { address: ESCROW(), abi: ESCROW_ABI }) {
  const w = wallet(pk);
  const hash = await w.writeContract({ address, abi, functionName, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, logs: parseEventLogs({ abi, logs: rcpt.logs }) };
}

async function approveEscrow(pk, amount) {
  const { decimals } = await tokenInfo();
  const w = wallet(pk);
  const hash = await w.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [ESCROW(), parseUnits(String(amount), decimals)] });
  return confirm(hash);
}

export async function escrowOpen(bond, { commitSeconds = 3600, revealSeconds = 3600, settleSeconds = 86400 } = {}) {
  const { decimals } = await tokenInfo();
  const { hash, logs } = await send(process.env.BUYER_PRIVATE_KEY, 'open', [TOKEN, parseUnits(String(bond), decimals), BigInt(commitSeconds), BigInt(revealSeconds), BigInt(settleSeconds)]);
  return { chainId: logs.find((l) => l.eventName === 'TenderOpened').args.id.toString(), tx: hash };
}

// Token and bond amount come from the tender on-chain, not from local config: an outside bidder may not share
// our STABLE_TOKEN, and approving the wrong token makes commit revert with ERC20InsufficientAllowance.
// `amount` (token units, e.g. '0.1') posts more than the tender bond: what a bidder with a slashing history is asked for.
export async function escrowCommit(pk, chainId, commitment, amount) {
  const [, token, bond] = await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'tenders', args: [BigInt(chainId)] });
  const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  const posted = amount ? parseUnits(String(amount), decimals) : bond;
  if (posted < bond) throw new Error(`bond ${amount} is below the tender minimum ${formatUnits(bond, decimals)}`);
  await confirm(await wallet(pk).writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [ESCROW(), posted] }));
  return (await send(pk, 'commit', [BigInt(chainId), commitment, posted])).hash;
}

export const escrowCloseCommits = async (chainId) => (await send(process.env.BUYER_PRIVATE_KEY, 'closeCommits', [BigInt(chainId)])).hash;
export const escrowReveal = async (pk, chainId, docHash, salt) => (await send(pk, 'reveal', [BigInt(chainId), docHash, salt])).hash;
// Safety valve: after an unsettled tender's settle deadline, a bidder takes its own bond back.
// `escrow` picks an older contract (a tender opened before an upgrade); default is the current one.
export const escrowWithdraw = async (pk, chainId, escrow) => (await send(pk, 'withdraw', [BigInt(chainId)], escrowFor(escrow))).hash;

// `bond` is what this bidder locked (V2 escrow); undefined on the first escrow, where it always equals the tender bond.
export async function escrowBid(chainId, bidder) {
  const [commitment, docHash, revealed, closed, bond] = await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'bids', args: [BigInt(chainId), bidder] });
  const { decimals } = await tokenInfo();
  return { commitment, docHash, revealed, closed, bond: bond === undefined ? undefined : Number(formatUnits(bond, decimals)) };
}

// Refunds, slashes (with evidence hashes) and the down payment happen in one transaction.
export async function escrowSettle(chainId, winner, slash, evidence, downPayment) {
  const { decimals } = await tokenInfo();
  if (downPayment > 0) await approveEscrow(process.env.BUYER_PRIVATE_KEY, downPayment);
  const { hash, logs } = await send(process.env.BUYER_PRIVATE_KEY, 'settle', [BigInt(chainId), winner, slash, evidence, parseUnits(String(downPayment), decimals)]);
  const events = logs.map((l) => ({ event: l.eventName, bidder: l.args.bidder ?? l.args.winner, amount: formatUnits(l.args.amount ?? l.args.downPayment ?? 0n, decimals), evidenceHash: l.args.evidenceHash }));
  return { hash, events };
}

// Reputation without a database: every evidence-backed slash of this bidder, read from the escrow's own events.
// A zero evidence hash means "never revealed", which is not proven manipulation, so it is reported separately.
// Tender ids restart at 1 on every escrow, so each entry names its escrow.
export async function slashHistory(bidder) {
  const out = [];
  for (const e of escrows().filter((x) => x.abi?.length)) out.push(...(await slashHistoryIn(e, bidder)));
  return out;
}
async function slashHistoryIn({ address, abi, block }, bidder) {
  const logs = await pub.getContractEvents({ address, abi, eventName: 'BondSlashed', args: { bidder }, fromBlock: BigInt(block ?? 0) });
  // The escrow is permissionless and doesn't check what an evidence hash proves, so the caller must decide whose
  // slashes to trust: each entry carries the buyer that opened (and therefore settled) that tender.
  const buyers = new Map();
  for (const id of new Set(logs.map((l) => l.args.id))) {
    const [buyer] = await pub.readContract({ address, abi, functionName: 'tenders', args: [id] });
    buyers.set(id, buyer);
  }
  return logs.map((l) => ({ escrow: address, tender: l.args.id.toString(), bidder: l.args.bidder, buyer: buyers.get(l.args.id), evidenceHash: l.args.evidenceHash, proven: BigInt(l.args.evidenceHash) !== 0n, tx: explorerTx(l.transactionHash) }));
}

export const escrowAddress = () => ESCROW();
export const explorerAddress = (a) => `${kiteTestnet.blockExplorers.default.url}/address/${a}`;
