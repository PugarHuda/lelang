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

// One 32-byte hash on Kite: a 0-value tx to self with data "LELANG" (0x4c454c414e47) + hash. public/verify.js reads it back.
export async function anchorHash(pk, hash) {
  const w = wallet(pk);
  return confirm(await w.sendTransaction({ to: w.account.address, value: 0n, data: concat(['0x4c454c414e47', hash]) }));
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

// SUCCESS_FEE_BPS: the buyer's agreed success fee (basis points of the down payment), paid to the escrow's treasury at
// settle. Escrows before V3 have no fee parameter.
export const successFeeBps = () => Number(process.env.SUCCESS_FEE_BPS ?? 200);
const hasFee = () => ESCROW_ABI.some((f) => f.name === 'open' && f.inputs.length === 6);
export async function escrowOpen(bond, { commitSeconds = 3600, revealSeconds = 3600, settleSeconds = 86400 } = {}) {
  const { decimals } = await tokenInfo();
  const { hash, logs } = await send(process.env.BUYER_PRIVATE_KEY, 'open', [TOKEN, parseUnits(String(bond), decimals), BigInt(commitSeconds), BigInt(revealSeconds), BigInt(settleSeconds), ...(hasFee() ? [successFeeBps()] : [])]);
  return { chainId: logs.find((l) => l.eventName === 'TenderOpened').args.id.toString(), tx: hash };
}

// Token and bond amount come from the tender on-chain, not from local config: an outside bidder may not share
// our STABLE_TOKEN, and approving the wrong token makes commit revert with ERC20InsufficientAllowance.
// `amount` (token units, e.g. '0.1') posts more than the tender bond: what a bidder with a slashing history is asked for.
// `maxAmount` caps what is actually locked (the quote or, without one, the tender's own on-chain bond).
export async function escrowCommit(pk, chainId, commitment, amount, { maxAmount } = {}) {
  const [, token, bond] = await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'tenders', args: [BigInt(chainId)] });
  const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  const posted = amount ? parseUnits(String(amount), decimals) : bond;
  if (posted < bond) throw new Error(`bond ${amount} is below the tender minimum ${formatUnits(bond, decimals)}`);
  if (maxAmount != null && posted > parseUnits(String(maxAmount), decimals)) throw new Error(`bond ${formatUnits(posted, decimals)} is above this bidder's cap of ${maxAmount}`);
  await confirm(await wallet(pk).writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [ESCROW(), posted] }));
  return (await send(pk, 'commit', [BigInt(chainId), commitment, posted])).hash;
}

export const escrowCloseCommits = async (chainId) => (await send(process.env.BUYER_PRIVATE_KEY, 'closeCommits', [BigInt(chainId)])).hash;
export const escrowReveal = async (pk, chainId, docHash, salt) => (await send(pk, 'reveal', [BigInt(chainId), docHash, salt])).hash;
// Safety valve: after an unsettled tender's settle deadline, a bidder takes its own bond back.
// `escrow` picks an older contract (a tender opened before an upgrade); default is the current one.
export const escrowWithdraw = async (pk, chainId, escrow) => (await send(pk, 'withdraw', [BigInt(chainId)], escrowFor(escrow))).hash;

// Reveal deadline of a tender and the chain's current time (the contract's clock, not ours).
// Read from the escrow that holds the tender (it may predate an upgrade); an unknown tender fails closed.
export async function escrowTimes(chainId, escrow) {
  const e = escrowFor(escrow);
  if (!e) throw new Error(`unknown escrow ${escrow}`);
  const [t, block] = await Promise.all([pub.readContract({ address: e.address, abi: e.abi, functionName: 'tenders', args: [BigInt(chainId)] }), pub.getBlock()]);
  if (!t[4]) throw new Error(`tender #${chainId} not found on escrow ${e.address}`);
  return { revealDeadline: t[4], now: block.timestamp };
}

// `bond` is what this bidder locked (V2 escrow); undefined on the first escrow, where it always equals the tender bond.
export async function escrowBid(chainId, bidder) {
  const [commitment, docHash, revealed, closed, bond] = await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'bids', args: [BigInt(chainId), bidder] });
  const { decimals } = await tokenInfo();
  return { commitment, docHash, revealed, closed, bond: bond === undefined ? undefined : Number(formatUnits(bond, decimals)) };
}

// V4 escrow: slashes wait out a challenge window and forfeits go to a bounty pool, never to the buyer.
export const escrowV4 = (abi = ESCROW_ABI) => abi.some((f) => f.name === 'finalizeSlash');

