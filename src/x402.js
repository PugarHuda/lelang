// x402 (v2, scheme "exact"): Lelang as a paid service any x402 agent can pay. The payer signs an EIP-3009
// transferWithAuthorization and needs no gas; we never hold its key or its funds before settlement.
// Two ways to pay, offered side by side in every 402:
//  - Kite testnet PYUSD, settled by the Pieverse facilitator (Kite's recommended one), or by us if it can't;
//  - Arc testnet USDC: the only testnet Kite Passport pays on today (its x402-execute skill: "exact-scheme USDC ...
//    Arc testnet (eip155:5042002) on dev"); Pieverse doesn't serve Arc, so we settle it ourselves.
import { formatUnits, parseUnits, parseSignature, createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const SEEN = process.env.X402_SEEN || 'data/x402-nonces.json'; // every accepted payment, by network:payer:nonce
const seen = new Set(existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : []);

export const FACILITATOR = process.env.X402_FACILITATOR || 'https://facilitator.pieverse.io';
const chain = (id, name, rpc, native) => defineChain({ id, name, nativeCurrency: native, rpcUrls: { default: { http: [rpc] } } });
export const OPTIONS = [
  // Testnet PYUSD: EIP-3009 with v,r,s, self-mintable via claim() (10 PYUSD), 18 decimals on testnet.
  { network: 'eip155:2368', chain: chain(2368, 'KiteAI Testnet', 'https://rpc-testnet.gokite.ai', { name: 'KITE', symbol: 'KITE', decimals: 18 }),
    asset: process.env.X402_ASSET || '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9', name: 'PYUSD', version: '1', decimals: 18, facilitator: true,
    label: 'Kite testnet', explorer: 'https://testnet.kitescan.ai' },
  // Kite testnet pieUSD: what a Kite Passport pays with on its testnet (dev) environment; its own test merchant
  // (passport.dev.gokite.ai/x402/test) asks for exactly this. EIP-3009 with a bytes signature instead of v,r,s.
  { network: 'eip155:2368', chain: chain(2368, 'KiteAI Testnet', 'https://rpc-testnet.gokite.ai', { name: 'KITE', symbol: 'KITE', decimals: 18 }),
    asset: '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A', name: 'pieUSD', version: '1', decimals: 18, facilitator: true, sigBytes: true,
    label: 'Kite testnet', explorer: 'https://testnet.kitescan.ai' },
  // Arc testnet USDC (Circle FiatToken v2, EIP-3009). Gas on Arc is paid in USDC, so the seller wallet needs some.
  { network: 'eip155:5042002', chain: chain(5042002, 'Arc Testnet', 'https://rpc.testnet.arc.network', { name: 'USDC', symbol: 'USDC', decimals: 18 }),
    asset: '0x3600000000000000000000000000000000000000', name: 'USDC', version: '2', decimals: 6, facilitator: false,
    label: 'Arc testnet', explorer: 'https://testnet.arcscan.app' },
  // Base mainnet USDC, real money: what a production Kite Passport pays with ("exact-scheme USDC x402 ... Base mainnet").
  // Opt-in (X402_BASE=1), facilitator only: we hold no ETH on Base, so there is no self-settle fallback here.
  ...(process.env.X402_BASE === '1' ? [{ network: 'eip155:8453', chain: chain(8453, 'Base', 'https://mainnet.base.org', { name: 'Ether', symbol: 'ETH', decimals: 18 }),
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', decimals: 6, facilitator: true, noSelfSettle: true,
    label: 'Base mainnet', explorer: 'https://basescan.org' }] : []),
];
export const NETWORK = OPTIONS[0].network;
export const ASSET = { address: OPTIONS[0].asset, name: OPTIONS[0].name, version: OPTIONS[0].version, decimals: OPTIONS[0].decimals };
const optionOf = (req) => OPTIONS.find((o) => o.network === req?.network && o.asset.toLowerCase() === String(req?.asset).toLowerCase());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

// One payment option's terms (default: Kite testnet PYUSD).
export function requirements({ amount, payTo, resource, description }, o = OPTIONS[0]) {
  return {
    scheme: 'exact', network: o.network, amount: parseUnits(String(amount), o.decimals).toString(), asset: o.asset, payTo,
    maxTimeoutSeconds: 300, extra: { name: o.name, version: o.version }, resource, description, mimeType: 'application/json',
  };
}
// Every option we accept, same price in each stablecoin.
export const allRequirements = (terms) => OPTIONS.map((o) => requirements(terms, o));
const list = (reqs) => (Array.isArray(reqs) ? reqs : [reqs]);
export const paymentRequired = (reqs, error = 'payment required') => {
  const [r] = list(reqs);
  return { x402Version: 2, error, resource: { url: r.resource, description: r.description, mimeType: r.mimeType }, accepts: list(reqs) };
};

// Payer side (our test agent, or any x402 client): sign the EIP-3009 authorization the requirements describe.
export async function pay(account, req) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: req.payTo, value: req.amount, validAfter: '0', validBefore: String(now + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString('hex')}` };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(':')[1]), verifyingContract: req.asset },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  return b64({ x402Version: 2, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepted: req, payload: { signature, authorization } });
}

async function facilitator(path, paymentPayload, paymentRequirements) {
  const res = await fetch(`${FACILITATOR}/v2/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) });
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok, ...out };
}

