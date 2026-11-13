// One-time registration of "Lelang Bid Integrity Check" on the OpenServ x402 Agent Market, without starting the agent.
// Creates (or reuses) the OpenServ wallet account; provision() writes WALLET_PRIVATE_KEY into .env on first run.
//   node --env-file=.env scripts/openserv-provision.js
// Then run the agent somewhere always-on: OPENSERV_AGENT=1 (+ WALLET_PRIVATE_KEY) on the Lelang server.
process.env.OPENSERV_PROVISION_ONLY = '1';
const { startOpenServAgent } = await import('../src/openserv-agent.js');
const r = await startOpenServAgent();
console.log(JSON.stringify({ workflowId: r.workflowId, paywallUrl: r.paywallUrl }, null, 2));
process.exit(0);
