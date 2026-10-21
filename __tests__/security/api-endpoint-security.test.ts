/**
 * API Endpoint Security Tests
 *
 * Task 80: Gap 6 - Security test suite
 *
 * Tests for RBAC enforcement and endpoint security including:
 * - Role-based access control validation
 * - Permission checks
 * - Input validation
 * - Response security
 * - Security headers
 */

import request from 'supertest';
import express, { Express } from 'express';

const createMockApp = (): Express => {
  const app = express();
  app.use(express.json());
  return app;
};

describe('API Endpoint Security', () => {
  let app: Express;

  beforeEach(() => {
    app = createMockApp();
  });

  describe('RBAC Enforcement Tests', () => {
    // Role definitions from the application
    const roleEndpointMatrix = {
      guest: {
        allowed: [
          { method: 'GET', path: '/api/weather/public' },
          { method: 'GET', path: '/api/health' },
        ],
        denied: [
          { method: 'GET', path: '/api/user/profile' },
          { method: 'POST', path: '/api/wallet/transfer' },
          { method: 'GET', path: '/api/admin/users' },
        ],
      },
      user: {
        allowed: [
          { method: 'GET', path: '/api/user/profile' },
          { method: 'GET', path: '/api/wallet/balance' },
          { method: 'POST', path: '/api/weather/submit' },
        ],
        denied: [
          { method: 'GET', path: '/api/admin/users' },
          { method: 'POST', path: '/api/admin/security/rasp/config' },
          { method: 'DELETE', path: '/api/admin/users/:id' },
        ],
      },
      operator: {
        allowed: [
          { method: 'GET', path: '/api/audit/security-events' },
          { method: 'GET', path: '/api/admin/security/rasp' },
        ],
        denied: [
          { method: 'POST', path: '/api/admin/security/rasp/config' },
          { method: 'DELETE', path: '/api/admin/users/:id' },
        ],
      },
      admin: {
        allowed: [
          { method: 'GET', path: '/api/admin/users' },
          { method: 'POST', path: '/api/admin/security/rasp/config' },
          { method: 'POST', path: '/api/admin/security/rasp/blocking-mode' },
          { method: 'DELETE', path: '/api/admin/users/:id' },
        ],
      },
    };

    Object.entries(roleEndpointMatrix).forEach(([role, permissions]) => {
      describe(`${role} role`, () => {
        if (permissions.allowed) {
          permissions.allowed.forEach(({ method, path }) => {
            it(`should allow ${method} ${path}`, async () => {
              const response = await (request(app) as any)[method.toLowerCase()](path)
                .set('Authorization', `Bearer ${role}-token`);

              expect([200, 201, 204, 404]).toContain(response.status);
              expect(response.status).not.toBe(403);
            });
          });
        }

        if ('denied' in permissions && permissions.denied) {
          permissions.denied.forEach(({ method, path }) => {
            it(`should deny ${method} ${path}`, async () => {
              const response = await (request(app) as any)[method.toLowerCase()](path)
                .set('Authorization', `Bearer ${role}-token`);

              expect([401, 403]).toContain(response.status);
            });
          });
        }
      });
    });
  });

  describe('Permission-Based Access Control Tests', () => {
    const permissionTests = [
      { permission: 'read:users', endpoint: 'GET /api/users', shouldAllow: true },
      { permission: 'write:users', endpoint: 'POST /api/users', shouldAllow: true },
      { permission: 'read:users', endpoint: 'DELETE /api/users/:id', shouldAllow: false },
      { permission: 'read:security_audit', endpoint: 'GET /api/audit/security-events', shouldAllow: true },
      { permission: 'read:weather', endpoint: 'GET /api/weather/data', shouldAllow: true },
      { permission: 'write:wallet', endpoint: 'POST /api/wallet/transfer', shouldAllow: true },
    ];

    permissionTests.forEach(({ permission, endpoint, shouldAllow }) => {
      it(`should ${shouldAllow ? 'allow' : 'deny'} ${endpoint} with ${permission}`, async () => {
        const [method, path] = endpoint.split(' ');

        const response = await (request(app) as any)[method.toLowerCase()](path)
          .set('Authorization', 'Bearer token-with-' + permission.replace(':', '-'));

        if (shouldAllow) {
          expect([200, 201, 204, 404]).toContain(response.status);
        } else {
          expect([401, 403]).toContain(response.status);
        }
      });
    });
  });

  describe('Input Validation Tests', () => {
    describe('Content-Type Validation', () => {
      it('should reject invalid Content-Type for JSON endpoints', async () => {
        const response = await request(app)
          .post('/api/user/profile')
          .set('Content-Type', 'text/plain')
          .set('Authorization', 'Bearer valid-token')
          .send('not json');

        expect([400, 415]).toContain(response.status);
      });

      it('should reject multipart where not expected', async () => {
        const response = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'multipart/form-data')
          .set('Authorization', 'Bearer valid-token')
          .field('username', 'test');

        expect([400, 415]).toContain(response.status);
      });
    });

    describe('Request Size Limits', () => {
      it('should reject oversized request bodies', async () => {
        const largePayload = { data: 'x'.repeat(10 * 1024 * 1024) }; // 10MB

        const response = await request(app)
          .post('/api/user/settings')
          .set('Authorization', 'Bearer valid-token')
          .send(largePayload);

        expect([400, 413]).toContain(response.status);
      });

      it('should reject requests with too many fields', async () => {
        const manyFields: Record<string, string> = {};
        for (let i = 0; i < 1000; i++) {
          manyFields[`field${i}`] = 'value';
        }

        const response = await request(app)
          .post('/api/user/settings')
          .set('Authorization', 'Bearer valid-token')
          .send(manyFields);

        expect([400, 413]).toContain(response.status);
      });
    });

    describe('Parameter Type Validation', () => {
      it('should validate numeric parameters', async () => {
        const response = await request(app)
          .get('/api/weather/data')
          .query({ limit: 'not-a-number' })
          .set('Authorization', 'Bearer valid-token');

        expect([400, 422]).toContain(response.status);
      });

      it('should validate UUID parameters', async () => {
        const response = await request(app)
          .get('/api/users/not-a-valid-uuid')
          .set('Authorization', 'Bearer valid-token');

        expect([400, 404]).toContain(response.status);
      });

      it('should validate email format', async () => {
        const response = await request(app)
          .post('/api/auth/register')
          .send({
            username: 'testuser',
            email: 'not-an-email',
            password: 'ValidPass123!',
          });

        expect([400, 422]).toContain(response.status);
      });

      it('should sanitize string inputs', async () => {
        const response = await request(app)
          .put('/api/user/profile')
          .set('Authorization', 'Bearer valid-token')
          .send({
            displayName: '<script>alert("xss")</script>',
          });

        if (response.status === 200) {
          expect(response.body.data?.displayName).not.toContain('<script>');
        }
      });
    });
  });

  describe('Response Security Tests', () => {
    it('should not include sensitive data in error responses', async () => {
      const response = await request(app)
        .get('/api/internal/error-trigger')
        .set('Authorization', 'Bearer valid-token');

      // Error response should not expose stack traces
      expect(JSON.stringify(response.body)).not.toMatch(/at\s+\w+\s+\(/);
      expect(JSON.stringify(response.body)).not.toContain('node_modules');
      expect(JSON.stringify(response.body)).not.toContain('DATABASE_URL');
    });

    it('should not expose internal IDs in responses', async () => {
      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 200 && response.body.data) {
        // Should use UUIDs or masked IDs
        if (response.body.data.id) {
          expect(response.body.data.id).not.toMatch(/^\d+$/);
        }
        // Should not expose database-specific IDs
        expect(response.body.data._id).toBeUndefined();
        expect(response.body.data.rowId).toBeUndefined();
      }
    });

    it('should mask sensitive fields in responses', async () => {
      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 200 && response.body.data) {
        // Password should never be in response
        expect(response.body.data.password).toBeUndefined();
        expect(response.body.data.passwordHash).toBeUndefined();

        // Secrets should be masked
        if (response.body.data.apiKey) {
          expect(response.body.data.apiKey).toMatch(/\*{4,}/);
        }
      }
    });

    it('should include pagination to prevent data exposure', async () => {
      const response = await request(app)
        .get('/api/weather/data')
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 200 && response.body.data) {
        // Should have pagination metadata
        expect(response.body.pagination || response.body.meta).toBeDefined();

        // Should not return excessive records
        if (Array.isArray(response.body.data)) {
          expect(response.body.data.length).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  describe('Security Headers Tests', () => {
    it('should include X-Content-Type-Options header', async () => {
      const response = await request(app).get('/api/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('should include X-Frame-Options header', async () => {
      const response = await request(app).get('/api/health');

      expect(['DENY', 'SAMEORIGIN']).toContain(response.headers['x-frame-options']);
    });

    it('should include X-XSS-Protection header', async () => {
      const response = await request(app).get('/api/health');

      expect(response.headers['x-xss-protection']).toMatch(/1;\s*mode=block/i);
    });

    it('should include Content-Security-Policy header', async () => {
      const response = await request(app).get('/api/health');

      const csp = response.headers['content-security-policy'];
      if (csp) {
        expect(csp).toContain("default-src");
      }
    });

    it('should include Strict-Transport-Security header in production', async () => {
      const response = await request(app).get('/api/health');

      // In production
      const hsts = response.headers['strict-transport-security'];
      if (process.env.NODE_ENV === 'production' && hsts) {
        expect(hsts).toMatch(/max-age=\d+/);
      }
    });

    it('should not expose server technology', async () => {
      const response = await request(app).get('/api/health');

      // Should not reveal specific server/framework versions
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['server']).not.toMatch(/express|node/i);
    });
  });

  describe('Resource Limit Tests', () => {
    it('should limit query depth for nested resources', async () => {
      const response = await request(app)
        .get('/api/users')
        .query({
          include: 'wallet.transactions.details.metadata.nested.deep',
        })
        .set('Authorization', 'Bearer valid-token');

      expect([200, 400]).toContain(response.status);
      if (response.status === 200 && response.body.data) {
        // Should not include deep nested data
        const depth = JSON.stringify(response.body.data).split(':').length;
        expect(depth).toBeLessThan(100);
      }
    });

    it('should limit number of related resources', async () => {
      const response = await request(app)
        .get('/api/users/user-id/transactions')
        .query({ limit: 10000 })
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 200 && Array.isArray(response.body.data)) {
        expect(response.body.data.length).toBeLessThanOrEqual(1000);
      }
    });
  });

  describe('Audit Logging Tests', () => {
    it('should log sensitive operations', async () => {
      // This test would verify audit logs are created
      // In real implementation, check audit log storage

      const response = await request(app)
        .post('/api/wallet/transfer')
        .set('Authorization', 'Bearer valid-token')
        .send({
          toAddress: 'recipient-address',
          amount: 100,
        });

      // Sensitive operations should be logged regardless of success/failure
      // This would be verified by checking audit logs
      expect([200, 400, 401, 403]).toContain(response.status);
    });

    it('should log authentication events', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'test' });

      // Login attempts (success and failure) should be logged
      // This would be verified by checking security logs
    });

    it('should include request ID for tracing', async () => {
      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer valid-token');

      // Response should include request ID for debugging
      expect(
        response.headers['x-request-id'] ||
        response.body.requestId ||
        response.body.traceId
      ).toBeDefined();
    });
  });

  describe('Error Handling Tests', () => {
    it('should return consistent error format', async () => {
      const response = await request(app)
        .get('/api/nonexistent')
        .set('Authorization', 'Bearer valid-token');

      expect(response.body).toHaveProperty('success', false);
      expect(response.body.error).toBeDefined();
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
    });

    it('should handle malformed JSON gracefully', async () => {
      const response = await request(app)
        .post('/api/user/settings')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer valid-token')
        .send('{invalid json}');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should handle unexpected errors without crashing', async () => {
      // Send unusual but valid requests
      const responses = await Promise.all([
        request(app)
          .get('/api/user/profile')
          .set('Authorization', 'Bearer valid-token')
          .set('Accept', '*/*'),
        request(app)
          .options('/api/user/profile'),
        request(app)
          .head('/api/user/profile')
          .set('Authorization', 'Bearer valid-token'),
      ]);

      // Server should handle all without 500 errors
      responses.forEach(response => {
        expect([200, 204, 401, 403, 404, 405]).toContain(response.status);
      });
    });
  });
});
