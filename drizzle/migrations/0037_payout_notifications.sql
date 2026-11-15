-- Payout notifications (backend#389). Owner ruling 2026-11-01: no email and no personal data. A
-- subscription is an address plus EITHER a browser push subscription (the endpoint at the browser
-- vendor's push service and its two public keys) OR an ntfy topic the user chose. No IP, user agent or
-- name is stored. No consensus write and no dependency on users/stations.
--
-- Down (reversible): DROP TABLE payout_notification_events; DROP TABLE payout_notification_watch; DROP TABLE payout_notification_subscriptions;
CREATE TABLE payout_notification_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  channel text NOT NULL CHECK (channel IN ('webpush','ntfy')),
  -- The push endpoint URL (webpush) or the topic name (ntfy).
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 1024),
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  p256dh text,
  auth text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_delivered_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  CHECK ((channel = 'webpush' AND p256dh IS NOT NULL AND auth IS NOT NULL) OR (channel = 'ntfy' AND p256dh IS NULL AND auth IS NULL)),
  UNIQUE (address, channel, target_hash)
);
--> statement-breakpoint
CREATE INDEX payout_notification_subscriptions_target ON payout_notification_subscriptions(channel, target_hash);
--> statement-breakpoint
-- The last earned_balance_total the watcher read for a subscribed address (its baseline).
CREATE TABLE payout_notification_watch (
  address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  earned_total numeric(39,0) NOT NULL CHECK (earned_total >= 0),
  height bigint NOT NULL CHECK (height >= 0),
  checked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per observed increase. The primary key makes delivery at-most-once per new total, across
-- restarts and processes. Pruned after 30 days.
CREATE TABLE payout_notification_events (
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  earned_before numeric(39,0) NOT NULL CHECK (earned_before >= 0),
  earned_after numeric(39,0) NOT NULL CHECK (earned_after > earned_before),
  height bigint NOT NULL CHECK (height >= 0),
  attribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, earned_after)
);
