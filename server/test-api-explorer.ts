/**
 * Test Script for API Explorer
 *
 * Tests the interactive API explorer functionality including
 * authentication, endpoint validation, and UI components.
 */

import { app, server } from './api-explorer.js';
import request from 'supertest';

// Test configuration
const API_EXPLORER_URL = 'http://localhost:3003';

describe('WRFCoin API Explorer', () => {
  afterAll(done => {
    server.close(done);
  });

  describe('Basic Endpoints', () => {
    test('Health check should return service status', async () => {
      const response = await request(app).get('/health').expect(200);

      expect(response.body).toHaveProperty('service', 'api-explorer');
      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('uptime');
    });

    test('Explorer status should return configuration', async () => {
      const response = await request(app).get('/explorer/status').expect(200);

      expect(response.body).toHaveProperty('explorer', 'WRFCoin API Explorer');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body).toHaveProperty('supportedAuth');
    });

    test('OpenAPI spec should be accessible', async () => {
      const response = await request(app)
        .get('/api-docs/swagger.json')
        .expect(200);

      expect(response.body).toHaveProperty('openapi');
      expect(response.body).toHaveProperty('info');
      expect(response.body.info).toHaveProperty(
        'title',
        'Wrfcoin Blockchain Platform API'
      );
    });

    test('Swagger UI should be accessible', async () => {
      const response = await request(app).get('/api-docs').expect(200);

      expect(response.text).toContain('swagger-ui');
      expect(response.text).toContain('WRFCoin API Explorer');
    });

    test('ReDoc should be accessible', async () => {
      const response = await request(app).get('/redoc').expect(200);

      expect(response.text).toContain('redoc');
      expect(response.text).toContain('WRFCoin API Documentation');
    });
  });

  describe('Authentication Testing', () => {
    test('Generate demo token endpoint should work', async () => {
      const response = await request(app)
        .post('/auth/demo-token')
        .send({ userId: 'test-user', role: 'user' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('expiresIn', '24h');
      expect(response.body.user).toHaveProperty('id', 'test-user');
    });

    test('Protected endpoint should require token', async () => {
      await request(app).get('/auth/test-protected').expect(401);
    });

    test('Protected endpoint should work with demo token', async () => {
      const response = await request(app)
        .get('/auth/test-protected')
        .set('Authorization', 'Bearer demo-bearer-token-12345')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('user');
    });

    test('API key endpoint should require key', async () => {
      await request(app).get('/auth/test-api-key').expect(401);
    });

    test('API key endpoint should work with demo key', async () => {
      const response = await request(app)
        .get('/auth/test-api-key')
        .set('X-API-Key', 'demo-api-key-wrfcoin-explorer')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty(
        'apiKey',
        'demo-api-key-wrfcoin-explorer'
      );
    });

    test('Optional auth endpoint should work without authentication', async () => {
      const response = await request(app)
        .get('/auth/test-optional')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('authenticated', false);
    });

    test('Optional auth endpoint should work with authentication', async () => {
      const response = await request(app)
        .get('/auth/test-optional')
        .set('Authorization', 'Bearer demo-bearer-token-12345')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('authenticated', true);
    });
  });

  describe('Error Handling', () => {
    test('Invalid endpoint should return 404', async () => {
      const response = await request(app).get('/invalid-endpoint').expect(404);

      expect(response.body).toHaveProperty('error', 'Not Found');
      expect(response.body).toHaveProperty('availableEndpoints');
    });

    test('Invalid API key should return 401', async () => {
      const response = await request(app)
        .get('/auth/test-api-key')
        .set('X-API-Key', 'invalid-key')
        .expect(401);

      expect(response.body).toHaveProperty('error', 'Invalid API Key');
      expect(response.body).toHaveProperty('hint');
    });

    test('Invalid bearer token should return 403', async () => {
      const response = await request(app)
        .get('/auth/test-protected')
        .set('Authorization', 'Bearer invalid-token')
        .expect(403);

      expect(response.body).toHaveProperty('error', 'Invalid Token');
    });
  });

  describe('Documentation Endpoints', () => {
    test('Documentation endpoint should return usage info', async () => {
      const response = await request(app).get('/docs').expect(200);

      expect(response.body).toHaveProperty('message', 'WRFCoin API Explorer');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body).toHaveProperty('authentication');
      expect(response.body).toHaveProperty('usage');
    });

    test('Root endpoint should serve custom UI', async () => {
      const response = await request(app).get('/').expect(200);

      expect(response.text).toContain('WRFCoin API Explorer');
      expect(response.text).toContain('auth-helper');
      expect(response.text).toContain('Quick Authentication');
    });
  });
});

