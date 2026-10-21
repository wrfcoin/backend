import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  GEO_FENCE_WINDOW_MS,
  IotGatewayGeoFenceService,
  encodeGeoFenceGrid,
} from '../shared/iot-gateway-geofence-service.js';

describe('IotGatewayGeoFenceService', () => {
  it('should keep the first new identity in a grid clear', async () => {
    const execute = jest.fn(async (_query: unknown) => [{ hit_count: 0 }]);
    const now = new Date('2026-03-11T12:00:00.000Z');
    const service = new IotGatewayGeoFenceService({ execute }, () => now);

    const decision = await service.evaluateNewIdentity({
      integrationType: 'meshtastic',
      subjectId: '!node-1',
      location: { lat: 37.7749, lon: -122.4194 },
    });

    expect(decision.status).toBe('clear');
    expect(decision.burstCount).toBe(1);
    expect(decision.gridKey).toBe(encodeGeoFenceGrid({ lat: 37.7749, lon: -122.4194 }));
    expect(decision.reason).toBeNull();
    expect(decision.windowStartedAt).toBe(
      new Date(now.getTime() - GEO_FENCE_WINDOW_MS).toISOString()
    );
  });

  it('should flag the second new identity in the same grid window', async () => {
    const execute = jest.fn(async (_query: unknown) => [{ hit_count: 1 }]);
    const service = new IotGatewayGeoFenceService({ execute });

    const decision = await service.evaluateNewIdentity({
      integrationType: 'iotex',
      subjectId: 'device-2',
      location: { lat: 37.7749, lon: -122.4194 },
    });

    expect(decision.status).toBe('manual_review_required');
    expect(decision.reason).toBe('geo_burst_detected');
    expect(decision.burstCount).toBe(2);
    expect(decision.triggeredAt).not.toBeNull();
  });

  it('should require manual review when no location or existing grid is available', async () => {
    const execute = jest.fn(async (_query: unknown) => []);
    const service = new IotGatewayGeoFenceService({ execute });

    const decision = await service.evaluateNewIdentity({
      integrationType: 'meshtastic',
      subjectId: '!node-no-location',
    });

    expect(decision.status).toBe('manual_review_required');
    expect(decision.reason).toBe('location_required');
    expect(decision.gridKey).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  // backend#1171: meshtastic_nodes is not created by drizzle/migrations, so a
  // fresh database lacks it and every iotex registration used to 500.
  describe('when meshtastic_nodes is absent or present', () => {
    const dialect = new PgDialect();
    const text = (query: unknown) => dialect.sqlToQuery(query as any).sql;
    const location = { lat: 46.8, lon: -92.1 };

    it('omits the absent meshtastic source instead of failing the registration', async () => {
      const execute = jest.fn(async (query: unknown) =>
        text(query).includes('to_regclass') ? [{ present: false }] : [{ hit_count: 0 }]);
      const service = new IotGatewayGeoFenceService({ execute });

      const decision = await service.evaluateNewIdentity({ integrationType: 'iotex', subjectId: 'dev-1', location });

      expect(decision.status).toBe('clear');
      const burstQuery = text(execute.mock.calls[1][0]);
      expect(burstQuery).not.toContain('meshtastic_nodes');
      expect(burstQuery).toContain('FROM iotex_devices');
    });

    it('binds no Date objects: postgres-js rejects them in a raw sql template', async () => {
      const execute = jest.fn(async (query: unknown) =>
        text(query).includes('to_regclass') ? [{ present: true }] : [{ hit_count: 0 }]);
      const service = new IotGatewayGeoFenceService({ execute });

      await service.evaluateNewIdentity({ integrationType: 'iotex', subjectId: 'dev-1', location });

      const params = execute.mock.calls.flatMap(([query]) => dialect.sqlToQuery(query as any).params);
      expect(params.length).toBeGreaterThan(0);
      expect(params.filter((param) => param instanceof Date)).toEqual([]);
    });

    it('counts meshtastic identities when the table exists, and probes only until it does', async () => {
      const execute = jest.fn(async (query: unknown) =>
        text(query).includes('to_regclass') ? [{ present: true }] : [{ hit_count: 0 }]);
      const service = new IotGatewayGeoFenceService({ execute });

      await service.evaluateNewIdentity({ integrationType: 'iotex', subjectId: 'dev-1', location });
      await service.evaluateNewIdentity({ integrationType: 'iotex', subjectId: 'dev-2', location });

      const queries = execute.mock.calls.map(([query]) => text(query));
      expect(queries.filter((q) => q.includes('to_regclass'))).toHaveLength(1);
      expect(queries.filter((q) => q.includes('FROM meshtastic_nodes'))).toHaveLength(2);
    });
  });
});
