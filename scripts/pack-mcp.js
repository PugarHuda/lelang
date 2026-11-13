// Builds the npm package `lelang-mcp` (the supplier-agent MCP server) from the repo's own sources into packages/lelang-mcp.
//   node scripts/pack-mcp.js && cd packages/lelang-mcp && npm publish
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';

const OUT = 'packages/lelang-mcp';
rmSync(OUT, { recursive: true, force: true });
for (const d of ['src', 'deployments']) mkdirSync(`${OUT}/${d}`, { recursive: true });
for (const f of ['src/mcp.js', 'src/commitment.js', 'src/kite.js', 'deployments/kite-testnet.json', 'LICENSE']) { try { copyFileSync(f, `${OUT}/${f}`); } catch {} }
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const dep = (n) => root.dependencies[n];
writeFileSync(`${OUT}/package.json`, JSON.stringify({
  name: 'lelang-mcp', version: process.env.VERSION || '1.0.0',
  description: 'MCP server for supplier agents in Lelang sealed-bid tenders on Kite: find tenders, get your bond quote, bid with a sealed commitment and reveal, holding only your own key.',
  type: 'module', bin: { 'lelang-mcp': 'src/mcp.js' }, files: ['src', 'deployments'], engines: { node: '>=22' },
  keywords: ['mcp', 'agents', 'procurement', 'tender', 'kite', 'x402', 'sealed-bid'],
  repository: { type: 'git', url: 'https://github.com/PugarHuda/lelang' }, homepage: 'https://lelang-ten.vercel.app', license: 'MIT',
  dependencies: { '@modelcontextprotocol/sdk': dep('@modelcontextprotocol/sdk'), viem: dep('viem'), zod: dep('zod') },
}, null, 2) + '\n');
writeFileSync(`${OUT}/README.md`, `# lelang-mcp

MCP server for **supplier agents** in [Lelang](https://github.com/PugarHuda/lelang) tenders: sealed bids with bonds in an escrow on Kite testnet, where text aimed at the AI evaluator gets the bond slashed with on-chain evidence.

\`\`\`json
{ "mcpServers": { "lelang": { "command": "npx", "args": ["-y", "lelang-mcp"],
  "env": { "SUPPLIER_PRIVATE_KEY": "0x…" } } } }
\`\`\`

Tools: \`list_tenders\`, \`get_tender\`, \`bond_quote\`, \`wallet\`, \`submit_bid\`, \`reveal_bid\`, \`my_bids\`.

- Talks to the public API (\`https://lelang-6k05.onrender.com\`) unless \`LELANG_URL\` says otherwise.
- Your key never leaves the process. Salts are saved to \`~/.lelang/bids.json\` (\`LELANG_BIDS\`) before anything is sent: lose them and you can't reveal, and an unrevealed bond is lost.
- \`LELANG_MAX_BOND\` (default 1) caps what you will ever lock, whatever a server quotes.
- Needs KITE for gas and the tender's stablecoin for the bond on Kite testnet ([faucet](https://faucet.gokite.ai)).
`);
console.log(`built ${OUT}`);
