-- backend#1210: normalise stored owner addresses to lowercase.
--
-- Owner matching is case-insensitive (EVM logins store client case, ed25519
-- login subjects are lowercase). The application now writes lowercase and
-- compares lower(owner_address) on read; this migration brings existing rows
-- to the canonical form.
--
-- Rules:
--   * Idempotent: only rows whose value differs from lower(value) are touched,
--     so a second run updates nothing.
--   * Collisions are REPORTED, never merged silently: when one lowercased
--     owner is stored under two or more distinct case variants in a column,
--     every row of that owner is LEFT UNCHANGED and the group is reported with
--     RAISE WARNING. (Reads still match those rows through lower(); an
--     operator can normalise them deliberately.)
--   * oracle_work_items.owner_address is NOT touched: those rows are
--     immutable evidence (0018 trigger oracle_work_items_immutable).
--   * devices_consolidated is only normalised if the table exists (it is not
--     created by this migration set).
--   * No unique constraint or index includes these columns, so the update
--     cannot fail on uniqueness.
DO $$
DECLARE
  target record;
  collision record;
  updated_count bigint;
  collision_groups bigint;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('weather_stations', 'owner_address'),
      ('station_reward_cycles', 'owner_address'),
      ('station_reward_cycles', 'reward_address'),
      ('devices_consolidated', 'owner_address')
    ) AS t(table_name, column_name)
  LOOP
    IF to_regclass(format('%I', target.table_name)) IS NULL THEN
      RAISE NOTICE 'backend#1210 owner case: %.% absent, skipped', target.table_name, target.column_name;
      CONTINUE;
    END IF;

    collision_groups := 0;
    FOR collision IN EXECUTE format(
      'SELECT lower(%1$I) AS owner, COUNT(DISTINCT %1$I) AS variants, COUNT(*) AS row_count
         FROM %2$I
        WHERE %1$I IS NOT NULL
        GROUP BY lower(%1$I)
       HAVING COUNT(DISTINCT %1$I) > 1
        ORDER BY 1',
      target.column_name, target.table_name)
    LOOP
      collision_groups := collision_groups + 1;
      RAISE WARNING 'backend#1210 owner case COLLISION left unchanged: %.% owner % has % case variants over % rows',
        target.table_name, target.column_name, collision.owner, collision.variants, collision.row_count;
    END LOOP;

    EXECUTE format(
      'UPDATE %2$I AS t
          SET %1$I = lower(t.%1$I)
        WHERE t.%1$I IS NOT NULL
          AND t.%1$I <> lower(t.%1$I)
          AND NOT EXISTS (
            SELECT 1 FROM %2$I AS c
             WHERE lower(c.%1$I) = lower(t.%1$I)
               AND c.%1$I <> t.%1$I)',
      target.column_name, target.table_name);
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RAISE NOTICE 'backend#1210 owner case: %.% lowercased % rows, % collision groups left unchanged',
      target.table_name, target.column_name, updated_count, collision_groups;
  END LOOP;
END
$$;
