-- Read-side payee registry. Public lookups never enumerate receipt tables.
CREATE TABLE chain_role_payees (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL,
  payee_address text NOT NULL CHECK (payee_address ~ '^0x[0-9a-f]{40}$'),
  profile_key text CHECK (profile_key ~ '^c_[0-9a-f]{24}$'),
  alias_epoch text CHECK (alias_epoch ~ '^c_[0-9a-f]{24}$'),
  CHECK ((profile_key IS NULL) = (alias_epoch IS NULL)),
  PRIMARY KEY (chain_id, genesis_hash, payee_address),
  FOREIGN KEY (chain_id, genesis_hash) REFERENCES chain_reward_index_state(chain_id, genesis_hash) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX chain_role_payees_alias ON chain_role_payees(chain_id, genesis_hash, alias_epoch, profile_key) WHERE profile_key IS NOT NULL;
CREATE INDEX chain_role_payouts_address_lookup ON chain_role_payouts(chain_id, genesis_hash, payee_address);
--> statement-breakpoint
INSERT INTO chain_role_payees(chain_id,genesis_hash,payee_address)
  SELECT DISTINCT chain_id,genesis_hash,payee_address FROM chain_role_payouts;
--> statement-breakpoint
CREATE FUNCTION register_chain_role_payee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chain_role_payees(chain_id,genesis_hash,payee_address)
    VALUES (NEW.chain_id,NEW.genesis_hash,NEW.payee_address) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chain_role_payee_insert AFTER INSERT ON chain_role_payouts
  FOR EACH ROW EXECUTE FUNCTION register_chain_role_payee();
--> statement-breakpoint
-- Canonical storage is lowercase: 64-hex key or 0x-prefixed 40-hex address.
-- Existing owner-approved rows are preserved; conflicting canonical bindings
-- abort migration rather than choosing an owner label silently.
UPDATE operator_role_labels SET operator_identity = CASE
  WHEN length(operator_identity)=40 THEN '0x'||lower(operator_identity)
  ELSE lower(operator_identity) END;
UPDATE chain_role_payouts SET operator_identity = CASE
  WHEN length(operator_identity)=40 THEN '0x'||lower(operator_identity)
  ELSE lower(operator_identity) END;
ALTER TABLE operator_role_labels ADD CONSTRAINT operator_role_labels_canonical_identity
  CHECK (operator_identity ~ '^([0-9a-f]{64}|0x[0-9a-f]{40})$');
ALTER TABLE chain_role_payouts ADD CONSTRAINT chain_role_payouts_canonical_identity
  CHECK (operator_identity ~ '^([0-9a-f]{64}|0x[0-9a-f]{40})$');
