-- Match the gate's global achievement-nonce namespace. Unsigned legacy rows
-- are unaffected; failed/reversed reservations retain their nonce forever.
-- Existing duplicate signed nonces fail migration rather than being discarded.
-- Drizzle journals this transactional migration; do not use CONCURRENTLY.
CREATE UNIQUE INDEX "idx_achievement_payout_nonce_unique"
ON "contributor_rewards" (("metadata"->'payoutAuthorization'->>'nonce'))
WHERE "contributor_type" = 'achievement'
  AND "metadata"->'payoutAuthorization'->>'nonce' IS NOT NULL;
