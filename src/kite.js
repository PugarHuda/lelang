// Kite testnet: commit anchoring, bonds and settlement in a stablecoin.
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, erc20Abi, toHex, concat } from 'viem';
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
