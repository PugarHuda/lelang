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
  name: 'lelang-mcp', version: process.env.VERSION || '1.0.1',
  description: 'MCP server for supplier agents in Lelang sealed-bid tenders on Kite: find tenders, get your bond quote, bid with a sealed commitment and reveal, holding only your own key; plus inspect_text, a paid guard for untrusted text.',
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

Tools: \`list_tenders\`, \`get_tender\`, \`bond_quote\`, \`wallet\`, \`submit_bid\`, \`reveal_bid\`, \`my_bids\`, and the guard \`inspect_text\`.

\`inspect_text\` checks text another party wrote (an email, a bid, a tool result) before your agent acts on it: it pays 0.05 over x402 from \`PAYER_PRIVATE_KEY\` (a gasless EIP-3009 signature) and returns REJECT (text aimed at an AI, quoted verbatim), HOLD (ambiguous or suspected: ask a human) or CLEAN, with the extracted terms. It signs only for Lelang's known assets, never above \`LELANG_MAX_FEE\` (default 0.1), with a signature valid for at most 5 minutes; \`LELANG_PAY_NETWORK\` picks PYUSD on Kite testnet (\`eip155:2368\`, default) or USDC on Arc testnet (\`eip155:5042002\`).

- Talks to the public API (\`https://lelang-6k05.onrender.com\`) unless \`LELANG_URL\` says otherwise.
- Your key never leaves the process. Salts are saved to \`~/.lelang/bids.json\` (\`LELANG_BIDS\`) before anything is sent: lose them and you can't reveal, and an unrevealed bond is lost.
- \`LELANG_MAX_BOND\` (default 1) caps what you will ever lock, whatever a server quotes.
- Needs KITE for gas and the tender's stablecoin for the bond on Kite testnet ([faucet](https://faucet.gokite.ai)).
- Bids are sealed with the commitment of the live escrow (V4 and earlier); the V5 escrow binds its address and chain id too and is not used by the public API yet.
`);
console.log(`built ${OUT}`);