// Seller side: the payer says which option it paid with; we take OUR terms for that option (never the ones it echoes
// back), check payee and amount, then settle. Returns { payer, tx, network, asset } once the money moved on-chain;
// throws a 402-able error otherwise.
export async function collect(header, reqs) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 402, paymentRequired: paymentRequired(reqs, msg) }); };
  if (!header) fail('payment required');
  let payload;
  try { payload = unb64(header); } catch { fail('PAYMENT-SIGNATURE is not base64 JSON'); }
  const req = list(reqs).find((r) => r.network === payload?.accepted?.network && r.asset.toLowerCase() === String(payload?.accepted?.asset).toLowerCase()) ?? list(reqs)[0];
  const o = optionOf(req);
  const a = payload?.payload?.authorization;
  if (!a || a.to?.toLowerCase() !== req.payTo.toLowerCase() || BigInt(a.value ?? 0) < BigInt(req.amount)) fail('payment does not match the requirements');
  // A payment header buys one thing, once. The nonce is reserved before any await (two parallel requests with the same
  // header can't both pass) and released only if this payment fails. A spent nonce is never taken as proof of payment:
  // a replayed or cancelled authorization also reads as spent on-chain.
  const key = `${o.network}:${String(a.from).toLowerCase()}:${String(a.nonce).toLowerCase()}`;
  if (seen.has(key)) fail('this payment was already used');
  seen.add(key);
  try {
    const out = await settleOnce(payload, req, o, a, reqs);
    // the money has moved: a failed write must not release the nonce (it stays reserved in memory either way)
    try { writeFileSync(SEEN, JSON.stringify([...seen])); } catch (e) { console.error(`x402: could not persist nonce ${key}: ${e.message}`); }
    return out;
  } catch (e) {
    seen.delete(key);
    throw e;
  }
}

