/**
 * Transitional TypeScript entrypoint for the AI/ML server.
 *
 * The build pipeline currently bundles this file, so we re-export the
 * CommonJS runtime implementation to keep the production listener and route
 * registration intact while the TS migration continues.
 */

import * as serverModule from './ai_ml_networks_server_impl.js';

const app = (serverModule as any).default || (serverModule as any);

export default app;
export const __testHooks = (serverModule as any).__testHooks || (app as any).__testHooks;
