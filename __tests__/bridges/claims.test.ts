import { spawnSync } from "node:child_process";

test("bridge claim SQL integration properties on embedded PostgreSQL", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "__tests__/bridges/claims.integration.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  process.stdout.write(result.stdout);
  expect(result.status).toBe(0);
}, 65000);
