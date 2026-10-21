import { profileKeyFor } from '../../utils/contributor-alias.js';
import type { Client } from './store.js';

export const ALIAS_BACKFILL_BATCH = 1000;
// A public HMAC-derived version marker, never a secret or operator identity.
export const aliasEpoch = () => profileKeyFor('chain-role-payee-alias-epoch-v1');

export async function writePayeeAlias(client: Client, args: string[], address: string): Promise<void> {
  const epoch = aliasEpoch(), key = profileKeyFor(address);
  if (!epoch || !key) return;
  await client.query(`UPDATE chain_role_payees SET profile_key=$4,alias_epoch=$5
    WHERE chain_id=$1 AND genesis_hash=$2 AND payee_address=$3`, [...args, address, key, epoch]);
}

/** Only the indexer's locked background pass does bounded migration/rotation
 * backfill. New receipt aliases are written in the receipt transaction.
 */
export async function refreshPayeeAliases(client: Client, args: string[]): Promise<number> {
  const epoch = aliasEpoch();
  if (!epoch) return 0;
  const rows = (await client.query(`SELECT payee_address FROM chain_role_payees
    WHERE chain_id=$1 AND genesis_hash=$2 AND alias_epoch IS DISTINCT FROM $3
    ORDER BY payee_address LIMIT $4`, [...args, epoch, ALIAS_BACKFILL_BATCH])).rows;
  for (const row of rows) await writePayeeAlias(client, args, row.payee_address);
  return rows.length;
}
