/**
 * Canonical form of a wallet/station owner address: trimmed and lowercased
 * (backend#1210).
 *
 * Owner matching must be case-insensitive. The EVM login stores whatever case
 * the client sent (payload.address.trim()), while ed25519 login subjects are
 * lowercase hex, so the same wallet can arrive as `0xAbC…` on one login and
 * `0xabc…` on another. Owner addresses are 0x-hex; core4 parses them into
 * `Address([u8; 20])`, so letter case carries no meaning on chain.
 *
 * Writes store this form; reads compare `lower(owner_address)` so rows written
 * before the normalisation (or left by the 0020 migration because they were
 * part of a reported case collision) still match.
 */
export function normalizeOwnerAddress(address: string): string {
  return address.trim().toLowerCase();
}
