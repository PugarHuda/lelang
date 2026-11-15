// The sealed-bid commitment, with no side effects, so supplier agents (and the MCP server) can import it without
// loading the tender state. Same as LelangEscrow.commitmentOf: binds document, salt, bidder and tender.
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from 'viem';

export const docHashOf = (doc) => keccak256(toHex(doc));
// `chainId` here is the on-chain tender id (historical name). `domain` = { escrow, chainId } only for a V5 escrow, whose
// commitmentOf also binds its own address and the chain id (audit F5); V1-V4 escrows (all published tenders) omit it.
export const commitHash = (doc, salt, bidder, chainId = 0, domain = null) =>
  keccak256(domain
    ? encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256, address, uint256'), [docHashOf(doc), salt, bidder, BigInt(chainId), domain.escrow, BigInt(domain.chainId)])
    : encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, uint256'), [docHashOf(doc), salt, bidder, BigInt(chainId)]));
export const commitMessage = (rfqId, hash) => `LELANG commit ${rfqId} ${hash}`;
