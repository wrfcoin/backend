/** Offline JSON replay. No network export or provider credentials. */
import { readFileSync } from 'node:fs';
import { replay } from '../server/services/weather/alert-replay.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: tsx scripts/replay-shadow-alerts.ts <fixture.json>');
const input = JSON.parse(readFileSync(path, 'utf8'));
if (!['synthetic', 'historical'].includes(input.provenance)) throw new Error('provenance required');
console.log(JSON.stringify({ provenance: input.provenance, ...replay(input.windows, input.configs) }, null, 2));
