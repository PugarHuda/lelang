// The sealed-bid commitment, with no side effects, so supplier agents (and the MCP server) can import it without
// loading the tender state. Same as LelangEscrow.commitmentOf: binds document, salt, bidder and tender.
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from 'viem';

export const docHashOf = (doc) => keccak256(toHex(doc));
export const commitHash = (doc, salt, bidder, chainId = 0) =>
  keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256'), [docHashOf(doc), salt, bidder, BigInt(chainId)]));
export const commitMessage = (rfqId, hash) => `LELANG commit ${rfqId} ${hash}`;
