// Deploys LelangEscrow to Kite testnet from the buyer key and saves ESCROW_ADDRESS into .env.
import { readFileSync, appendFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { kiteTestnet, explorerTx } from '../src/kite.js';

const { abi, bytecode } = JSON.parse(readFileSync('artifacts/LelangEscrow.json', 'utf8'));
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const w = createWalletClient({ account, chain: kiteTestnet, transport: http() });
const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
const hash = await w.deployContract({ abi, bytecode });
const { contractAddress, status } = await pub.waitForTransactionReceipt({ hash });
if (status !== 'success') throw new Error('deploy reverted');
appendFileSync('.env', `ESCROW_ADDRESS=${contractAddress}\n`);
console.log(`LelangEscrow at ${contractAddress}\n${explorerTx(hash)}`);
