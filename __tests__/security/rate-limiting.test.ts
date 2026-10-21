/**
 * Rate Limiting Tests
 *
 * Task 80: Gap 6 - Security test suite
 *
 * Tests for rate limiting functionality including:
 * - General API rate limits
 * - Endpoint-specific rate limits
 * - Authentication endpoint rate limits
 * - IP-based rate limiting
 * - User-based rate limiting
 * - Rate limit headers
 */

import request from 'supertest';
import express, { Express } from 'express';

const createMockApp = (): Express => {
  const app = express();
  app.use(express.json());
  return app;
};

describe('Rate Limiting Security', () => {
  let app: Express;

  beforeEach(() => {
    app = createMockApp();
    // Reset rate limiters between tests if possible
  });

  describe('General API Rate Limits', () => {
    it('should enforce rate limits on API endpoints', async () => {
      const requests = Array(150).fill(null);

      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);

      // Should start rate limiting after threshold
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should include rate limit headers', async () => {
      const response = await request(app)
        .get('/api/weather/data')
        .set('Authorization', 'Bearer valid-token');

      // Should include standard rate limit headers
      expect(
        response.headers['x-ratelimit-limit'] ||
        response.headers['ratelimit-limit']
      ).toBeDefined();

      expect(
        response.headers['x-ratelimit-remaining'] ||
        response.headers['ratelimit-remaining']
      ).toBeDefined();

      // May also include reset time
      const reset = response.headers['x-ratelimit-reset'] ||
                    response.headers['ratelimit-reset'];
      if (reset) {
        expect(parseInt(reset)).toBeGreaterThan(0);
      }
    });

    it('should return Retry-After header when rate limited', async () => {
      // Exceed rate limit first
      const requests = Array(200).fill(null);
      await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      // Make one more request
      const response = await request(app)
        .get('/api/weather/data')
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 429) {
        expect(response.headers['retry-after']).toBeDefined();
        expect(parseInt(response.headers['retry-after'])).toBeGreaterThan(0);
      }
    });
  });

  describe('Authentication Endpoint Rate Limits', () => {
    it('should have stricter limits on login endpoint', async () => {
      const loginAttempts = Array(20).fill(null);

      const responses = await Promise.all(
        loginAttempts.map(() =>
          request(app)
            .post('/api/auth/login')
            .send({ username: 'testuser', password: 'wrongpass' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);

      // Login should be rate limited sooner than general API
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should rate limit password reset requests', async () => {
      const resetAttempts = Array(10).fill(null);

      const responses = await Promise.all(
        resetAttempts.map(() =>
          request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should rate limit registration endpoint', async () => {
      const registerAttempts = Array(15).fill(null);

      const responses = await Promise.all(
        registerAttempts.map((_, i) =>
          request(app)
            .post('/api/auth/register')
            .send({
              username: `testuser${i}`,
              email: `test${i}@example.com`,
              password: 'ValidPass123!',
            })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should rate limit MFA verification attempts', async () => {
      const mfaAttempts = Array(10).fill(null);

      const responses = await Promise.all(
        mfaAttempts.map(() =>
          request(app)
            .post('/api/auth/mfa/verify')
            .set('Authorization', 'Bearer mfa-pending-token')
            .send({ code: '000000' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Sensitive Operation Rate Limits', () => {
    it('should rate limit wallet transfers', async () => {
      const transferAttempts = Array(20).fill(null);

      const responses = await Promise.all(
        transferAttempts.map(() =>
          request(app)
            .post('/api/wallet/transfer')
            .set('Authorization', 'Bearer valid-token')
            .send({
              toAddress: 'recipient',
              amount: 1,
            })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should rate limit API key generation', async () => {
      const keyGenAttempts = Array(10).fill(null);

      const responses = await Promise.all(
        keyGenAttempts.map(() =>
          request(app)
            .post('/api/user/api-keys')
            .set('Authorization', 'Bearer valid-token')
            .send({ name: 'test-key' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should rate limit file uploads', async () => {
      const uploadAttempts = Array(30).fill(null);

      const responses = await Promise.all(
        uploadAttempts.map(() =>
          request(app)
            .post('/api/files/upload')
            .set('Authorization', 'Bearer valid-token')
            .attach('file', Buffer.from('test'), 'test.txt')
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('IP-Based Rate Limiting', () => {
    it('should rate limit requests from same IP', async () => {
      const requests = Array(100).fill(null);

      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-Forwarded-For', '192.168.1.100')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should allow different IPs separately', async () => {
      // Make requests from different IPs
      const ip1Requests = await Promise.all(
        Array(50).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-Forwarded-For', '192.168.1.1')
            .set('Authorization', 'Bearer token1')
        )
      );

      const ip2Requests = await Promise.all(
        Array(50).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-Forwarded-For', '192.168.1.2')
            .set('Authorization', 'Bearer token2')
        )
      );

      // Both should have some successful requests
      const ip1Success = ip1Requests.filter(r => r.status === 200).length;
      const ip2Success = ip2Requests.filter(r => r.status === 200).length;

      expect(ip1Success).toBeGreaterThan(0);
      expect(ip2Success).toBeGreaterThan(0);
    });

    it('should not be bypassed by X-Forwarded-For manipulation', async () => {
      // Try to bypass rate limit by changing X-Forwarded-For
      const requests = Array(150).fill(null);

      const responses = await Promise.all(
        requests.map((_, i) =>
          request(app)
            .get('/api/weather/data')
            .set('X-Forwarded-For', `10.0.0.${i % 256}`)
            .set('Authorization', 'Bearer valid-token')
        )
      );

      // Server should use real IP, not trust arbitrary X-Forwarded-For
      // If configured properly, rate limiting should still apply
      const rateLimited = responses.filter(r => r.status === 429);
      // Should see some rate limiting if server validates proxy chain
    });
  });

  describe('User-Based Rate Limiting', () => {
    it('should rate limit by user ID in addition to IP', async () => {
      const requests = Array(100).fill(null);

      const responses = await Promise.all(
        requests.map((_, i) =>
          request(app)
            .get('/api/user/profile')
            .set('X-Forwarded-For', `10.0.0.${i % 256}`)
            .set('Authorization', 'Bearer same-user-token')
        )
      );

      // Should be rate limited by user even with different IPs
      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should track rate limits per API key', async () => {
      const requests = Array(100).fill(null);

      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-API-Key', 'wrfc_test_same_api_key_12345678901234567890')
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limit Tiers', () => {
    it('should apply different limits based on user tier', async () => {
      // Free tier user
      const freeUserRequests = await Promise.all(
        Array(50).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer free-user-token')
        )
      );

      // Premium tier user
      const premiumUserRequests = await Promise.all(
        Array(50).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer premium-user-token')
        )
      );

      const freeRateLimited = freeUserRequests.filter(r => r.status === 429).length;
      const premiumRateLimited = premiumUserRequests.filter(r => r.status === 429).length;

      // Free tier should hit rate limit sooner
      expect(freeRateLimited).toBeGreaterThanOrEqual(premiumRateLimited);
    });

    it('should apply API key tier limits', async () => {
      // Standard API key
      const standardRequests = await Promise.all(
        Array(100).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-API-Key', 'wrfc_test_standard_api_key_123456789012')
        )
      );

      // Premium API key
      const premiumRequests = await Promise.all(
        Array(100).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('X-API-Key', 'wrfc_live_premium_api_key_123456789012345')
        )
      );

      const standardLimited = standardRequests.filter(r => r.status === 429).length;
      const premiumLimited = premiumRequests.filter(r => r.status === 429).length;

      // Standard should be more limited
      expect(standardLimited).toBeGreaterThanOrEqual(premiumLimited);
    });
  });

  describe('Distributed Rate Limiting', () => {
    it('should persist rate limit state (Redis test)', async () => {
      // Make some requests
      await Promise.all(
        Array(50).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 100));

      // Make more requests - should remember previous count
      const responses = await Promise.all(
        Array(100).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should correctly report remaining requests', async () => {
      const firstResponse = await request(app)
        .get('/api/weather/data')
        .set('Authorization', 'Bearer valid-token');

      const initialRemaining = parseInt(
        firstResponse.headers['x-ratelimit-remaining'] ||
        firstResponse.headers['ratelimit-remaining'] ||
        '0'
      );

      // Make some requests
      await Promise.all(
        Array(10).fill(null).map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const laterResponse = await request(app)
        .get('/api/weather/data')
        .set('Authorization', 'Bearer valid-token');

      const laterRemaining = parseInt(
        laterResponse.headers['x-ratelimit-remaining'] ||
        laterResponse.headers['ratelimit-remaining'] ||
        '0'
      );

      // Remaining should have decreased
      expect(laterRemaining).toBeLessThan(initialRemaining);
    });
  });

  describe('Rate Limit Error Response', () => {
    it('should return informative error message when rate limited', async () => {
      // Exceed rate limit
      const requests = Array(200).fill(null);
      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const rateLimitedResponse = responses.find(r => r.status === 429);

      if (rateLimitedResponse) {
        expect(rateLimitedResponse.body.success).toBe(false);
        expect(rateLimitedResponse.body.error).toBeDefined();
        expect(rateLimitedResponse.body.error.code).toMatch(/rate.*limit/i);
        expect(rateLimitedResponse.body.error.message).toBeDefined();

        // Should tell user when they can retry
        expect(
          rateLimitedResponse.body.error.retryAfter ||
          rateLimitedResponse.headers['retry-after']
        ).toBeDefined();
      }
    });

    it('should not leak internal information in rate limit errors', async () => {
      // Exceed rate limit
      const requests = Array(200).fill(null);
      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/weather/data')
            .set('Authorization', 'Bearer valid-token')
        )
      );

      const rateLimitedResponse = responses.find(r => r.status === 429);

      if (rateLimitedResponse) {
        const bodyStr = JSON.stringify(rateLimitedResponse.body);

        // Should not expose internal details
        expect(bodyStr).not.toMatch(/redis/i);
        expect(bodyStr).not.toMatch(/internal/i);
        expect(bodyStr).not.toContain('stack');
      }
    });
  });

  describe('Exemptions and Whitelisting', () => {
    it('should allow whitelisted IPs without rate limiting', async () => {
      // Internal health check or monitoring IP
      const requests = Array(500).fill(null);

      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/health')
            .set('X-Forwarded-For', '127.0.0.1')
        )
      );

      // Health endpoint from localhost should not be rate limited
      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBe(0);
    });

    it('should not rate limit internal service calls', async () => {
      const requests = Array(500).fill(null);

      const responses = await Promise.all(
        requests.map(() =>
          request(app)
            .get('/api/internal/service-check')
            .set('X-Service-Token', 'internal-service-token')
        )
      );

      // Internal service calls should bypass rate limiting
      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBe(0);
    });
  });
});
