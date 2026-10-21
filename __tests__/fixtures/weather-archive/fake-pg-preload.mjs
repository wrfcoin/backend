// Acceptance-test preload: maps `pg` to ./fake-pg.mjs so the REAL worker, service and storage client run
// end to end without a database. tsx compiles server/*.ts either as ESM or CJS depending on the nearest package
// scope, so both the ESM resolver and CommonJS Module._load are covered.
// Load it AFTER tsx: --import tsx --import <this file>.
import Module, { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fake from './fake-pg.mjs';

const target = pathToFileURL(new URL('./fake-pg.mjs', import.meta.url).pathname).href;
const hooks = `export async function resolve(specifier, context, next) {
  if (specifier === 'pg') return { url: ${JSON.stringify(target)}, shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const originalLoad = Module._load;
Module._load = function loadFakePg(request, parent, isMain) {
  if (request === 'pg') return { Pool: fake.Pool, default: { Pool: fake.Pool }, __esModule: true };
  return originalLoad.call(this, request, parent, isMain);
};
