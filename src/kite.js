// Kite testnet: commit anchoring, bonds and settlement in a stablecoin.
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, erc20Abi, toHex, concat, parseEventLogs } from 'viem';
import { readFileSync } from 'node:fs';
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

const ESCROW_ABI = JSON.parse(readFileSync(new URL('../artifacts/LelangEscrow.json', import.meta.url), 'utf8')).abi;
export const escrowEnabled = () => kiteEnabled() && Boolean(process.env.ESCROW_ADDRESS);
const ESCROW = () => process.env.ESCROW_ADDRESS;

async function send(pk, functionName, args) {
  const w = wallet(pk);
  const hash = await w.writeContract({ address: ESCROW(), abi: ESCROW_ABI, functionName, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, logs: parseEventLogs({ abi: ESCROW_ABI, logs: rcpt.logs }) };
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

export async function escrowCommit(pk, chainId, commitment, bond) {
  await approveEscrow(pk, bond);
  return (await send(pk, 'commit', [BigInt(chainId), commitment])).hash;
}

export const escrowCloseCommits = async (chainId) => (await send(process.env.BUYER_PRIVATE_KEY, 'closeCommits', [BigInt(chainId)])).hash;
export const escrowReveal = async (pk, chainId, docHash, salt) => (await send(pk, 'reveal', [BigInt(chainId), docHash, salt])).hash;

export async function escrowBid(chainId, bidder) {
  const [commitment, docHash, revealed, closed] = await pub.readContract({ address: ESCROW(), abi: ESCROW_ABI, functionName: 'bids', args: [BigInt(chainId), bidder] });
  return { commitment, docHash, revealed, closed };
}

// Refunds, slashes (with evidence hashes) and the down payment happen in one transaction.
export async function escrowSettle(chainId, winner, slash, evidence, downPayment) {
  const { decimals } = await tokenInfo();
  if (downPayment > 0) await approveEscrow(process.env.BUYER_PRIVATE_KEY, downPayment);
  const { hash, logs } = await send(process.env.BUYER_PRIVATE_KEY, 'settle', [BigInt(chainId), winner, slash, evidence, parseUnits(String(downPayment), decimals)]);
  const events = logs.map((l) => ({ event: l.eventName, bidder: l.args.bidder ?? l.args.winner, amount: formatUnits(l.args.amount ?? l.args.downPayment ?? 0n, decimals), evidenceHash: l.args.evidenceHash }));
  return { hash, events };
}

export const escrowAddress = () => process.env.ESCROW_ADDRESS;
export const explorerAddress = (a) => `${kiteTestnet.blockExplorers.default.url}/address/${a}`;
