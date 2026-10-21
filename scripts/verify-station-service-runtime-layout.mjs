/**
 * Runtime-image smoke test for backend#1042.
 *
 * The production image copies dist/ and production node_modules only. Import
 * the emitted station service from that same layout so a build cannot succeed
 * while the station router's lazy module is absent or unloadable.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const distFlag = args.indexOf("--dist");
const distRoot = path.resolve(distFlag !== -1 ? args[distFlag + 1] : "dist");
const servicePath = path.join(
  distRoot,
  "server",
  "services",
  "station-registration-service.js",
);

if (!existsSync(servicePath)) {
  console.error(
    `verify-station-service-runtime-layout: missing emitted station service: ${servicePath}`,
  );
  process.exit(1);
}

const relative = path.relative(distRoot, realpathSync(servicePath));
if (
  relative === ".." ||
  relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative)
) {
  console.error(
    `verify-station-service-runtime-layout: station service resolves outside dist: ${servicePath}`,
  );
  process.exit(1);
}

try {
  const service = await import(pathToFileURL(servicePath).href);
  const requiredExports = [
    "listStationCredentials",
    "registerStation",
    "verifyAmbientKey",
  ];
  const missingExports = requiredExports.filter(
    (name) => typeof service[name] !== "function",
  );
  if (missingExports.length > 0) {
    throw new Error(`missing required export(s): ${missingExports.join(", ")}`);
  }
  console.log(
    `verify-station-service-runtime-layout: OK — imported ${servicePath} from the dist-only image boundary`,
  );
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(
    "verify-station-service-runtime-layout: emitted station service is not loadable",
    {
      code: err.code,
      message: err.message,
      stack: err.stack,
    },
  );
  process.exit(1);
}