// Refunds, slashes (with evidence hashes) and the down payment happen in one transaction. On V4 the balance of the
// price (`balance`) is also locked here, until the buyer confirms delivery.
export async function escrowSettle(chainId, winner, slash, evidence, downPayment, { balance = 0, deliverySeconds = 0 } = {}) {
  const { decimals } = await tokenInfo();
  // the escrow pulls the down payment and, in the same tx, the success fee agreed at open
  const feeBps = hasFee() ? Number((await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'tenders', args: [BigInt(chainId)] }))[9]) : 0;
  const v4 = escrowV4();
  const withFee = (x) => x + (x * BigInt(feeBps)) / 10_000n; // integer math, same rounding as the contract
  const dp = parseUnits(String(downPayment), decimals), bal = v4 ? parseUnits(String(balance), decimals) : 0n;
  if (dp > 0n || bal > 0n) {
    await confirm(await wallet(process.env.BUYER_PRIVATE_KEY).writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [ESCROW(), withFee(dp) + withFee(bal)] }));
  }
  const { hash, logs } = await send(process.env.BUYER_PRIVATE_KEY, 'settle', [BigInt(chainId), winner, slash, evidence, dp, ...(v4 ? [bal, BigInt(deliverySeconds)] : [])]);
  const events = logs.map((l) => ({ event: l.eventName, bidder: l.args.bidder ?? l.args.winner ?? l.args.treasury, amount: formatUnits(l.args.amount ?? l.args.downPayment ?? l.args.balance ?? 0n, decimals), evidenceHash: l.args.evidenceHash, ...(l.args.finalAt && { finalAt: Number(l.args.finalAt) }), ...(l.args.deadline && { deadline: Number(l.args.deadline) }) }));
  return { hash, events };
}

// A pending slash on a V4 escrow: `finalAt` 0 means none (finalized, overturned or never listed).
export async function escrowPending(chainId, bidder, escrow) {
  const e = escrowFor(escrow);
  if (!e || !escrowV4(e.abi)) return { finalAt: 0 };
  const [[finalAt, evidence], block] = await Promise.all([pub.readContract({ address: e.address, abi: e.abi, functionName: 'pendingSlash', args: [BigInt(chainId), bidder] }), pub.getBlock()]);
  return { finalAt: Number(finalAt), evidence, now: Number(block.timestamp) };
}
// Anyone may finalize after the window; we send it from the buyer wallet only because it has gas.
export const escrowFinalizeSlash = async (chainId, bidder, escrow) => send(process.env.BUYER_PRIVATE_KEY, 'finalizeSlash', [BigInt(chainId), bidder], escrowFor(escrow));
// An approver's own vote to overturn: `quorum` of them must send it inside the window.
export const escrowOverturn = async (pk, chainId, bidder, escrow) => send(pk, 'overturnSlash', [BigInt(chainId), bidder], escrowFor(escrow));
// The escrow's own approver quorum (V4), so the off-chain record never claims fewer signatures than the chain needs.
export const escrowQuorum = async (escrow) => Number(await pub.readContract({ ...pick(escrow), functionName: 'quorum' }));
const pick = (escrow) => { const e = escrowFor(escrow); return { address: e.address, abi: e.abi }; };
// Did this tx overturn `bidder`'s slash in tender `chainId` on that escrow? Read from the receipt, not from the caller.
export async function overturnedIn(txHash, chainId, bidder, escrow) {
  const { address, abi } = pick(escrow);
  const rcpt = await pub.getTransactionReceipt({ hash: txHash });
  return rcpt.status === 'success' && parseEventLogs({ abi, logs: rcpt.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()) })
    .some((l) => l.eventName === 'SlashOverturned' && l.args.id === BigInt(chainId) && l.args.bidder.toLowerCase() === bidder.toLowerCase());
}
export const escrowConfirmDelivery = async (chainId, escrow) => send(process.env.BUYER_PRIVATE_KEY, 'confirmDelivery', [BigInt(chainId)], escrowFor(escrow));
export async function escrowDelivery(chainId, escrow) {
  const e = escrowFor(escrow);
  if (!e || !escrowV4(e.abi)) return null;
  const [winner, balance, fee, deadline, closed] = await pub.readContract({ address: e.address, abi: e.abi, functionName: 'deliveries', args: [BigInt(chainId)] });
  const { decimals } = await tokenInfo();
  return { winner, balance: formatUnits(balance, decimals), fee: formatUnits(fee, decimals), deadline: Number(deadline), closed };
}
// Forfeited bonds waiting to pay bounties, in the tender token.
export async function bountyPool() {
  if (!escrowV4()) return null;
  const { decimals } = await tokenInfo();
  return Number(formatUnits(await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'bountyPool', args: [TOKEN] }), decimals));
}
// Treasury pays a bounty out of the pool: one payment per evidence hash, never above the pool (enforced on-chain).
export async function escrowPayBounty(pk, to, amount, evidenceHash) {
  const { decimals } = await tokenInfo();
  return send(pk, 'payBounty', [TOKEN, to, parseUnits(String(amount), decimals), evidenceHash]);
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
