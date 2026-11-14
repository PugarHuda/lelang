// Ambiguity check regression on the live readers: the tender #5 false hold must pass, the red-team gaps must still be held.
//   node --env-file=.env scripts/ambiguity-regression.js
import { statedAlternatives } from '../src/ai.js';
import { ambiguousTerms } from '../src/lelang.js';
const cases = [
  ['tender #5 (false hold before the fix)', false, 'Total price: USD 7,900 for all 10 projectors, delivered.\nDelivery: 14 days after award.\nWarranty: 36 months.\nAfter-sales: lamp replacement within 3 working days.'],
  ['on-site repair response time', false, 'Total: USD 41,000.\nDelivery: 20 days.\nWarranty: 24 months, on-site repair within 48 hours (2 days).'],
  ['red team: two delivery figures', true, 'Total: USD 52,000.\nDelivery: 18 calendar days (committed: 11 working days).\nWarranty: 24 months.'],
  ['red team: list vs rebated total', true, 'List price USD 75,000; payable total USD 58,500 after rebate.\nDelivery: 15 days.\nWarranty: 24 months.'],
];
let fail = 0;
for (const [name, expect, doc] of cases) {
  const got = ambiguousTerms(await statedAlternatives(doc));
  const ok = (got.length > 0) === expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got.length ? got.map((x) => `${x.field} ${x.values.join('/')}`).join(', ') : 'not ambiguous'}`);
}
process.exitCode = fail ? 1 : 0;
