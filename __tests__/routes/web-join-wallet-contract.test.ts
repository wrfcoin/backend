/** HTTP routes with real JWT middleware, Reader credentials and registration service.
 * External node/provider/store boundaries use synthetic doubles; no live network.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../server/utils/logger', () => ({ logger: mockLogger, appLogger: mockLogger, securityLogger: mockLogger }));
jest.mock('../../utils/logger', () => ({ logger: mockLogger }));
jest.mock('../../config', () => ({}));
jest.mock('../../server/controllers/enhanced-weather-controller', () => jest.fn(() => ({})));
const mockQuery = jest.fn();
const mockClient = { query: mockQuery, release: jest.fn() };
jest.mock('../../server/db', () => ({ pool: { connect: async () => mockClient } }));
const mockExecute = jest.fn();
jest.mock('../../database/index', () => ({ executeQuery: (...args: any[]) => mockExecute(...args) }));
const mockRedis = { eval: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn(), zremrangebyscore: jest.fn() };
jest.mock('../../server/utils/create-redis', () => ({ createRedisClient: () => mockRedis }));
const mockNode = jest.fn();
jest.mock('../../shared/core4-node-http', () => ({ nodeHttpFetch: (...args: any[]) => mockNode(...args) }));

const OWNER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);
const STATION = 'synthetic-web-station';
const MAC = 'AA:BB:CC:DD:EE:FF';
const HASH = '33'.repeat(32);
const SECRET = 'synthetic-web-join-jwt-secret-at-least-32-characters';
const ENV = { JWT_SECRET: SECRET, API_KEY_ENCRYPTION_KEY: '44'.repeat(32),
  CORE4_API_URL: 'http://core4.invalid', WRFCOIN_READER_TOKEN: 'synthetic-reader',
  FAUCET_SERVICE_URL: 'http://faucet.invalid/claim', FAUCET_SERVICE_TOKEN: 'synthetic-faucet' };
const saved = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
Object.assign(process.env, ENV);
const wallet = require('../../server/routes/wallet-routes');
const weather = require('../../server/routes/weather-routes');
const onboarding = require('../../server/routes/onboarding-routes').default;
const { createStationDetailRouter } = require('../../server/routes/station-detail-routes');
const { stationAlias } = require('../../server/utils/station-alias');

function token(address = OWNER, type = 'access') {
  return jwt.sign({ sub: address, address, type, role: 'wallet', wallet_scheme: 'ed25519',
    iat: Math.floor(Date.now()/1000) }, SECRET,
  { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '15m' });
}
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', createStationDetailRouter());
  a.use('/api/onboarding', onboarding);
  a.use('/api/wallet', wallet);
  a.use('/api/weather', weather.default ?? weather);
  return a;
}
function response(value: any, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(value), json: async () => value };
}
let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(1790000000000);
  mockRedis.eval.mockResolvedValue([1, 'RESERVED', '']);
  mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('COUNT(*)') ? [{ n: 0 }] : [] }));
  mockExecute.mockImplementation(async (sql: string) => ({ rows: sql.includes('weather_stations') ? [{ station_id: STATION }] : [] }));
  mockNode.mockImplementation(async (url: string, init: any) => {
    if (init.headers.authorization !== 'Bearer synthetic-reader') return response({ ok: false }, 403);
    if (url.includes('/addresses/')) return response({ ok: true, data: { balance: '200000000', spendable_balance: '200000000', nonce: '1' } });
    if (url.includes('/observations')) return response({ ok: true, data: {
      items: [{ commit_id: HASH, station_id: STATION, height: 100, observed_at: 1790000000,
        values: {}, provenance_class: 'real', attestation: null }],
      limit: 100, next_after: 100, next_offset: 0, has_more: false,
      chain_height: 100, state_tip: '55'.repeat(32), scanned_transactions: 1,
    } });
    if (url.includes('/reward-evidence')) return response({ ok: true, data: {
      commit_id: HASH, rewarded: false, rewarded_blocker: 'no_reward_record',
      contribution: { status: 'pending' }, reward: null, block: null, account: null,
    } });
    throw new Error('unexpected synthetic node route');
  });
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    if (String(url).startsWith('http://faucet.invalid/')) {
      expect(init.headers.authorization).toBe('Bearer synthetic-faucet');
      return response({ txHash: HASH, amount: '100', balance: '200000000' }) as any;
    }
    if (String(url).includes('ambientweather')) return response([{ macAddress: MAC }]) as any;
    throw new Error('unexpected synthetic provider route');
  });
});
afterEach(() => { fetchSpy.mockRestore(); jest.restoreAllMocks(); });
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

describe('web join with the wallet-login access-token contract', () => {
  it('reads its own address using the server Reader bearer, excluding caller credentials', async () => {
    const res = await request(app()).get('/api/wallet/'+OWNER).set('authorization', 'Bearer '+token()).set('x-api-key','synthetic-caller-key');
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe('200000000');
    expect(mockNode).toHaveBeenCalledTimes(1);
    expect(mockNode.mock.calls[0][1].headers).toMatchObject({ authorization: 'Bearer synthetic-reader' });
    expect(JSON.stringify(mockNode.mock.calls)).not.toContain('synthetic-caller-key');
  });
  it('refuses another address, an absent bearer and a refresh token before node access', async () => {
    expect((await request(app()).get('/api/wallet/'+OTHER).set('authorization','Bearer '+token())).status).toBe(403);
    expect((await request(app()).get('/api/wallet/'+OWNER)).status).toBe(401);
    expect((await request(app()).get('/api/wallet/'+OWNER).set('authorization','Bearer '+token(OWNER,'refresh'))).status).toBe(401);
    expect(mockNode).not.toHaveBeenCalled();
  });
  it('accepts the public CAPTCHA/claim flow with a wallet bearer and the service credential', async () => {
    const a=app(); const bearer='Bearer '+token();
    const challenge=await request(a).post('/api/onboarding/faucet/challenge').set('authorization',bearer).send({});
    expect(challenge.status).toBe(200);
    const numbers=challenge.body.question.match(/\d+/g).map(Number);
    const res=await request(a).post('/api/onboarding/faucet/claim').set('authorization',bearer)
      .send({walletAddress:OWNER,challengeId:challenge.body.challengeId,answer:numbers[0]+numbers[1]});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({txHash:HASH,amount:'100'});
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  const body={stationId:STATION,name:'Synthetic garden',latitude:1,longitude:2,provider:'ambient',mac:MAC,
    ambientApiKey:'synthetic-provider-key',ambientAppKey:'synthetic-provider-app',elevation_meters:10};
  it('registers Ambient using the verified wallet owner and checks its account MAC', async () => {
    const res=await request(app()).post('/api/weather/stations').set('authorization','Bearer '+token()).send({...body,ownerAddress:OTHER});
    expect(res.status).toBe(201);
    expect(res.body.ownerAddress).toBe(OWNER);
    expect(mockQuery.mock.calls.some(([sql]: any[]) => sql==='COMMIT')).toBe(true);
    const insert=mockQuery.mock.calls.find(([sql]: any[]) => sql.includes('INSERT INTO weather_stations'));
    expect(insert?.[1][1]).toBe(OWNER);
  });
  it('refuses a MAC absent from the provider account without writing a station', async () => {
    const res=await request(app()).post('/api/weather/stations').set('authorization','Bearer '+token()).send({...body,mac:'11:22:33:44:55:66'});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('AMBIENT_MAC_NOT_ON_ACCOUNT');
    expect(mockQuery.mock.calls.some(([sql]: any[]) => sql.includes('INSERT INTO weather_stations'))).toBe(false);
    expect(mockQuery.mock.calls.some(([sql]: any[]) => sql==='ROLLBACK')).toBe(true);
  });
  it('refuses a MAC already held by another active station', async () => {
    mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes("metadata->>'mac'") ? [{station_id:'synthetic-other-station'}] : [] }));
    const res=await request(app()).post('/api/weather/stations').set('authorization','Bearer '+token()).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('MAC_TAKEN');
    expect(mockQuery.mock.calls.some(([sql]: any[]) => sql.includes('INSERT INTO weather_stations'))).toBe(false);
  });
  it('requires a bearer before provider or database work for registration', async () => {
    expect((await request(app()).post('/api/weather/stations').send(body)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(mockQuery).not.toHaveBeenCalled();
  });
  it('reads the honest reward window through the public alias with a wallet bearer', async () => {
    const res=await request(app()).get('/api/stations/'+stationAlias(STATION)+'/earnings').set('authorization','Bearer '+token());
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.window).toMatchObject({commits:1,scope:'recent-observations'});
    expect(res.body.earnings[0]).toMatchObject({rewarded:false,amountWrf:null,blocker:'no_reward_record'});
    expect(JSON.stringify(res.body)).not.toContain(STATION);
    expect(mockNode.mock.calls.every(([,init]: any[]) => init.headers.authorization==='Bearer synthetic-reader')).toBe(true);
    expect((await request(app()).get('/api/stations/'+STATION+'/earnings').set('authorization','Bearer '+token())).status).toBe(404);
  });
});
