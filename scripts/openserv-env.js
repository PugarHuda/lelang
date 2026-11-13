// Writes the env file to upload to the host that runs the OpenServ agent: the provision state (base64) and the switch.
//   node scripts/openserv-env.js <out file>
import { readFileSync, writeFileSync } from 'node:fs';
const out = process.argv[2];
const state = readFileSync('.openserv.json', 'utf8');
writeFileSync(out, `OPENSERV_AGENT=1\nOPENSERV_STATE=${Buffer.from(state).toString('base64')}\nOPENSERV_USER_API_KEY=${JSON.parse(state).userApiKey}\n`);
console.log(`wrote ${out}`);
