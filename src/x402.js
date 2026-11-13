// x402 (v2, scheme "exact") on Kite testnet: Lelang as a paid service any x402 agent can pay, Kite Passport agents
// included. The payer signs an EIP-3009 transferWithAuthorization; the Pieverse facilitator (Kite's recommended one)
// verifies it and submits the transfer, paying the gas. We never hold the payer's key or funds before settlement.
import { formatUnits, parseUnits, parseSignature, createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

export const FACILITATOR = process.env.X402_FACILITATOR || 'https://facilitator.pieverse.io';
export const NETWORK = 'eip155:2368'; // Kite testnet
// Testnet PYUSD: EIP-3009 with v,r,s (the standard x402 "exact" form), self-mintable via claim() (10 PYUSD). 18 decimals on testnet.
export const ASSET = { address: process.env.X402_ASSET || '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9', name: 'PYUSD', version: '1', decimals: 18 };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

export function requirements({ amount, payTo, resource, description }) {
  return {
    scheme: 'exact', network: NETWORK, amount: parseUnits(String(amount), ASSET.decimals).toString(), asset: ASSET.address, payTo,
    maxTimeoutSeconds: 300, extra: { name: ASSET.name, version: ASSET.version }, resource, description, mimeType: 'application/json',
  };
}
export const paymentRequired = (req, error = 'payment required') =>
  ({ x402Version: 2, error, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepts: [req] });

// Payer side (our test agent, or any x402 client): sign the EIP-3009 authorization the requirements describe.
export async function pay(account, req) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: req.payTo, value: req.amount, validAfter: '0', validBefore: String(now + req.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString('hex')}` };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 2368, verifyingContract: req.asset },
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

// Seller side: check the header against OUR requirements (never the ones the payer echoes back), then verify and
// settle through the facilitator. Returns { payer, tx } once the money moved on-chain; throws a 402-able error otherwise.
export async function collect(header, req) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 402, paymentRequired: paymentRequired(req, msg) }); };
  if (!header) fail('payment required');
  let payload;
  try { payload = unb64(header); } catch { fail('PAYMENT-SIGNATURE is not base64 JSON'); }
  const a = payload?.payload?.authorization;
  if (!a || a.to?.toLowerCase() !== req.payTo.toLowerCase() || BigInt(a.value ?? 0) < BigInt(req.amount)) fail('payment does not match the requirements');
  const paymentPayload = { ...payload, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepted: req };
  const v = await facilitator('verify', paymentPayload, req);
  if (!v.isValid) fail(`payment rejected by facilitator: ${v.invalidReason ?? v.error ?? 'invalid'}`);
  const s = await facilitator('settle', paymentPayload, req);
  const amount = formatUnits(BigInt(req.amount), ASSET.decimals);
  if (s.success) return { payer: s.payer ?? a.from, tx: s.transaction, amount, settledBy: 'facilitator', receipt: b64(s) };
  // Fallback: the facilitator verified the signature but couldn't land the transfer (on Kite testnet it answers
  // "transaction_failed" without a tx; Kite's own gasless relayer was down too). The seller may act as its own
  // facilitator: we submit the payer's signed transferWithAuthorization and pay the gas. The simulation rejects a bad
  // signature, a spent nonce (also if the facilitator's attempt landed after all) or a short balance, so nothing is
  // charged twice and nothing is delivered unpaid.
  try {
    const tx = await selfSettle(a, payload.payload.signature, req.asset);
    return { payer: a.from, tx, amount, settledBy: 'seller (facilitator fallback)', receipt: b64({ success: true, transaction: tx, network: NETWORK, payer: a.from }) };
  } catch (e) {
    fail(`settlement failed: facilitator ${s.errorReason ?? s.error ?? 'unknown'}; self-settle ${e.shortMessage ?? e.message}`);
  }
}

const TWA_ABI = [{ type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [
  { type: 'address', name: 'from' }, { type: 'address', name: 'to' }, { type: 'uint256', name: 'value' }, { type: 'uint256', name: 'validAfter' },
  { type: 'uint256', name: 'validBefore' }, { type: 'bytes32', name: 'nonce' }, { type: 'uint8', name: 'v' }, { type: 'bytes32', name: 'r' }, { type: 'bytes32', name: 's' }] }];
async function selfSettle(a, signature, asset) {
  const { kiteTestnet } = await import('./kite.js');
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
  const { r, s, v } = parseSignature(signature);
  const { request } = await pub.simulateContract({ account, address: asset, abi: TWA_ABI, functionName: 'transferWithAuthorization',
    args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), r, s] });
  const hash = await createWalletClient({ account, chain: kiteTestnet, transport: http() }).writeContract(request);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`transferWithAuthorization reverted: ${hash}`);
  return hash;
}

// Client: call an x402 endpoint, paying once if it answers 402. `maxAmount` (token units) caps what we agree to pay.
export async function fetchPaying(url, init, account, maxAmount) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const terms = (await first.json()).accepts?.find((a) => a.scheme === 'exact' && a.network === NETWORK && a.asset.toLowerCase() === ASSET.address.toLowerCase());
  if (!terms) throw new Error('no payment option we can use');
  if (BigInt(terms.amount) > parseUnits(String(maxAmount), ASSET.decimals)) throw new Error(`asked ${formatUnits(BigInt(terms.amount), ASSET.decimals)}, our cap is ${maxAmount}`);
  return fetch(url, { ...init, headers: { ...init?.headers, 'payment-signature': await pay(account, terms) } });
}
