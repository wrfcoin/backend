import type { IncomingMessage, ServerResponse } from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import {
  handleStationDiscoveryRequest,
  resetStationDiscoveryRateLimiter,
  type QueryExecutor,
} from '../server/routes/station-discovery-routes.js';
import * as stationDiscovery from '../server/routes/station-discovery-routes.js';

type QueryResult = { rows: Record<string, unknown>[] };

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  textBody?: string;
};

function createMockResponse(input: MockFetchResponse): any {
  const headerMap = new Map<string, string>();
  for (const [key, value] of Object.entries(input.headers || {})) {
    headerMap.set(key.toLowerCase(), value);
  }

  return {
    ok: input.ok,
    status: input.status ?? 200,
    statusText: input.statusText ?? 'OK',
    headers: {
      get(name: string): string | null {
        return headerMap.get(name.toLowerCase()) || null;
      },
    },
    async json(): Promise<unknown> {
      return input.body;
    },
    async text(): Promise<string> {
      if (typeof input.textBody === 'string') {
        return input.textBody;
      }
      if (typeof input.body === 'string') {
        return input.body;
      }
      return JSON.stringify(input.body ?? {});
    },
  };
}

type ApiResult = {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
};

type TestApiRequest = {
  set(header: string, value: string): TestApiRequest;
  send(body: unknown): Promise<ApiResult>;
  then(
    onFulfilled?: (value: ApiResult) => void | PromiseLike<void>,
    onRejected?: (reason?: unknown) => void
  ): Promise<unknown>;
};

type TestApi = {
  get(path: string): TestApiRequest;
  post(path: string): TestApiRequest;
  delete(path: string): TestApiRequest;
};

function parseBodyInput(rawBody: unknown): Record<string, unknown> {
  if (rawBody && typeof rawBody === 'object') {
    return rawBody as Record<string, unknown>;
  }
  return {};
}

function createMockResponseCapture(): {
  res: ServerResponse;
  getResult(): ApiResult;
} {
  let status = 200;
  let headers: Record<string, string | string[]> = {};
  let bodyPayload = '';

  return {
    res: {
      writeHead(code: number, responseHeaders: Record<string, string | string[]> = {}): void {
        status = code;
        headers = { ...headers, ...responseHeaders };
      },
      end(payload?: string | Buffer): void {
        if (payload) {
          bodyPayload = payload.toString();
        }
      },
    } as unknown as ServerResponse,
    getResult() {
      let body: unknown = null;
      if (bodyPayload.length > 0) {
        try {
          body = JSON.parse(bodyPayload);
        } catch {
          body = bodyPayload;
        }
      }
      return {
        status,
        body,
        headers,
      };
    },
  };
}

function createTestRequest(
  executeQuery: QueryExecutor,
  method: string,
  requestPath: string,
  fetchImpl?: typeof fetch
): TestApiRequest {
  const headers: Record<string, string> = {};
  let body: unknown;

  const parsed = url.parse(requestPath);
  const requestApiPath = parsed.pathname || '/';
  const query = querystring.parse(parsed.query || '');

  const req = {
    method,
    headers,
    socket: { remoteAddress: '203.0.113.10' },
  } as IncomingMessage;

  const invoke = async (): Promise<ApiResult> => {
    const capture = createMockResponseCapture();
    const handled = await handleStationDiscoveryRequest({
      path: requestApiPath,
      method,
      query,
      req,
      res: capture.res,
      body: parseBodyInput(body),
      executeQuery,
      fetchImpl,
    });

    if (!handled) {
      return {
        status: 404,
        body: { error: 'not found' },
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      };
    }

    return capture.getResult();
  };

  const requestObject = {
    set(header: string, value: string): TestApiRequest {
      headers[header.toLowerCase()] = value;
      return requestObject;
    },
    send(payload: unknown): Promise<ApiResult> {
      body = payload;
      return invoke();
    },
  } as TestApiRequest;

  requestObject.then = (onFulfilled, onRejected): Promise<unknown> => {
    return invoke().then(onFulfilled, onRejected);
  };

  return requestObject;
}

