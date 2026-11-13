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
  // throws on an RPC error or an id that doesn't exist: the caller fails closed (a human looks)
  const owner = await pub.readContract({ address: IDENTITY, abi: ABI, functionName: 'ownerOf', args: [BigInt(agentId)] });
  if (owner.toLowerCase() !== addr) return { agentId: String(agentId), error: 'this agentId is not owned by the supplier', externalSlashes: 0 };
  const own = new Set(ownClients.map((c) => c.toLowerCase()));
  // Only the trusted list goes to getSummary: the registry's client list is open to anyone, so a padded one must not
  // be able to make this read fail and the bond fall back to the base.
  const trusted = list(process.env.EXTERNAL_REPUTATION_CLIENTS).filter((c) => !own.has(c));
  const count = async (cs, tag1 = '') => (cs.length ? Number((await pub.readContract({ address: REPUTATION, abi: ABI, functionName: 'getSummary', args: [BigInt(agentId), cs, tag1, ''] }))[0]) : 0);
  const externalSlashes = await count(trusted, 'slashed'); // these raise the bond; a failed read throws
  // shown for information only, best effort
  const others = await pub.readContract({ address: REPUTATION, abi: ABI, functionName: 'getClients', args: [BigInt(agentId)] })
    .then((cs) => cs.filter((c) => !own.has(c.toLowerCase()))).catch(() => null);
  return { agentId: String(agentId), registry: `eip155:5042002:${REPUTATION}`, trustedClients: trusted.length, externalSlashes, otherClients: others?.length ?? null };
}
