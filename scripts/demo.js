import { runDemo } from '../src/demo.js';

const rfq = await runDemo((id) => console.log(`tender ${id} started`));
console.log(`\nphase: ${rfq.phase}`);
console.log('award:', JSON.stringify({ ...rfq.award, rationale: undefined }, null, 2));
console.log('\nrationale:\n' + (rfq.award?.rationale ?? '-'));
if (rfq.reppo) console.log('\nreppo:', rfq.reppo);
