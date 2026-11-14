// x402 from a browser wallet on Kite testnet: switch chain, sign an EIP-3009 TransferWithAuthorization (no gas),
// wrap it as the payment-signature header. Same flow as buy.js.
// ponytail: buy.js still carries its own copy (classic script); move it onto this module when buy.js becomes a module.
export const KITE = { chainId: '0x940', chainName: 'KiteAI Testnet', nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 }, rpcUrls: ['https://rpc-testnet.gokite.ai'], blockExplorerUrls: ['https://testnet.kitescan.ai'] };
export const PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

export async function wallet() {
  if (!window.ethereum) throw new Error('no browser wallet found (install MetaMask or a similar EVM wallet)');
  const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: KITE.chainId }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [KITE] });
  }
  return from;
}

// the testnet PYUSD contract mints 10 PYUSD to whoever calls claim(); returns the tx hash
export const claimPyusd = (from) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to: PYUSD, data: '0x4e71d92d' }] });

const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const hex32 = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
export async function payHeader(from, req) {
  const authorization = { from, to: req.payTo, value: req.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds), nonce: hex32() };
  const typed = {
    domain: { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(':')[1]), verifyingContract: req.asset },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };
  const signature = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] });
  return b64({ x402Version: 2, resource: { url: req.resource, description: req.description, mimeType: req.mimeType }, accepted: req, payload: { signature, authorization } });
}

// POST once to get the 402 terms, pay in PYUSD on Kite, POST again with the payment. Returns the parsed JSON body.
export async function paidPost(url, body, onStep = () => {}) {
  const from = await wallet();
  onStep('Asking for the payment terms (the API may take up to a minute to wake up)…');
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const first = await fetch(url, init);
  if (first.status !== 402) throw new Error(`expected a payment request, got ${first.status}: ${(await first.json().catch(() => ({}))).error ?? ''}`);
  const req = (await first.json()).accepts.find((a) => a.network === 'eip155:2368' && a.extra?.name === 'PYUSD');
  if (!req) throw new Error('no PYUSD-on-Kite payment option offered');
  onStep('Sign the payment in your wallet (an authorization, not a transaction)…');
  const header = await payHeader(from, req);
  onStep('Paid. The evaluator is reading your bid (five model calls, about 20 seconds)…');
  const res = await fetch(url, { ...init, headers: { ...init.headers, 'payment-signature': header } });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error ?? `status ${res.status}`);
  return out;
}
