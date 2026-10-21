/**
 * The commit-authorization preimage a contributor signs for core4 (#1848, #2034).
 *
 * core4 admits a `ContributionCommit` only when its body carries an
 * `auth_pubkey`/`auth_signature` pair whose ed25519 signature verifies over
 * this message (fail-closed at mempool admission). It mirrors
 * `commit_authorization_message_with_domain` in core4
 * `shared-protocol/src/blockchain/transaction.rs`:
 *
 *   "wrfcoin_commit_auth_v2"
 *   || u32le(len(chain_id))   || chain_id
 *   || u32le(len(network_id)) || network_id
 *   || u32le(len(station_id)) || station_id
 *   || u32le(len(commit_id))  || commit_id
 *   || u32le(len(contribution_type)) || contribution_type
 *
 * Lengths are UTF-8 byte counts. The chain identity must be the one the core4
 * node resolves (`WRFCOIN_CHAIN_ID`/`WRFCOIN_NETWORK_ID`), or the signature
 * will not verify.
 *
 * The backend never signs this (#1284 ruling): the phone signs it with its
 * wallet key. The backend only builds it so the prepare step can hand the
 * client the exact bytes, and pins it to core4's golden vector.
 */

export const COMMIT_AUTH_DOMAIN = 'wrfcoin_commit_auth_v2';

export interface CommitAuthorizationInput {
  chainId: string;
  networkId: string;
  stationId: string;
  commitId: string;
  contributionType: string;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

export function buildCommitAuthorizationMessage(input: CommitAuthorizationInput): Buffer {
  return Buffer.concat([
    Buffer.from(COMMIT_AUTH_DOMAIN, 'utf8'),
    lengthPrefixed(input.chainId),
    lengthPrefixed(input.networkId),
    lengthPrefixed(input.stationId),
    lengthPrefixed(input.commitId),
    lengthPrefixed(input.contributionType),
  ]);
}
