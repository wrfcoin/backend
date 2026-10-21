/**
 * Preload for the anonymous-GET route inventory (backend H11).
 * Captures the express app the live entrypoint hands to http.createServer, and once
 * the server is listening writes every GET route (recursively through mounted routers)
 * to WRFCOIN_ROUTE_INVENTORY_FILE. Test-only; it changes no behaviour.
 */
const fs = require('node:fs');
const http = require('node:http');

const outFile = process.env.WRFCOIN_ROUTE_INVENTORY_FILE;
const originalCreateServer = http.createServer;

const { enumerateGetRoutes, installMountTracking } = require('./route-walker.cjs');
try {
  installMountTracking(require('express'));
} catch {
  // express not resolvable from here: sub-apps will be reported as unsupported
}

http.createServer = function patchedCreateServer(...args) {
  const server = originalCreateServer.apply(this, args);
  const app = args.find((a) => typeof a === 'function' && a.stack === undefined && a._router !== undefined) || args.find((a) => typeof a === 'function');
  server.once('listening', () => {
    try {
      const stack = app && app._router && app._router.stack;
      if (!stack || !outFile) return;
      fs.writeFileSync(outFile, JSON.stringify(enumerateGetRoutes(app)));
    } catch (error) {
      if (outFile) fs.writeFileSync(`${outFile}.error`, String(error && error.stack));
    }
  });
  return server;
};
