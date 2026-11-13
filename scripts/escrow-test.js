// LelangEscrow on Kite testnet: every forbidden path must revert (checked with free eth_call simulations),
// the happy path must move the bond back to the bidder.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, keccak256, toHex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { kiteTestnet, escrowOpen, escrowCommit, escrowCloseCommits, escrowReveal, escrowBid, escrowSettle, transferPie, balances, sendGas, tokenInfo, TOKEN } from '../src/kite.js';
import { commitHash, docHashOf } from '../src/lelang.js';
import { demoWallets } from '../src/demo.js';

const { abi } = JSON.parse(readFileSync(new URL('../deployments/kite-testnet.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
const buyerPk = process.env.BUYER_PRIVATE_KEY;
const buyer = privateKeyToAccount(buyerPk);
const supPk = demoWallets().suppliers[0];
const sup = privateKeyToAccount(supPk);
const BOND = 0.1;

async function reverts(account, functionName, args, errorName) {
  try {
    await pub.simulateContract({ address: (process.env.ESCROW_ADDRESS || JSON.parse(readFileSync(new URL('../deployments/kite-testnet.json', import.meta.url), 'utf8')).escrow.address), abi, functionName, args, account });
  } catch (e) {
    const got = e.cause?.data?.errorName ?? e.shortMessage;
    assert.ok(String(got).includes(errorName), `${functionName}: expected ${errorName}, got ${got}`);
    console.log(`  reverts as expected: ${functionName} -> ${errorName}`);
    return;
  }
  assert.fail(`${functionName} should have reverted with ${errorName}`);
}

// fund the bidder for one bond + gas
const bal = await balances(sup.address);
if (Number(bal.kite) < 0.01) await sendGas(buyerPk, sup.address, '0.01');
if (Number(Object.entries(bal).find(([k]) => k !== 'kite')[1]) < BOND) await transferPie(buyerPk, sup.address, BOND);

const { chainId } = await escrowOpen(BOND);
const id = BigInt(chainId);
console.log(`escrow tender #${chainId}`);
const doc = 'escrow test bid';
const salt = `0x${randomBytes(32).toString('hex')}`;
const commitment = commitHash(doc, salt, sup.address, chainId);
const onChainCommitment = await pub.readContract({ address: (process.env.ESCROW_ADDRESS || JSON.parse(readFileSync(new URL('../deployments/kite-testnet.json', import.meta.url), 'utf8')).escrow.address), abi, functionName: 'commitmentOf', args: [docHashOf(doc), salt, sup.address, id] });
assert.equal(onChainCommitment, commitment, 'JS and Solidity commitments must match');

await escrowCommit(supPk, chainId, commitment);
await reverts(sup, 'commit', [id, commitment, 1n], 'AlreadyCommitted');
await reverts(buyer, 'commit', [id, commitment, 10n ** 30n], 'NotBidder'); // buyer can't bid into its own tender
await reverts(sup, 'reveal', [id, docHashOf(doc), salt], 'WrongPhase'); // commits still open
await reverts(sup, 'closeCommits', [id], 'NotBuyer');
await escrowCloseCommits(chainId);
await reverts(buyer, 'settle', [id, sup.address, [], [], 0n], 'WrongPhase'); // can't settle (and auto-slash) before bidders reveal
await reverts(sup, 'reveal', [id, docHashOf('a different document'), salt], 'BadReveal');
await reverts(sup, 'reveal', [id, docHashOf(doc), `0x${'11'.repeat(32)}`], 'BadReveal');
await escrowReveal(supPk, chainId, docHashOf(doc), salt);
assert.equal((await escrowBid(chainId, sup.address)).revealed, true);
await reverts(sup, 'settle', [id, sup.address, [], [], 0n], 'NotBuyer');
await reverts(buyer, 'settle', [id, sup.address, [sup.address], [keccak256(toHex('x'))], 0n], 'InvalidWinner');
await reverts(buyer, 'settle', [id, sup.address, [sup.address], [], 0n], 'MissingEvidence');
await reverts(buyer, 'settle', [id, buyer.address, [], [], 0n], 'InvalidWinner'); // never bid
await reverts(sup, 'withdraw', [id], 'WrongPhase'); // settle window still open

const { decimals } = await tokenInfo();
const before = await pub.readContract({ address: TOKEN, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [sup.address] });
const { events } = await escrowSettle(chainId, sup.address, [], [], 0);
const after = await pub.readContract({ address: TOKEN, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [sup.address] });
assert.equal(after - before, parseUnits(String(BOND), decimals), 'bond refunded to bidder');
assert.deepEqual(events.map((e) => e.event), ['BondRefunded', 'Awarded']);
await reverts(buyer, 'settle', [id, sup.address, [], [], 0n], 'WrongPhase'); // cannot settle twice
console.log('escrow-test OK');
