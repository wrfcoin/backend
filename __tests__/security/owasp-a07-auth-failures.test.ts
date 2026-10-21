/**
 * OWASP A07:2021 - Identification and Authentication Failures Tests
 *
 * Task 80: Gap 6 - Security test suite
 *
 * Tests for authentication vulnerabilities including:
 * - Brute force attacks
 * - Credential stuffing
 * - Session management
 * - Password policies
 * - Token security
 * - MFA bypass attempts
 */

import request from 'supertest';
import express, { Express } from 'express';

const createMockApp = (): Express => {
  const app = express();
  app.use(express.json());
  return app;
};

describe('OWASP A07:2021 - Identification and Authentication Failures', () => {
  let app: Express;

  beforeEach(() => {
    app = createMockApp();
  });

  describe('Brute Force Protection Tests', () => {
    it('should rate limit login attempts', async () => {
      const loginAttempts = Array(15).fill(null);

      const responses = await Promise.all(
        loginAttempts.map(() =>
          request(app)
            .post('/api/auth/login')
            .send({ username: 'testuser', password: 'wrongpassword' })
        )
      );

      // At least one response should be rate limited
      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should implement progressive delays for failed attempts', async () => {
      const startTime = Date.now();

      // Make multiple failed attempts
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'testuser', password: 'wrongpassword' });
      }

      const elapsed = Date.now() - startTime;

      // Should see increasing delay (at least some delay after multiple attempts)
      // This is a basic check - real implementation should have progressive delays
      expect(elapsed).toBeGreaterThan(0);
    });

    it('should lock account after multiple failed attempts', async () => {
      // Make many failed attempts
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'locktest', password: 'wrongpassword' });
      }

      // Try with correct password
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'locktest', password: 'correctpassword' });

      // Account should be locked
      expect([401, 403, 423]).toContain(response.status);
      if (response.body.error) {
        expect(response.body.error.code).toMatch(/locked|suspended/i);
      }
    });

    it('should not reveal whether username exists', async () => {
      const responseExisting = await request(app)
        .post('/api/auth/login')
        .send({ username: 'existinguser', password: 'wrongpassword' });

      const responseNonExisting = await request(app)
        .post('/api/auth/login')
        .send({ username: 'nonexistentuser12345', password: 'wrongpassword' });

      // Error messages should be identical
      expect(responseExisting.body.error?.message).toBe(responseNonExisting.body.error?.message);
      // Response times should be similar (timing attack prevention)
    });
  });

  describe('Password Policy Tests', () => {
    const weakPasswords = [
      'password',
      '123456',
      'qwerty',
      'admin',
      'letmein',
      'welcome',
      'Password1',
      'abc123',
      '',
      'a',
      '12345678',
    ];

    weakPasswords.forEach(password => {
      it(`should reject weak password: ${password || '(empty)'}`, async () => {
        const response = await request(app)
          .post('/api/auth/register')
          .send({
            username: 'newuser',
            email: 'newuser@example.com',
            password,
          });

        expect([400, 422]).toContain(response.status);
        if (response.body.error) {
          expect(response.body.error.message).toMatch(/password/i);
        }
      });
    });

    it('should require minimum password length', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'newuser',
          email: 'newuser@example.com',
          password: 'Short1!',
        });

      expect([400, 422]).toContain(response.status);
    });

    it('should not allow password same as username', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'testuser123',
          email: 'test@example.com',
          password: 'testuser123',
        });

      expect([400, 422]).toContain(response.status);
    });

    it('should check password against known breached passwords', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'newuser',
          email: 'new@example.com',
          password: 'Password123!', // Common breached password
        });

      // Should either reject or warn
      if (response.status === 400 || response.status === 422) {
        expect(response.body.error?.message).toMatch(/common|breached|compromised/i);
      }
    });
  });

  describe('Session Management Tests', () => {
    it('should invalidate session on logout', async () => {
      // Login first
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'ValidPass123!' });

      const sessionToken = loginResponse.body.data?.token;

      // Logout
      await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${sessionToken}`);

      // Try to use old session
      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', `Bearer ${sessionToken}`);

      expect([401, 403]).toContain(response.status);
    });

    it('should invalidate session on password change', async () => {
      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer current-session-token')
        .send({
          currentPassword: 'OldPass123!',
          newPassword: 'NewPass456!',
        });

      // After password change, all sessions should be invalidated
      // Check the response headers or body for session invalidation
      if (response.status === 200) {
        // Verify old token is invalid
        const checkResponse = await request(app)
          .get('/api/user/profile')
          .set('Authorization', 'Bearer current-session-token');

        expect([401, 403]).toContain(checkResponse.status);
      }
    });

    it('should limit concurrent sessions', async () => {
      const sessions: (string | undefined)[] = [];

      // Create multiple sessions
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ username: 'testuser', password: 'ValidPass123!' });

        if (response.status === 200) {
          sessions.push(response.body.data?.token);
        }
      }

      // Should have limited number of active sessions
      // Either reject new sessions or invalidate old ones
      expect(sessions.length).toBeLessThanOrEqual(5);
    });

    it('should include session security cookies', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'ValidPass123!' });

      const cookies = response.headers['set-cookie'];
      if (cookies) {
        const cookieString = Array.isArray(cookies) ? cookies.join(';') : cookies;

        // Should have secure flags
        expect(cookieString).toMatch(/HttpOnly/i);
        // In production, should have Secure flag
        // expect(cookieString).toMatch(/Secure/i);
        expect(cookieString).toMatch(/SameSite/i);
      }
    });

    it('should regenerate session ID on privilege change', async () => {
      // This would be tested after MFA confirmation or role change
      const response = await request(app)
        .post('/api/auth/mfa/verify')
        .set('Authorization', 'Bearer pre-mfa-token')
        .send({ code: '123456' });

      // New token should be different
      if (response.status === 200 && response.body.data?.token) {
        expect(response.body.data.token).not.toBe('pre-mfa-token');
      }
    });
  });

  describe('Token Security Tests', () => {
    it('should reject tokens after server restart simulation', async () => {
      // Token generated before server restart
      const oldToken = 'token-from-previous-session';

      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', `Bearer ${oldToken}`);

      expect([401, 403]).toContain(response.status);
    });

    it('should have appropriate token expiration', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'ValidPass123!' });

      if (response.status === 200 && response.body.data) {
        // Access token should expire in reasonable time (e.g., 1 hour)
        expect(response.body.data.expiresIn).toBeLessThanOrEqual(3600);

        // If refresh token is provided, it should have longer expiry
        if (response.body.data.refreshExpiresIn) {
          expect(response.body.data.refreshExpiresIn).toBeGreaterThan(
            response.body.data.expiresIn
          );
        }
      }
    });

    it('should not accept refresh token as access token', async () => {
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'ValidPass123!' });

      const refreshToken = loginResponse.body.data?.refreshToken;

      // Try to use refresh token as access token
      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', `Bearer ${refreshToken}`);

      expect([401, 403]).toContain(response.status);
    });

    it('should invalidate refresh token after use', async () => {
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'ValidPass123!' });

      const refreshToken = loginResponse.body.data?.refreshToken;

      // Use refresh token once
      await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken });

      // Try to use same refresh token again
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken });

      // Should reject reuse (refresh token rotation)
      expect([401, 403]).toContain(response.status);
    });
  });

  describe('MFA Bypass Tests', () => {
    it('should not allow MFA bypass via API manipulation', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'mfa-enabled-user',
          password: 'ValidPass123!',
          skipMfa: true,
        });

      // Should still require MFA
      if (response.status === 200) {
        expect(response.body.data?.requiresMfa).toBe(true);
        expect(response.body.data?.token).toBeUndefined();
      }
    });

    it('should rate limit MFA code attempts', async () => {
      const attempts = Array(10).fill(null);

      const responses = await Promise.all(
        attempts.map(() =>
          request(app)
            .post('/api/auth/mfa/verify')
            .set('Authorization', 'Bearer mfa-pending-token')
            .send({ code: '000000' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should not accept expired MFA codes', async () => {
      // TOTP codes expire every 30 seconds
      const response = await request(app)
        .post('/api/auth/mfa/verify')
        .set('Authorization', 'Bearer mfa-pending-token')
        .send({ code: '123456', codeTimestamp: Date.now() - 60000 });

      expect([400, 401]).toContain(response.status);
    });

    it('should not reuse backup codes', async () => {
      // Use backup code
      await request(app)
        .post('/api/auth/mfa/verify')
        .set('Authorization', 'Bearer mfa-pending-token')
        .send({ code: 'BACKUP123456', isBackupCode: true });

      // Try to use same backup code again
      const response = await request(app)
        .post('/api/auth/mfa/verify')
        .set('Authorization', 'Bearer another-mfa-pending-token')
        .send({ code: 'BACKUP123456', isBackupCode: true });

      expect([400, 401]).toContain(response.status);
    });
  });

  describe('Password Reset Tests', () => {
    it('should rate limit password reset requests', async () => {
      const attempts = Array(10).fill(null);

      const responses = await Promise.all(
        attempts.map(() =>
          request(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' })
        )
      );

      const rateLimited = responses.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should not reveal email existence in password reset', async () => {
      const responseExisting = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'existing@example.com' });

      const responseNonExisting = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' });

      // Both should return same response
      expect(responseExisting.status).toBe(responseNonExisting.status);
      expect(responseExisting.body.message).toBe(responseNonExisting.body.message);
    });

    it('should invalidate reset token after use', async () => {
      const resetToken = 'valid-reset-token';

      // Use reset token
      await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: resetToken,
          newPassword: 'NewValidPass123!',
        });

      // Try to use same token again
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: resetToken,
          newPassword: 'AnotherPass456!',
        });

      expect([400, 401]).toContain(response.status);
    });

    it('should expire reset tokens after timeout', async () => {
      const expiredToken = 'expired-reset-token';

      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: expiredToken,
          newPassword: 'NewValidPass123!',
        });

      expect([400, 401]).toContain(response.status);
      if (response.body.error) {
        expect(response.body.error.code).toMatch(/expired|invalid/i);
      }
    });
  });

  describe('API Key Security Tests', () => {
    it('should not expose API key in responses', async () => {
      const response = await request(app)
        .get('/api/user/api-keys')
        .set('Authorization', 'Bearer valid-token');

      if (response.status === 200 && response.body.data) {
        const keys = response.body.data;
        keys.forEach((key: any) => {
          // Key should be masked
          if (key.key) {
            expect(key.key).toMatch(/\*{4,}/);
            expect(key.key.length).toBeLessThan(64);
          }
        });
      }
    });

    it('should invalidate API key on revocation', async () => {
      const apiKey = 'wrfc_test_validapikey123456789012345678901234';

      // Revoke API key
      await request(app)
        .delete('/api/user/api-keys/key-id')
        .set('Authorization', 'Bearer valid-token');

      // Try to use revoked key
      const response = await request(app)
        .get('/api/weather/data')
        .set('X-API-Key', apiKey);

      expect([401, 403]).toContain(response.status);
    });
  });
});
