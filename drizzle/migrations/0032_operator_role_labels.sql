-- Owner binds verified full identities; deliberately ships no label mappings.
CREATE TABLE operator_role_labels (
  chain_id text NOT NULL,
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK (role IN ('producer','attester')),
  operator_identity text NOT NULL CHECK (operator_identity ~ '^([0-9a-fA-F]{64}|(0x)?[0-9a-fA-F]{40})$'),
  CHECK (role <> 'producer' OR operator_identity ~ '^[0-9a-f]{64}$'),
  from_height bigint NOT NULL CHECK (from_height > 0),
  through_height bigint CHECK (through_height >= from_height),
  display_label text NOT NULL CHECK (display_label IN ('N5 node','Mango','Workstation')),
  approval_reference text NOT NULL CHECK (length(trim(approval_reference)) > 0),
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id,genesis_hash,role,operator_identity,from_height)
);
