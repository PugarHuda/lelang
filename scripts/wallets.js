// Creates a testnet buyer key in .env if missing, then prints buyer + supplier addresses and balances.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { balances } from '../src/kite.js';
import { demoWallets } from '../src/demo.js';

let pk = process.env.BUYER_PRIVATE_KEY;
if (!pk) {
  pk = generatePrivateKey();
  const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  appendFileSync('.env', `${env && !env.endsWith('\n') ? '\n' : ''}BUYER_PRIVATE_KEY=${pk}\n`);
  console.log('Created a new TESTNET buyer key in .env');
}
const buyer = privateKeyToAccount(pk).address;
console.log(`buyer   ${buyer}`, await balances(buyer));
console.log('Fund the buyer at https://faucet.gokite.ai (KITE for gas + pieUSD).\n');
for (const [i, s] of demoWallets().suppliers.entries()) {
  const a = privateKeyToAccount(s).address;
  console.log(`supplier ${i + 1} ${a}`, await balances(a));
}