async function requestWithTestServer(
  executeQuery: QueryExecutor,
  callback: (api: TestApi) => Promise<unknown>,
  fetchImpl?: typeof fetch
): Promise<unknown> {
  const api: TestApi = {
    get: (path) => createTestRequest(executeQuery, 'GET', path, fetchImpl),
    post: (path) => createTestRequest(executeQuery, 'POST', path, fetchImpl),
    delete: (path) => createTestRequest(executeQuery, 'DELETE', path, fetchImpl),
  };
  return await callback(api);
}

describe('station discovery + provisioning endpoints', () => {
  beforeEach(() => {
    resetStationDiscoveryRateLimiter();
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
  });

  afterEach(() => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
  });

  it('returns discovery response shape for ecowitt, ambient, and davis', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const fetchImpl = jest.fn(async (input: string): Promise<any> => {
      if (input.includes('/get_livedata_info')) {
        return createMockResponse({
          ok: true,
          headers: { 'content-type': 'application/json' },
          body: {
            model: 'GW1100A',
            mac: 'EC:01:AA:BB:CC:01',
            firmware: 'v3.1.0',
          },
        });
      }

      if (input.includes('rt.ambientweather.net')) {
        return createMockResponse({
          ok: true,
          headers: { 'content-type': 'application/json' },
          body: [
            {
              macAddress: 'AM:02:DD:EE:FF:02',
              info: {
                name: 'Backyard Ambient',
                model: 'WS-5000',
                firmwareVersion: '1.9.2',
              },
            },
          ],
        });
      }

      if (input.includes('api.weatherlink.com')) {
        return createMockResponse({
          ok: true,
          headers: { 'content-type': 'application/json' },
          body: {
            stations: [
              {
                station_id_uuid: 'davis-station-uuid',
                station_type: 'Vantage Pro2',
                firmware_version: '2.1.0',
              },
            ],
          },
        });
      }

      return createMockResponse({ ok: false, status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    const response = await requestWithTestServer(executeQuery, (api) => api
      .post('/api/v1/stations/discover')
      .set('x-forwarded-for', '203.0.113.10')
      .send({
        ecowittHosts: ['10.0.0.20'],
        ambient: {
          apiKey: 'ambient-key',
          applicationKey: 'ambient-app-key',
        },
        davis: {
          apiKey: 'davis-key',
        },
      }), fetchImpl) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.total).toBe(3);
    expect(response.body.data.totalsByType).toEqual(
      expect.objectContaining({ ecowitt: 1, ambient: 1, davis: 1 })
    );
    expect(response.body.data.discoveredStations[0]).toEqual(
      expect.objectContaining({
        stationType: expect.any(String),
        stationId: expect.any(String),
      })
    );
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('rejects ecowitt hostnames and IPv6 literals in the station allowlist', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const fetchImpl = jest.fn(async (): Promise<any> =>
      createMockResponse({ ok: false, status: 404, statusText: 'Not Found' })
    ) as unknown as typeof fetch;

    const response = await requestWithTestServer(executeQuery, (api) => api
      .post('/api/v1/stations/discover')
      .set('x-forwarded-for', '203.0.113.12')
      .send({
        ecowittHosts: ['::1', 'localhost'],
      }), fetchImpl) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.total).toBe(0);
    expect(response.body.data.totalsByType).toEqual(
      expect.objectContaining({ ecowitt: 0, ambient: 0, davis: 0 })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('rejects redirected ecowitt discovery targets that jump outside LAN allowlist', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const fetchImpl = jest.fn(async (input: string): Promise<any> => {
      if (input === 'http://192.168.4.1/get_livedata_info') {
        return createMockResponse({
          ok: false,
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
          statusText: 'Found',
        });
      }

      if (input === 'http://192.168.4.1/api/v1/device/info') {
        return createMockResponse({
          ok: false,
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
          statusText: 'Found',
        });
      }

      if (input === 'http://192.168.4.1/') {
        return createMockResponse({
          ok: false,
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
          statusText: 'Found',
        });
      }

      return createMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
    }) as unknown as typeof fetch;

    const response = await requestWithTestServer(executeQuery, (api) => api
      .post('/api/v1/stations/discover')
      .set('x-forwarded-for', '203.0.113.13')
      .send({ ecowittHosts: ['192.168.4.1'] }), fetchImpl) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.total).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.4.1/get_livedata_info',
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rate-limits discovery scans to one request per minute per IP', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const fetchImpl = jest.fn(async (): Promise<any> =>
      createMockResponse({ ok: false, status: 404, statusText: 'Not Found' })
    ) as unknown as typeof fetch;

    const first = await requestWithTestServer(executeQuery, (api) => api
      .post('/api/v1/stations/discover')
      .set('x-forwarded-for', '203.0.113.11')
      .send({ ecowittHosts: ['10.0.0.30'] }), fetchImpl) as any;
    expect(first.status).toBe(200);

    const second = await requestWithTestServer(executeQuery, (api) => api
      .post('/api/v1/stations/discover')
      .set('x-forwarded-for', '203.0.113.11')
      .send({ ecowittHosts: ['10.0.0.31'] }), fetchImpl) as any;

    expect(second.status).toBe(429);
    expect(second.body.success).toBe(false);
    expect(second.body.error).toContain('Rate limit exceeded');
  });

  it('provisioning inserts station registration and returns auth token', async () => {
    // Provisioning is now fail-closed: an operator token is required.
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-secret';

    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          device_id: 'ecowitt-10-0-0-40',
          device_type: 'ecowitt',
          owner_address: '0x1234567890123456789012345678901234567890',
        },
      ],
    }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/provision')
      .set('x-wrfcoin-operator-token', 'test-operator-secret')
      .send({
        stationType: 'ecowitt',
        stationId: 'ecowitt-10-0-0-40',
        ownerAddress: '0x1234567890123456789012345678901234567890',
        pollingIntervalSeconds: 90,
        model: 'GW1100A',
        macAddress: 'EC:01:AA:BB:CC:01',
        firmwareVersion: 'v3.1.0',
        connection: {
          host: '10.0.0.40',
        },
      })
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.stationId).toBe('ecowitt-10-0-0-40');
    expect(response.body.data.authToken).toEqual(expect.any(String));
    expect(response.body.data.authToken.length).toBeGreaterThan(20);
    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(String(executeQuery.mock.calls[0][0])).toContain('INSERT INTO devices_consolidated');
  });

  it('rejects provisioning with invalid ownerAddress (authenticated request)', async () => {
    // Provisioning is now fail-closed: supply a valid operator token so auth
    // passes, but use a bad ownerAddress so payload validation returns 400.
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-secret';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/provision')
      .set('x-wrfcoin-operator-token', 'test-operator-secret')
      .send({
        stationType: 'ecowitt',
        stationId: 'ecowitt-invalid-owner',
        ownerAddress: 'not-a-wallet',
        connection: { host: '10.0.0.99' },
      })
    ) as any;

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('ownerAddress');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('requires operator token for provisioning when operator auth is configured', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-secret';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/provision')
      .send({
        stationType: 'ecowitt',
        ownerAddress: '0x1234567890123456789012345678901234567890',
        connection: { host: '10.0.0.40' },
      })
    ) as any;

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('verifies station first reading status via /stations/:id/verify', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-secret';

    const executeQuery = jest
      .fn<ReturnType<QueryExecutor>, Parameters<QueryExecutor>>()
      // station lookup
      .mockResolvedValueOnce({
        rows: [{ device_id: 'ambient-station-verify', device_type: 'ambient', is_active: false }],
      })
      // reading summary
      .mockResolvedValueOnce({
        rows: [
          {
            total_readings: 3,
            valid_readings: 2,
            first_reading_at: '2026-03-22T12:00:00.000Z',
            last_reading_at: '2026-03-23T12:00:00.000Z',
          },
        ],
      })
      // update verification status
      .mockResolvedValueOnce({
        rows: [
          {
            device_id: 'ambient-station-verify',
            device_type: 'ambient',
            is_active: true,
            updated_at: '2026-03-23T12:30:00.000Z',
          },
        ],
      });

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/ambient-station-verify/verify')
      .set('Authorization', 'Bearer operator-secret')
      .send({})
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.verificationStatus).toBe('verified');
    expect(response.body.data.isActive).toBe(true);
    expect(executeQuery).toHaveBeenCalledTimes(3);
  });

  it('requires auth for station decommission delete', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.delete('/api/v1/stations/ecowitt-10-0-0-40')
    ) as any;
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('decommissions station using station auth token', async () => {
    const executeQuery = jest
      .fn<ReturnType<QueryExecutor>, Parameters<QueryExecutor>>()
      // station token auth query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      // decommission CTE
      .mockResolvedValueOnce({
        rows: [
          {
            device_id: 'ecowitt-10-0-0-40',
            device_type: 'ecowitt',
            owner_address: '0x1234567890123456789012345678901234567890',
            is_active: false,
            decommissioned_at: '2026-03-23T13:00:00.000Z',
            last_reading_at: '2026-03-23T12:00:00.000Z',
            total_readings: 42,
            avg_quality_score_24h: 90.1,
          },
        ],
      });

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .delete('/api/v1/stations/ecowitt-10-0-0-40')
      .set('x-station-auth-token', 'station-secret')
      .send({ reason: 'operator_requested' })
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('decommissioned');
    expect(response.body.data.isActive).toBe(false);
    expect(response.body.data.finalStatus.totalReadings).toBe(42);
    expect(executeQuery).toHaveBeenCalledTimes(2);
  });

  it('status endpoint returns connection health for provisioned stations', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          device_id: 'ambient-station-42',
          device_type: 'ambient',
          owner_address: '0x9999999999999999999999999999999999999999',
          device_metadata: {
            model: 'WS-5000',
            macAddress: 'AM:99:88:77:66:55',
            firmwareVersion: '2.0.1',
          },
          last_reading_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          avg_quality_score: 94.25,
          readings_24h: 288,
        },
      ],
    }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.get('/api/v1/stations/status')
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.summary.total).toBe(1);
    expect(response.body.data.summary.online).toBe(1);
    expect(response.body.data.stations[0]).toEqual(
      expect.objectContaining({
        stationId: 'ambient-station-42',
        stationType: 'ambient',
        connectionStatus: 'online',
        dataFlowing: true,
      })
    );
  });

  // ── backend#1113: anonymous callers must not see owner/hardware identity ──

  it('status endpoint strips ownerAddress/macAddress/firmwareVersion for an anonymous caller (backend#1113)', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          device_id: 'ambient-station-42',
          device_type: 'ambient',
          owner_address: '0x9999999999999999999999999999999999999999',
          device_metadata: {
            model: 'WS-5000',
            macAddress: 'AM:99:88:77:66:55',
            firmwareVersion: '2.0.1',
          },
          last_reading_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          avg_quality_score: 94.25,
          readings_24h: 288,
        },
      ],
    }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.get('/api/v1/stations/status')
    ) as any;

    expect(response.status).toBe(200);
    const station = response.body.data.stations[0];
    expect(station).not.toHaveProperty('ownerAddress');
    expect(station).not.toHaveProperty('model');
    expect(station).not.toHaveProperty('macAddress');
    expect(station).not.toHaveProperty('firmwareVersion');
    // Connectivity/quality telemetry stays public.
    expect(station.stationId).toBe('ambient-station-42');
    expect(station.connectionStatus).toBe('online');
    expect(station.dataQualityScore24h).toBe(94.25);
  });

  it('status endpoint includes owner/hardware identity for a valid operator-token caller (backend#1113)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-secret';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          device_id: 'ambient-station-42',
          device_type: 'ambient',
          owner_address: '0x9999999999999999999999999999999999999999',
          device_metadata: {
            model: 'WS-5000',
            macAddress: 'AM:99:88:77:66:55',
            firmwareVersion: '2.0.1',
          },
          last_reading_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          avg_quality_score: 94.25,
          readings_24h: 288,
        },
      ],
    }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.get('/api/v1/stations/status').set('x-wrfcoin-operator-token', 'expected-secret')
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.data.stations[0]).toEqual(
      expect.objectContaining({
        ownerAddress: '0x9999999999999999999999999999999999999999',
        model: 'WS-5000',
        macAddress: 'AM:99:88:77:66:55',
        firmwareVersion: '2.0.1',
      })
    );
  });

  it('ignores ?ownerAddress= for an anonymous caller — does not filter by it and does not leak it back (backend#1113)', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          device_id: 'ambient-station-42',
          device_type: 'ambient',
          owner_address: '0x9999999999999999999999999999999999999999',
          device_metadata: {},
          last_reading_at: new Date().toISOString(),
          avg_quality_score: 90,
          readings_24h: 10,
        },
      ],
    }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.get('/api/v1/stations/status?ownerAddress=0x9999999999999999999999999999999999999999')
    ) as any;

    expect(response.status).toBe(200);
    // The query param passed to SQL is null (unfiltered), not the requested address.
    const [, params] = executeQuery.mock.calls[0];
    expect(params).toEqual([null]);
    expect(response.body.data.stations[0]).not.toHaveProperty('ownerAddress');
  });

  it('honors ?ownerAddress= as a filter for a valid operator-token caller (backend#1113)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-secret';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    await requestWithTestServer(
      executeQuery,
      (api) =>
        api
          .get('/api/v1/stations/status?ownerAddress=0x1111111111111111111111111111111111111111')
          .set('x-wrfcoin-operator-token', 'expected-secret')
    );

    const [, params] = executeQuery.mock.calls[0];
    expect(params).toEqual(['0x1111111111111111111111111111111111111111']);
  });

  // ── backend#1210: owner addresses are case-insensitive ─────────────────
  it('provisioning stores a checksummed ownerAddress in canonical lowercase (backend#1210)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-secret';
    const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
        .post('/api/v1/stations/provision')
        .set('x-wrfcoin-operator-token', 'test-operator-secret')
        .send({
          stationType: 'ecowitt',
          stationId: 'ecowitt-10-0-0-41',
          ownerAddress: MIXED,
          connection: { host: '10.0.0.41' },
        })
    ) as any;

    expect(response.status).toBe(200);
    const [sql, params] = executeQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO devices_consolidated');
    expect(params[2]).toBe(MIXED.toLowerCase());
    expect(response.body.data.ownerAddress).toBe(MIXED.toLowerCase());
  });

  it('operator ?ownerAddress= filter matches stored rows regardless of case (backend#1210)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-secret';
    const STORED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    // Row-backed: evaluates the owner predicate the way Postgres would for
    // the SQL actually sent, so exact equality would hide the row.
    const executeQuery = jest.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      const want = params?.[0];
      const ci = /lower\(d\.owner_address\) = lower\(\$1\)/.test(sql);
      const hit = want === null || (ci ? STORED.toLowerCase() === String(want).toLowerCase() : STORED === want);
      return {
        rows: hit
          ? [{ device_id: 'ecowitt-1', device_type: 'ecowitt', owner_address: STORED, device_metadata: {}, network_config: {} }]
          : [],
      };
    });

    const response = await requestWithTestServer(
      executeQuery,
      (api) =>
        api
          .get(`/api/v1/stations/status?ownerAddress=${STORED.toLowerCase()}`)
          .set('x-wrfcoin-operator-token', 'expected-secret')
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.data.stations).toHaveLength(1);
  });

  // ── backend#1115 review: a CONTRIBUTOR credential is not an operator ──────
  //
  // The status read was gated on `hasValidOperatorToken`, which also accepts
  // WRFCOIN_CONTRIBUTOR_TOKEN (bearer or `x-contributor-token`) — so a
  // contributor credential bought global owner/hardware visibility and the
  // `?ownerAddress=` per-address probe. It is now gated on an operator-ONLY
  // predicate. Every case below sets BOTH env tokens, to distinct values, so
  // the two credentials are genuinely distinguishable.

  const OPERATOR_SECRET = 'operator-secret-value';
  const CONTRIBUTOR_SECRET = 'contributor-secret-value';

  const statusRow = () => ({
    device_id: 'ambient-station-42',
    device_type: 'ambient',
    owner_address: '0x9999999999999999999999999999999999999999',
    device_metadata: {
      model: 'WS-5000',
      macAddress: 'AM:99:88:77:66:55',
      firmwareVersion: '2.0.1',
    },
    last_reading_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    avg_quality_score: 94.25,
    readings_24h: 288,
  });

  const statusQuery = () => jest.fn(async (): Promise<QueryResult> => ({ rows: [statusRow()] }));

  const expectMaskedStation = (response: any, executeQuery: any): void => {
    expect(response.status).toBe(200);
    const station = response.body.data.stations[0];
    expect(station).not.toHaveProperty('ownerAddress');
    expect(station).not.toHaveProperty('model');
    expect(station).not.toHaveProperty('macAddress');
    expect(station).not.toHaveProperty('firmwareVersion');
    // Public telemetry still served.
    expect(station.stationId).toBe('ambient-station-42');
    expect(station.connectionStatus).toBe('online');
    // ...and the ?ownerAddress= filter was dropped: SQL owner parameter is null.
    const [, params] = executeQuery.mock.calls[0];
    expect(params).toEqual([null]);
  };

  const OWNER_PROBE =
    '/api/v1/stations/status?ownerAddress=0x9999999999999999999999999999999999999999';

  it('masks owner/hardware fields and drops the ?ownerAddress= filter for a CONTRIBUTOR bearer token (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    const response = await requestWithTestServer(executeQuery, (api) =>
      api.get(OWNER_PROBE).set('authorization', `Bearer ${CONTRIBUTOR_SECRET}`)
    ) as any;

    expectMaskedStation(response, executeQuery);
  });

  it('masks owner/hardware fields and drops the ?ownerAddress= filter for an x-contributor-token caller (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    const response = await requestWithTestServer(executeQuery, (api) =>
      api.get(OWNER_PROBE).set('x-contributor-token', CONTRIBUTOR_SECRET)
    ) as any;

    expectMaskedStation(response, executeQuery);
  });

  it('still serves full fields and honors ?ownerAddress= for a valid OPERATOR token while a contributor token is also configured (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    const response = await requestWithTestServer(executeQuery, (api) =>
      api
        .get('/api/v1/stations/status?ownerAddress=0x1111111111111111111111111111111111111111')
        .set('authorization', `Bearer ${OPERATOR_SECRET}`)
    ) as any;

    expect(response.status).toBe(200);
    expect(response.body.data.stations[0]).toEqual(
      expect.objectContaining({
        ownerAddress: '0x9999999999999999999999999999999999999999',
        model: 'WS-5000',
        macAddress: 'AM:99:88:77:66:55',
        firmwareVersion: '2.0.1',
      })
    );
    const [, params] = executeQuery.mock.calls[0];
    expect(params).toEqual(['0x1111111111111111111111111111111111111111']);
  });

  it('masks owner/hardware fields for a WRONG operator token (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    const response = await requestWithTestServer(executeQuery, (api) =>
      api.get(OWNER_PROBE).set('x-wrfcoin-operator-token', 'not-the-operator-secret')
    ) as any;

    expectMaskedStation(response, executeQuery);
  });

  it('masks owner/hardware fields when no token is presented at all (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    const response = await requestWithTestServer(executeQuery, (api) =>
      api.get(OWNER_PROBE)
    ) as any;

    expectMaskedStation(response, executeQuery);
  });

  it('masks owner/hardware fields for a wallet-authenticated caller with no operator token (backend#1115)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR_SECRET;
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_SECRET;
    const executeQuery = statusQuery();

    // A caller authenticated only as themselves: a wallet JWT on the bearer
    // channel. Per backend#1113's design note this sees the anonymous shape.
    const response = await requestWithTestServer(executeQuery, (api) =>
      api
        .get(OWNER_PROBE)
        .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.wallet-session-token.signature')
        .set('x-wallet-address', '0x9999999999999999999999999999999999999999')
    ) as any;

    expectMaskedStation(response, executeQuery);
  });

  // ── #823: provisioning fail-closed behaviour ─────────────────────────────

  it('returns 503 when WRFCOIN_OPERATOR_TOKEN is not configured in env (#823)', async () => {
    // beforeEach already deletes both token env vars — no token = server misconfiguration
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/provision')
      .set('x-wrfcoin-operator-token', 'any-token')
      .send({
        stationType: 'ecowitt',
        ownerAddress: '0x1234567890123456789012345678901234567890',
        connection: { host: '10.0.0.40' },
      })
    ) as any;

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('not configured');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('returns 401 when WRFCOIN_OPERATOR_TOKEN is configured but client provides no token (#823)', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-secret';
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const response = await requestWithTestServer(
      executeQuery,
      (api) => api
      .post('/api/v1/stations/provision')
      .send({
        stationType: 'ecowitt',
        ownerAddress: '0x1234567890123456789012345678901234567890',
        connection: { host: '10.0.0.40' },
      })
    ) as any;

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('rejects hostname and IPv6 ecowitt targets without outbound fetches', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const fetchImpl = jest.fn(async () =>
      createMockResponse({ ok: false, status: 404, statusText: 'Not Found' })
    ) as any;

    const response = await requestWithTestServer(
      executeQuery,
      (api) =>
        api.post('/api/v1/stations/discover').send({
          ecowittHosts: ['localhost', '::1', 'https://127.0.0.1'],
        }),
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.totalsByType.ecowitt).toBe(0);
    expect(response.body.data.total).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks ecowitt redirect chains from reaching blocked targets', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const calls: string[] = [];

    const fetchImpl = jest.fn(async (input: string): Promise<any> => {
      calls.push(input.toString());
      return createMockResponse({
        ok: true,
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://evil.example.net/ssrf' },
      });
    }) as any;

    const response = await requestWithTestServer(
      executeQuery,
      (api) => api.post('/api/v1/stations/discover').send({ ecowittHosts: ['192.168.1.10'] }),
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.totalsByType.ecowitt).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((value) => value.startsWith('http://192.168.1.10'))).toBe(true);
  });

  it('shows allowlist as the controlling factor by contrasting control mode', async () => {
    const blockedTarget = 'http://169.254.169.254/cgi-bin/';

    const fetchImpl = jest.fn(async () =>
      createMockResponse({ ok: true, body: { success: true }, status: 200 })
    ) as any;
    await expect(
      stationDiscovery.fetchWithRedirects(fetchImpl, blockedTarget, 50)
    ).rejects.toThrow('Unreachable host blocked by allowlist');
    expect(fetchImpl).not.toHaveBeenCalled();

    const bypassFetchImpl = jest.fn(async () =>
      createMockResponse({ ok: true, body: { success: true }, status: 200 })
    ) as any;

    await expect(
      stationDiscovery.fetchWithRedirects(bypassFetchImpl, blockedTarget, 50, 5, () => true)
    ).resolves.toBeDefined();
    expect(bypassFetchImpl).toHaveBeenCalledTimes(1);
  });
});
