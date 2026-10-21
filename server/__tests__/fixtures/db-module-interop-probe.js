// backend#1247 fixture — run under tsx by __tests__/db-module-interop-1247.test.ts.
// Lives under server/ on purpose: server/package.json has no "type", so this
// file and server/db.ts load as CommonJS, exactly like server/routes/*.js.
(async () => {
  const dbModule = await import('../../db.js');
  const report = {
    keys: Object.keys(dbModule).sort(),
    pool: typeof dbModule.pool?.query,
    db: typeof dbModule.db,
    executeQuery: typeof dbModule.executeQuery,
  };
  process.stdout.write(`\nDB_MODULE_INTEROP ${JSON.stringify(report)}\n`);
  process.exit(0);
})();
