// Deploys LelangEscrow to Kite testnet, verifies its source on Kitescan (Blockscout API v2) and writes
// deployments/kite-testnet.json, which src/kite.js and the dashboard read.
//   npx hardhat compile && node --env-file=.env scripts/deploy-escrow.js [--verify-only]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { kiteTestnet, explorerTx } from '../src/kite.js';

const OUT = 'deployments/kite-testnet.json';
const art = JSON.parse(readFileSync('hh-artifacts/contracts/LelangEscrow.sol/LelangEscrow.json', 'utf8'));
const buildInfo = readdirSync('hh-artifacts/build-info').map((f) => JSON.parse(readFileSync(`hh-artifacts/build-info/${f}`, 'utf8')))
  // stale build-info files survive recompiles: take the one that produced the artifact we deploy
  .find((b) => '0x' + b.output.contracts['contracts/LelangEscrow.sol']?.LelangEscrow?.evm.bytecode.object === art.bytecode);

let deployment = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (!process.argv.includes('--verify-only')) {
  const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
  const w = createWalletClient({ account, chain: kiteTestnet, transport: http() });
  const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
  // success fees go to a treasury key of its own, kept apart from the buyer wallet so the fee flow is visible on-chain
  const keys = JSON.parse(readFileSync('data/agents/keys.json', 'utf8'));
  const treasury = privateKeyToAccount(keys.treasury ?? (keys.treasury = generatePrivateKey())).address;
  writeFileSync('data/agents/keys.json', JSON.stringify(keys, null, 2));
  const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [treasury] });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error('deploy reverted');
  deployment = {
    network: 'kite-testnet',
    chainId: kiteTestnet.id,
    explorer: kiteTestnet.blockExplorers.default.url,
    escrow: { address: rcpt.contractAddress, deployTx: hash, block: Number(rcpt.blockNumber), deployer: account.address, treasury },
    compiler: `v${buildInfo.solcLongVersion}`,
    abi: art.abi,
    // older escrows keep their tenders, slashes and proofs: reputation and the verifier still read them
    previous: deployment ? [{ escrow: deployment.escrow, abi: deployment.abi, verified: deployment.verified }, ...(deployment.previous ?? [])] : [],
  };
  mkdirSync('deployments', { recursive: true });
  writeFileSync(OUT, JSON.stringify(deployment, null, 2));
  console.log(`LelangEscrow at ${rcpt.contractAddress}\n${explorerTx(hash)}`);
}

// Source verification: standard JSON input, exactly what solc compiled.
const form = new FormData();
form.append('compiler_version', deployment.compiler);
form.append('license_type', 'mit');
form.append('contract_name', 'LelangEscrow');
form.append('autodetect_constructor_args', 'true');
form.append('files[0]', new Blob([JSON.stringify(buildInfo.input)], { type: 'application/json' }), 'input.json');
const api = `${deployment.explorer}/api/v2/smart-contracts/${deployment.escrow.address}/verification/via/standard-input`;
const res = await fetch(api, { method: 'POST', body: form });
console.log(`verification request: ${res.status} ${(await res.text()).slice(0, 200)}`);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const sc = await (await fetch(`${deployment.explorer}/api/v2/smart-contracts/${deployment.escrow.address}`)).json();
  if (sc.is_verified) {
    deployment.verified = `${deployment.explorer}/address/${deployment.escrow.address}?tab=contract`;
    writeFileSync(OUT, JSON.stringify(deployment, null, 2));
    console.log(`verified: ${deployment.verified}`);
    process.exit(0);
  }
}
console.log('not verified yet; rerun with --verify-only');
process.exit(1);
