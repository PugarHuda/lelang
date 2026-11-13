// V4 escrow housekeeping, run from the operator's machine (the server also does the first part on a timer):
//   node --env-file=.env scripts/finalize.js                  finalize every slash whose challenge window has passed
//   node --env-file=.env scripts/finalize.js --confirm <rfq>  the buyer confirms delivery: the escrow pays the held balance
import { finalizeDue, confirmDelivery } from '../src/lelang.js';
import { bountyPool } from '../src/kite.js';

const i = process.argv.indexOf('--confirm');
if (i > 0) console.log('delivery', await confirmDelivery(process.argv[i + 1]));
console.log('finalized', await finalizeDue());
console.log('bounty pool', await bountyPool());
