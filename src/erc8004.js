// Reputation from outside Lelang: the canonical ERC-8004 registries on Arc testnet. A supplier's slash on another
// marketplace raises its bond here too, but only when that marketplace is one the operator trusts
// (EXTERNAL_REPUTATION_CLIENTS): anyone can write feedback to the registry, so counting every client would let a
// competitor buy a rival a bigger bond with a few fake entries. Lelang's own feedback is not counted again: its slashes
// already come from the escrows on Kite.
import { readFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { OPTIONS } from './x402.js';

export const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getClients(uint256) view returns (address[])',
  'function getSummary(uint256,address[],string,string) view returns (uint64,int128,uint8)',
]);
const arc = OPTIONS.find((o) => o.network === 'eip155:5042002');
const pub = createPublicClient({ chain: arc.chain, transport: http() });
const list = (v) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// agents Lelang itself registered (scripts/erc8004-publish.js); any other supplier names its own agentId
const published = () => (existsSync('deployments/erc8004-arc.json') ? JSON.parse(readFileSync('deployments/erc8004-arc.json', 'utf8')).agents : {});

export async function externalReputation(supplier, claimedAgentId, ownClients = []) {
  const addr = supplier.toLowerCase();
  const agentId = claimedAgentId ?? published()[addr]?.agentId;
  if (!agentId || !/^\d+$/.test(String(agentId))) return { agentId: null, externalSlashes: 0 };
  const owner = await pub.readContract({ address: IDENTITY, abi: ABI, functionName: 'ownerOf', args: [BigInt(agentId)] }).catch(() => null);
  if (owner?.toLowerCase() !== addr) return { agentId: String(agentId), error: 'this agentId is not owned by the supplier', externalSlashes: 0 };
  const own = new Set(ownClients.map((c) => c.toLowerCase()));
  const clients = (await pub.readContract({ address: REPUTATION, abi: ABI, functionName: 'getClients', args: [BigInt(agentId)] })).filter((c) => !own.has(c.toLowerCase()));
  const trusted = new Set(list(process.env.EXTERNAL_REPUTATION_CLIENTS));
  const trustedClients = clients.filter((c) => trusted.has(c.toLowerCase()));
  const count = async (cs, tag1 = '') => (cs.length ? Number((await pub.readContract({ address: REPUTATION, abi: ABI, functionName: 'getSummary', args: [BigInt(agentId), cs, tag1, ''] }))[0]) : 0);
  return {
    agentId: String(agentId), registry: `eip155:5042002:${REPUTATION}`,
    otherClients: clients.length, otherFeedback: await count(clients),
    trustedClients: trustedClients.length,
    externalSlashes: await count(trustedClients, 'slashed'), // these raise the bond
  };
}
