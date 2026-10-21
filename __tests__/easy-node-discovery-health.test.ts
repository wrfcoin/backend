import request from 'supertest';

jest.mock('../server/utils/otel-setup.js', () => ({
  initializeOTel: jest.fn(async () => {}),
}));

jest.mock('../server/utils/logger.js', () => ({
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  SuperEasyNodeDiscovery,
} = require('../server/easy_node_discovery.js') as {
  SuperEasyNodeDiscovery: new () => {
    app: Parameters<typeof request>[0];
    setupAPI: () => void;
  };
};

// backend#1224: the service name and dependency detail are reader/operator-only.
process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
const AUTH = { authorization: 'Bearer test-reader-token' };

describe('easy node discovery health endpoints', () => {
  it('exposes /health, /ready, and /live via createHealthMiddleware', async () => {
    const discovery = new SuperEasyNodeDiscovery();
    discovery.setupAPI();

    const healthResponse = await request(discovery.app).get('/health').set(AUTH);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.status).toBe('healthy');
    expect(healthResponse.body.service).toBe('node-discovery');

    const readyResponse = await request(discovery.app).get('/ready').set(AUTH);
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.body.status).toBe('ready');
    expect(readyResponse.body.service).toBe('node-discovery');

    const liveResponse = await request(discovery.app).get('/live').set(AUTH);
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.status).toBe('alive');
    expect(liveResponse.body.service).toBe('node-discovery');
  });
});
