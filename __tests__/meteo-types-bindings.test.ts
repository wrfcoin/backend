/**
 * CI guard: verifies that ts-rs generated bindings in shared/generated-types/ are
 * present and structurally consistent with their expected Rust-source shape.
 *
 * Closes #341 — prevents silent drift between meteo-types Rust structs and
 * the TypeScript interfaces consumed by backend services.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const BINDINGS_DIR = path.join(__dirname, '..', 'shared', 'generated-types');

// All 25 binding files expected from meteo-types + forecast-score
const EXPECTED_BINDING_FILES = [
  // meteo-types
  'WeatherObservation',
  'GeoLocation',
  'EnvironmentalDomain',
  'EnvironmentalReport',
  'ReportPayload',
  'AirQualityPayload',
  'WaterQualityPayload',
  'WildfirePayload',
  'SoilPayload',
  'OceanPayload',
  'HydrologyPayload',
  'ProvenanceEntry',
  'ProvenanceChain',
  'DataQualityScore',
  'DataQualityBand',
  'SensorAccuracyMetrics',
  'SensorAccuracyBand',
  'AccuracyWindow',
  'SensorReferencePair',
  'PhysicsRangePolicy',
  'PhysicsViolation',
  'ValidationReading',
  // forecast-score
  'ForecastAccuracyMetrics',
  'CategoricalScores',
  'Pair',
] as const;

describe('meteo-types ts-rs bindings (#341)', () => {
  describe('binding files exist', () => {
    it.each(EXPECTED_BINDING_FILES)('%s.ts is present', (name) => {
      const filePath = path.join(BINDINGS_DIR, `${name}.ts`);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  describe('index.ts re-exports', () => {
    let indexContent: string;

    beforeAll(() => {
      indexContent = fs.readFileSync(path.join(BINDINGS_DIR, 'index.ts'), 'utf-8');
    });

    it.each(EXPECTED_BINDING_FILES)('exports %s', (name) => {
      expect(indexContent).toContain(`{ ${name} }`);
    });
  });

  describe('WeatherObservation canonical shape', () => {
    it('contains all 8 SI/WMO observation fields', () => {
      const content = fs.readFileSync(
        path.join(BINDINGS_DIR, 'WeatherObservation.ts'),
        'utf-8',
      );
      const expectedFields = [
        'temperature_c',
        'humidity_percent',
        'pressure_hpa',
        'wind_speed_ms',
        'wind_direction_deg',
        'precipitation_mm',
        'dewpoint_c',
        'visibility_m',
      ];
      for (const field of expectedFields) {
        expect(content).toContain(field);
      }
    });

    it('uses number | null for all observation fields (ts-rs Option<f64> mapping)', () => {
      const content = fs.readFileSync(
        path.join(BINDINGS_DIR, 'WeatherObservation.ts'),
        'utf-8',
      );
      // Every field should map to number | null, never undefined
      const fieldMatches = content.match(/\w+: [^,]+,/g) ?? [];
      for (const match of fieldMatches) {
        expect(match).toMatch(/number \| null,/);
      }
    });
  });

  describe('ForecastAccuracyMetrics canonical shape', () => {
    it('contains mae, rmse, bias, skill_score fields', () => {
      const content = fs.readFileSync(
        path.join(BINDINGS_DIR, 'ForecastAccuracyMetrics.ts'),
        'utf-8',
      );
      for (const field of ['mae', 'rmse', 'bias', 'skill_score']) {
        expect(content).toContain(field);
      }
    });
  });

  describe('@wrfcoin/meteo-types path alias', () => {
    it('tsconfig.json declares @wrfcoin/meteo-types path alias', () => {
      const tsconfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'tsconfig.json'), 'utf-8'),
      );
      const paths = tsconfig.compilerOptions?.paths ?? {};
      expect(paths['@wrfcoin/meteo-types']).toBeDefined();
      expect(paths['@wrfcoin/meteo-types'][0]).toContain('shared/generated-types');
    });
  });
});

// #1174: present-tense wire truth, not a canonical-repository decision.
const standaloneOnly = ['pressure_type','wind_gust_ms','observation_period_seconds','cloud_cover_oktas','sensor_metadata'];
function wireDrift(source: string): string[] {
  // Match actual field declarations, not doc prose or import identifiers.
  const body = source.match(/export type WeatherObservation\s*=\s*\{([\s\S]*?)\};/);
  if (!body) return ['missing observation object'];
  const fields = [...body[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\b(\w+)\??\s*:/g)].map(match => match[1]);
  return [...(fields.includes('radio_metadata') ? [] : ['missing radio_metadata']), ...standaloneOnly.filter(field => fields.includes(field))];
}
describe('core4 live-wire regeneration tripwire (#1174)', () => {
  const current = fs.readFileSync(path.join(BINDINGS_DIR, 'WeatherObservation.ts'), 'utf8');
  it('retains radio metadata and excludes all standalone-only fields', () => expect(wireDrift(current)).toEqual([]));
  it('rejects a standalone-shaped fixture with missing radio metadata and five foreign fields', () => {
    const orphan = current.replace(/radio_metadata\??:[^,}]+,?/, '').replace('temperature_c:', standaloneOnly.map(field => `${field}: number | null,`).join(' ') + 'temperature_c:');
    expect(wireDrift(orphan)).toEqual(['missing radio_metadata', ...standaloneOnly]);
  });
  it.each(standaloneOnly)('independently rejects %s', field => {
    expect(wireDrift(current.replace('temperature_c:', `${field}: number | null, temperature_c:`))).toEqual([field]);
  });
});
