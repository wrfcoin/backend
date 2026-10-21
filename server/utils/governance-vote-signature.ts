import { verifyEd25519SignatureBytes } from '../routes/wallet-auth-service.js';
import { ed25519PublicKeyToLaunchAddress, isLaunchAddress } from '../routes/wallet-transfer-contract.js';

function frame(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value); const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}
function failure(status: number, message: string): never {
  throw Object.assign(new Error(message), { status, governanceVotePolicy: true });
}
// Signing version comes from server config ONLY (WRFCOIN_GOVERNANCE_SIGNING_VERSION), never the caller.
// V1 (the live chain-777 version, owner ruling 2026-09-30): the raw UTF-8 bytes of
//   `governance-vote-v1|<proposal_id>|approve` or `...|reject`
// core4 @65134a64 shared-protocol/src/blockchain/transaction.rs:1695-1706
// (GovernanceVotePayload::canonical_signing_message), verified at :1755-1757 via
// verify_vote_signature_at_height (state.rs:7174) -> chain_binding::protocol_version_at.
// V1 binds no chain/network and no voting_power; it is only selected when the operator sets 1.
// V2: core4 domain_impls.rs:444 / chain_binding.rs:913, GovernanceVotePayload V2.
// Any other version fails closed with 503. Chain/network IDs are required for both.
export function verifiedGovernanceVote(user: any, proposalId: string, body: any) {
  if (user?.role !== 'wallet' || user?.wallet_scheme !== 'ed25519' || !isLaunchAddress(user?.sub)) {
    failure(403, 'An authenticated ed25519 wallet is required to vote');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['support', 'voteType', 'signer_public_key', 'signature', 'reason'].includes(key))) {
    failure(400, 'Invalid signed vote');
  }
  const choice = body.voteType === undefined ? undefined : ({ FOR: true, AGAINST: false } as Record<string, boolean>)[String(body.voteType).toUpperCase()];
  const approve = body.support ?? choice;
  if (typeof approve !== 'boolean' || (body.voteType !== undefined && (choice === undefined || choice !== approve)) ||
      typeof body.signer_public_key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.signer_public_key) ||
      typeof body.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(body.signature) ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(proposalId)) failure(400, 'Invalid signed vote');
  const voter = user.sub.toLowerCase();
  if (ed25519PublicKeyToLaunchAddress(body.signer_public_key) !== voter) failure(403, 'The vote signer must match the authenticated wallet');
  const chain = process.env.WRFCOIN_GOVERNANCE_CHAIN_ID?.trim();
  const network = process.env.WRFCOIN_GOVERNANCE_NETWORK_ID?.trim();
  const version = process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION?.trim();
  if ((version !== '1' && version !== '2') ||
      !chain || !network || chain.length > 128 || network.length > 128) {
    failure(503, 'Governance voting requires configured signing version (1 or 2) and chain signing identity');
  }
  const preimage = version === '1'
    ? Buffer.from(`governance-vote-v1|${proposalId}|${approve ? 'approve' : 'reject'}`, 'utf8')
    : v2Preimage(proposalId, approve, body.signer_public_key, chain, network);
  if (!verifyEd25519SignatureBytes(body.signer_public_key, body.signature, preimage)) failure(400, 'Invalid vote signature');
  return { voter, payload: { proposal_id: proposalId, approve, signer_public_key: body.signer_public_key, signature: body.signature } };
}

function v2Preimage(proposalId: string, approve: boolean, signerPublicKey: string, chain: string, network: string): Buffer {
  // voting_power is None (0); signer_public_key is Some (1). Power is derived
  // by core4 from its proposal snapshot. Preserve the signer's exact hex text.
  const canonicalBody = Buffer.concat([frame(proposalId), Buffer.from([approve ? 1 : 0, 0, 1]), frame(signerPublicKey)]);
  return Buffer.concat([frame('wrfcoin.governance_vote.v1'), frame(chain), frame(network), Buffer.from([2, 0, 0, 0]), frame(canonicalBody)]);
}
