-- backend#995: user_achievements authorized a mint by row existence, and the column defaults made a bare
-- INSERT (user_id, achievement_id) immediately claimable (progress 100, status 'completed').
--
-- The tracked schemas disagree about this table's shape (shared/schema.ts, the legacy shared/schema.js, and
-- the raw SQL in enhanced_weather_rewards.ts / operator-profile-routes.ts), so this migration acts only on the
-- shape the claim route reads (both `progress` and `status` present):
--   * progress + status            -> DROP DEFAULT on both, then VERIFY both defaults are gone (else RAISE)
--   * progress without status      -> legacy shared/schema.js shape: NOTICE, unchanged
--   * neither column               -> raw-SQL shape (achievement_type, ...): NOTICE, unchanged
--   * status without progress      -> not any tracked shape: refuse loudly rather than guess
--   * table not visible            -> NOTICE, unchanged
-- The table is looked up with to_regclass() on the unqualified name, i.e. through the same search_path the app
-- uses, and every later statement and check uses that looked-up relation (never current_schema()).
DO $$
DECLARE
  tbl regclass;
  has_progress boolean;
  has_status boolean;
BEGIN
  tbl := to_regclass('user_achievements');
  IF tbl IS NULL THEN
    RAISE NOTICE 'backend#995: user_achievements is not visible on the search_path; nothing to harden';
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl AND attname = 'progress' AND attnum > 0 AND NOT attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl AND attname = 'status' AND attnum > 0 AND NOT attisdropped)
    INTO has_progress, has_status;

  IF has_status AND NOT has_progress THEN
    RAISE EXCEPTION 'backend#995: % has status but no progress, which no tracked schema describes; refusing to alter it', tbl;
  END IF;

  IF has_progress AND has_status THEN
    EXECUTE format('ALTER TABLE %s ALTER COLUMN progress DROP DEFAULT', tbl);
    EXECUTE format('ALTER TABLE %s ALTER COLUMN status DROP DEFAULT', tbl);
    IF EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = tbl AND attname IN ('progress', 'status') AND NOT attisdropped AND atthasdef
    ) THEN
      RAISE EXCEPTION 'backend#995: % still has a progress/status default after the ALTER; refusing to report success', tbl;
    END IF;
    RAISE NOTICE 'backend#995: dropped the progress/status defaults on %', tbl;
  ELSIF has_progress THEN
    RAISE NOTICE 'backend#995: % has progress but no status (legacy shape); unchanged', tbl;
  ELSE
    RAISE NOTICE 'backend#995: % has neither progress nor status; unchanged', tbl;
  END IF;
END
$$;
