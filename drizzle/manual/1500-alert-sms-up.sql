-- Future durable offline research sessions; no gateway routing or phone plaintext.
BEGIN;
CREATE TABLE alert_sms_research_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object')
);
COMMIT;
