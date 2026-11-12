// Compiles contracts/LelangEscrow.sol with solc-js into artifacts/LelangEscrow.json (abi + bytecode).
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';

const input = {
  language: 'Solidity',
  sources: { 'LelangEscrow.sol': { content: readFileSync('contracts/LelangEscrow.sol', 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
for (const w of out.errors ?? []) console.warn(w.formattedMessage);
const c = out.contracts['LelangEscrow.sol'].LelangEscrow;
writeFileSync('artifacts/LelangEscrow.json', JSON.stringify({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 2));
console.log(`compiled: ${c.evm.bytecode.object.length / 2} bytes`);