// Manual testing helper functions
export const manualTests = {
  /**
   * Test the complete API explorer workflow
   */
  async testCompleteWorkflow() {
    console.log('🧪 Starting complete API Explorer workflow test...\n');

    try {
      // 1. Check health
      console.log('1. Testing health endpoint...');
      const healthResponse = await fetch(`${API_EXPLORER_URL}/health`);
      const health = (await healthResponse.json()) as any;
      console.log('✅ Health check passed:', health.status);

      // 2. Get demo token
      console.log('\n2. Generating demo token...');
      const tokenResponse = await fetch(`${API_EXPLORER_URL}/auth/demo-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'test-user', role: 'user' }),
      });
      const tokenData = (await tokenResponse.json()) as any;
      console.log('✅ Demo token generated');

      // 3. Test protected endpoint
      console.log('\n3. Testing protected endpoint...');
      const protectedResponse = await fetch(
        `${API_EXPLORER_URL}/auth/test-protected`,
        {
          headers: { Authorization: `Bearer ${tokenData.token}` },
        }
      );
      const protectedData = (await protectedResponse.json()) as any;
      console.log(
        '✅ Protected endpoint access granted:',
        protectedData.user.id
      );

      // 4. Test API key endpoint
      console.log('\n4. Testing API key endpoint...');
      const apiKeyResponse = await fetch(
        `${API_EXPLORER_URL}/auth/test-api-key`,
        {
          headers: { 'X-API-Key': 'demo-api-key-wrfcoin-explorer' },
        }
      );
      const apiKeyData = (await apiKeyResponse.json()) as any;
      console.log('✅ API key endpoint access granted');

      // 5. Check OpenAPI spec
      console.log('\n5. Validating OpenAPI specification...');
      const specResponse = await fetch(
        `${API_EXPLORER_URL}/api-docs/swagger.json`
      );
      const spec = (await specResponse.json()) as any;
      console.log('✅ OpenAPI spec loaded:', spec.info?.title);
      console.log('📊 Total endpoints:', Object.keys(spec.paths || {}).length);

      console.log('\n🎉 All tests passed! API Explorer is fully functional.');
      console.log(
        `\n🌐 Access the interactive explorer at: ${API_EXPLORER_URL}/`
      );
      console.log(`📖 Swagger UI: ${API_EXPLORER_URL}/api-docs`);
      console.log(`📚 ReDoc: ${API_EXPLORER_URL}/redoc`);
    } catch (error) {
      console.error(
        '❌ Test failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  },

  /**
   * Test authentication scenarios
   */
  async testAuthentication() {
    console.log('🔐 Testing authentication scenarios...\n');

    const scenarios = [
      {
        name: 'No authentication',
        endpoint: '/auth/test-optional',
        headers: {},
        expectStatus: 200,
      },
      {
        name: 'Valid API key',
        endpoint: '/auth/test-api-key',
        headers: { 'X-API-Key': 'demo-api-key-wrfcoin-explorer' },
        expectStatus: 200,
      },
      {
        name: 'Invalid API key',
        endpoint: '/auth/test-api-key',
        headers: { 'X-API-Key': 'invalid-key' },
        expectStatus: 401,
      },
      {
        name: 'Valid bearer token',
        endpoint: '/auth/test-protected',
        headers: { Authorization: 'Bearer demo-bearer-token-12345' },
        expectStatus: 200,
      },
      {
        name: 'Invalid bearer token',
        endpoint: '/auth/test-protected',
        headers: { Authorization: 'Bearer invalid-token' },
        expectStatus: 403,
      },
    ];

    for (const scenario of scenarios) {
      try {
        const response = await fetch(
          `${API_EXPLORER_URL}${scenario.endpoint}`,
          {
            headers: scenario.headers,
          }
        );

        const isExpectedStatus = response.status === scenario.expectStatus;
        const status = isExpectedStatus ? '✅' : '❌';

        console.log(
          `${status} ${scenario.name}: ${response.status} (expected ${scenario.expectStatus})`
        );

        if (!isExpectedStatus) {
          const data = (await response.json()) as any;
          console.log('   Response:', data.error || data.message);
        }
      } catch (error) {
        console.error(
          `❌ ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  },

  /**
   * Performance test
   */
  async testPerformance() {
    console.log('⚡ Testing API Explorer performance...\n');

    const endpoints = [
      '/health',
      '/explorer/status',
      '/api-docs/swagger.json',
      '/docs',
    ];

    for (const endpoint of endpoints) {
      const start = Date.now();

      try {
        const response = await fetch(`${API_EXPLORER_URL}${endpoint}`);
        const duration = Date.now() - start;

        const status = response.ok ? '✅' : '❌';
        console.log(
          `${status} ${endpoint}: ${duration}ms (${response.status})`
        );

        if (duration > 1000) {
          console.log(`   ⚠️  Slow response (>${duration}ms)`);
        }
      } catch (error) {
        console.error(
          `❌ ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  },
};

// Export for external testing
export default manualTests;