async function settleOnce(payload, req, o, a, reqs) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 402, paymentRequired: paymentRequired(reqs, msg) }); };
  const amount = formatUnits(BigInt(req.amount), o.decimals);
  const paid = (tx, settledBy, receipt) => ({ payer: a.from, tx, txUrl: tx ? `${o.explorer}/tx/${tx}` : null, amount, asset: o.name, network: o.label, settledBy, receipt: b64(receipt) });
  let s = {};
  if (o.facilitator) {
    const paymentPayload = { ...payload, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepted: req };
    const v = await facilitator('verify', paymentPayload, req);
    if (!v.isValid) fail(`payment rejected by facilitator: ${v.invalidReason ?? v.error ?? 'invalid'}`);
    s = await facilitator('settle', paymentPayload, req);
    if (s.success) return { ...paid(s.transaction, 'facilitator', s), payer: s.payer ?? a.from };
    if (o.noSelfSettle) fail(`settlement failed: facilitator ${s.errorReason ?? s.error ?? 'unknown'}`);
  }
  // Fallback (or the only path, where no facilitator serves the network): the facilitator verified the signature but
  // couldn't land the transfer (on Kite testnet it answers "transaction_failed" without a tx; Kite's own gasless relayer
  // was down too). The seller may act as its own facilitator: we submit the payer's signed transferWithAuthorization
  // and pay the gas. The simulation rejects a bad signature, a spent nonce or a short balance, so nothing is charged
  // twice and nothing is delivered unpaid. (If the facilitator's own tx lands late, our simulation fails and the payer
  // gets a 402 although it paid: rare, never in our favour, and the tx is on-chain for a manual refund.)
  try {
    const tx = await selfSettle(a, payload.payload.signature, o);
    return paid(tx, o.facilitator ? 'seller (facilitator fallback)' : 'seller (no facilitator on this network)', { success: true, transaction: tx, network: o.network, payer: a.from });
  } catch (e) {
    fail(`settlement failed: ${o.facilitator ? `facilitator ${s.errorReason ?? s.error ?? 'unknown'}; ` : ''}self-settle ${e.shortMessage ?? e.message}`);
  }
}

const AUTH_FIELDS = [{ type: 'address', name: 'from' }, { type: 'address', name: 'to' }, { type: 'uint256', name: 'value' }, { type: 'uint256', name: 'validAfter' },
  { type: 'uint256', name: 'validBefore' }, { type: 'bytes32', name: 'nonce' }];
const TWA_ABI = [{ type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [...AUTH_FIELDS, { type: 'uint8', name: 'v' }, { type: 'bytes32', name: 'r' }, { type: 'bytes32', name: 's' }] }];
// the other EIP-3009 form (pieUSD): one bytes signature instead of v, r, s
const TWA_BYTES_ABI = [{ type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [...AUTH_FIELDS, { type: 'bytes', name: 'signature' }] }];
// #2 in the review: if we took a payment and then couldn't deliver (e.g. the escrow tx failed), send it back.
export async function refund(payment) {
  const o = OPTIONS.find((x) => x.label === payment.network && x.name === payment.asset); // two tokens share Kite testnet
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  const hash = await createWalletClient({ account, chain: o.chain, transport: http() }).writeContract({ address: o.asset, functionName: 'transfer', args: [payment.payer, parseUnits(payment.amount, o.decimals)],
    abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }] });
  await createPublicClient({ chain: o.chain, transport: http() }).waitForTransactionReceipt({ hash });
  return `${o.explorer}/tx/${hash}`;
}

async function selfSettle(a, signature, o) {
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  const pub = createPublicClient({ chain: o.chain, transport: http() });
  const auth = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce];
  const { r, s, v } = parseSignature(signature);
  const { request } = await pub.simulateContract(o.sigBytes
    ? { account, address: o.asset, abi: TWA_BYTES_ABI, functionName: 'transferWithAuthorization', args: [...auth, signature] }
    : { account, address: o.asset, abi: TWA_ABI, functionName: 'transferWithAuthorization', args: [...auth, Number(v), r, s] });
  const hash = await createWalletClient({ account, chain: o.chain, transport: http() }).writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`transferWithAuthorization reverted: ${hash}`);
  return hash;
}

// Client: call an x402 endpoint, paying once if it answers 402. `maxAmount` (token units) caps what we agree to pay;
// `network` picks which of the offered options to pay with.
export async function fetchPaying(url, init, account, maxAmount, network = NETWORK) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const terms = (await first.json()).accepts?.find((a) => a.scheme === 'exact' && a.network === network && optionOf(a));
  if (!terms) throw new Error(`no payment option on ${network}`);
  const { decimals } = optionOf(terms);
  if (BigInt(terms.amount) > parseUnits(String(maxAmount), decimals)) throw new Error(`asked ${formatUnits(BigInt(terms.amount), decimals)}, our cap is ${maxAmount}`);
  return fetch(url, { ...init, headers: { ...init?.headers, 'payment-signature': await pay(account, terms) } });
}
