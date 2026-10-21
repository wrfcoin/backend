/**
 * Security Integration Tests
 * Tests for Task 67: Security validation and vulnerability testing
 *
 * Focus Areas:
 * - Authentication and authorization
 * - Input validation and sanitization
 * - HSM integration security
 * - Error masking and information disclosure
 * - Rate limiting and DoS protection
 * - Cryptographic operations
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

describe('Security Integration Tests', () => {
  let app;
  let db;

  const TEST_SECRETS = {
    JWT_SECRET: 'test_jwt_secret_key_for_integration_tests',
    HSM_TEST_KEY: 'test_hsm_key_for_integration_tests',
  };

  const TEST_USERS = {
    admin: {
      address: '0x1234567890123456789012345678901234567890',
      role: 'admin',
      verified: true,
    },
    regular: {
      address: '0x0987654321098765432109876543210987654321',
      role: 'user',
      verified: true,
    },
    unverified: {
      address: '0x1111111111111111111111111111111111111111',
      role: 'user',
      verified: false,
    },
  };

  beforeAll(async () => {
    console.log('Setting up security integration tests...');

    // Initialize database connection
    db = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ||
        'postgresql://localhost:5432/wrfcoin_test',
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await db.query('SELECT 1');
    console.log('Security test environment ready');
  });

  afterAll(async () => {
    if (db) {
      await db.end();
    }
    console.log('Security test cleanup completed');
  });

  describe('Authentication and Authorization', () => {
    const generateTestToken = (user, expiresIn = '1h') => {
      return jwt.sign(
        {
          address: user.address,
          role: user.role,
          verified: user.verified,
          iat: Math.floor(Date.now() / 1000),
        },
        TEST_SECRETS.JWT_SECRET,
        { expiresIn, issuer: 'wrfcoin-platform', audience: 'wrfcoin-api' }
      );
    };

    test('should reject requests without authentication for protected endpoints', async () => {
      const protectedQueries = [
        '{ userWallet { balance privateKey } }',
        '{ userProfile { address email } }',
        'mutation { updateProfile(name: "test") { success } }',
      ];

      for (const query of protectedQueries) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Content-Type', 'application/json');

        expect(response.status).toBe(401);
        expect(response.body.errors).toBeDefined();
        expect(response.body.errors[0].message).toMatch(
          /authentication|unauthorized/i
        );
      }
    });

    test('should validate JWT tokens correctly', async () => {
      const validToken = generateTestToken(TEST_USERS.regular);
      const invalidTokens = [
        'invalid.jwt.token',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature',
        '', // Empty token
        'Bearer ', // Empty bearer
        generateTestToken(TEST_USERS.regular, '-1h'), // Expired token
      ];

      // Test valid token
      const validResponse = await request(app)
        .post('/graphql')
        .send({ query: '{ userProfile { address } }' })
        .set('Authorization', `Bearer ${validToken}`)
        .set('Content-Type', 'application/json');

      expect(validResponse.status).toBe(200);

      // Test invalid tokens
      for (const invalidToken of invalidTokens) {
        const response = await request(app)
          .post('/graphql')
          .send({ query: '{ userProfile { address } }' })
          .set('Authorization', `Bearer ${invalidToken}`)
          .set('Content-Type', 'application/json');

        expect(response.status).toBe(401);
      }
    });

    test('should enforce role-based authorization', async () => {
      const adminToken = generateTestToken(TEST_USERS.admin);
      const userToken = generateTestToken(TEST_USERS.regular);

      const adminOnlyQueries = [
        'mutation { adminDeleteUser(address: "0x123") { success } }',
        'mutation { adminSetMaintenance(enabled: true) { success } }',
        '{ adminStats { totalUsers systemHealth } }',
      ];

      for (const query of adminOnlyQueries) {
        // Test with admin token - should succeed
        const adminResponse = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${adminToken}`)
          .set('Content-Type', 'application/json');

        expect(adminResponse.status).not.toBe(403);

        // Test with regular user token - should fail
        const userResponse = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${userToken}`)
          .set('Content-Type', 'application/json');

        expect(userResponse.status).toBe(403);
        expect(userResponse.body.errors[0].message).toMatch(
          /forbidden|insufficient|admin/i
        );
      }
    });

    test('should enforce wallet verification requirements', async () => {
      const verifiedToken = generateTestToken(TEST_USERS.regular);
      const unverifiedToken = generateTestToken(TEST_USERS.unverified);

      const verifiedOnlyQueries = [
        'mutation { createProposal(title: "Test", description: "Test") { id } }',
        'mutation { submitVote(proposalId: "1", support: true) { success } }',
        '{ userDelegations { delegated delegatedTo } }',
      ];

      for (const query of verifiedOnlyQueries) {
        // Test with verified user - should succeed
        const verifiedResponse = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${verifiedToken}`)
          .set('Content-Type', 'application/json');

        expect(verifiedResponse.status).not.toBe(403);

        // Test with unverified user - should fail
        const unverifiedResponse = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${unverifiedToken}`)
          .set('Content-Type', 'application/json');

        expect(unverifiedResponse.status).toBe(403);
        expect(unverifiedResponse.body.errors[0].message).toMatch(
          /verification|verified/i
        );
      }
    });

    test('should prevent privilege escalation attempts', async () => {
      const userToken = generateTestToken(TEST_USERS.regular);

      const escalationAttempts = [
        'mutation { updateUserRole(userId: "self", role: "admin") { success } }',
        'mutation { grantAdminAccess(userId: "self") { success } }',
        'mutation { bypassVerification(address: "self") { success } }',
      ];

      for (const query of escalationAttempts) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${userToken}`)
          .set('Content-Type', 'application/json');

        expect(response.status).toBeGreaterThanOrEqual(403);
      }
    });
  });

  describe('Input Validation and Sanitization', () => {
    test('should prevent SQL injection attacks', async () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE users; --",
        "' OR '1'='1",
        "'; UPDATE users SET role='admin' WHERE id=1; --",
        "' UNION SELECT * FROM sensitive_data --",
        '1; DELETE FROM transactions WHERE id > 0; --',
      ];

      const testQuery = payload => `
        query {
          searchUsers(name: "${payload}") {
            id
            name
          }
        }
      `;

      for (const payload of sqlInjectionPayloads) {
        const response = await request(app)
          .post('/graphql')
          .send({ query: testQuery(payload) })
          .set('Content-Type', 'application/json');

        // Should not crash the server
        expect(response.status).not.toBe(500);

        // Verify critical tables still exist
        const tableCheck = await db.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_name IN ('users', 'transactions', 'wallets')
        `);
        expect(tableCheck.rows.length).toBeGreaterThan(0);
      }
    });

    test('should prevent GraphQL injection and introspection attacks', async () => {
      const introspectionQueries = [
        '{ __schema { types { name } } }',
        '{ __type(name: "User") { fields { name type { name } } } }',
        'query IntrospectionQuery { __schema { queryType { name } } }',
      ];

      for (const query of introspectionQueries) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Content-Type', 'application/json');

        // Introspection should be disabled in production
        expect(response.body.errors).toBeDefined();
        expect(response.body.errors[0].message).toMatch(
          /introspection|disabled/i
        );
      }
    });

    test('should sanitize XSS attempts in responses', async () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        '<img src="x" onerror="alert(\'XSS\')">',
        'javascript:alert("XSS")',
        '<svg/onload=alert("XSS")>',
        '"><script>alert("XSS")</script>',
      ];

      for (const payload of xssPayloads) {
        const response = await request(app)
          .post('/graphql')
          .send({
            query: `
              mutation {
                createNote(content: "${payload}") {
                  id
                  content
                }
              }
            `,
          })
          .set('Content-Type', 'application/json');

        if (response.body.data?.createNote?.content) {
          const content = response.body.data.createNote.content;

          // Should not contain executable script tags
          expect(content).not.toMatch(/<script[^>]*>/i);
          expect(content).not.toMatch(/javascript:/i);
          expect(content).not.toMatch(/onerror=/i);
          expect(content).not.toMatch(/onload=/i);

          // Should be properly encoded
          expect(content).toMatch(/&lt;|&gt;|&quot;|&#x27;|&#x2F;/);
        }
      }
    });

    test('should validate and sanitize file upload attempts', async () => {
      const maliciousFiles = [
        { name: 'script.js', content: 'alert("XSS")' },
        { name: '../../../etc/passwd', content: 'sensitive data' },
        { name: 'file.exe', content: 'executable content' },
        { name: 'large_file.txt', content: 'x'.repeat(10 * 1024 * 1024) }, // 10MB
      ];

      for (const file of maliciousFiles) {
        const response = await request(app)
          .post('/upload')
          .attach('file', Buffer.from(file.content), file.name)
          .set(
            'Authorization',
            `Bearer ${generateTestToken(TEST_USERS.regular)}`
          );

        // Should reject malicious files
        if (
          file.name.includes('..') ||
          file.name.endsWith('.exe') ||
          file.content.length > 5 * 1024 * 1024
        ) {
          expect(response.status).toBe(400);
        }
      }
    });

    test('should enforce input length and complexity limits', async () => {
      const oversizedInputs = {
        veryLongString: 'a'.repeat(10000),
        deeplyNestedQuery: generateDeepQuery(20),
        manyVariables: generateManyVariables(1000),
      };

      // Test string length limits
      const longStringResponse = await request(app)
        .post('/graphql')
        .send({
          query: `
            mutation {
              createNote(content: "${oversizedInputs.veryLongString}") {
                id
              }
            }
          `,
        })
        .set('Content-Type', 'application/json');

      expect(longStringResponse.status).toBe(400);
      expect(longStringResponse.body.errors[0].message).toMatch(
        /length|size|limit/i
      );

      // Test query depth limits
      const deepQueryResponse = await request(app)
        .post('/graphql')
        .send({ query: oversizedInputs.deeplyNestedQuery })
        .set('Content-Type', 'application/json');

      expect(deepQueryResponse.status).toBe(400);
      expect(deepQueryResponse.body.errors[0].message).toMatch(
        /depth|complexity/i
      );
    });

    function generateDeepQuery(depth) {
      let query = 'query { wrfToken { ';
      for (let i = 0; i < depth; i++) {
        query += 'weatherStations { ';
      }
      query += 'stationId';
      for (let i = 0; i < depth; i++) {
        query += ' }';
      }
      query += ' } }';
      return query;
    }

    function generateManyVariables(count) {
      const variables = {};
      for (let i = 0; i < count; i++) {
        variables[`var${i}`] = `value${i}`;
      }
      return variables;
    }
  });

  describe('HSM Integration Security', () => {
    test('should validate HSM cryptographic operations', async () => {
      const testData = 'test_data_for_signing';

      // Test HSM availability
      const hsmAvailable = await request(app)
        .get('/hsm/health')
        .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`);

      if (hsmAvailable.status === 200) {
        // Test signing operation
        const signResponse = await request(app)
          .post('/hsm/sign')
          .send({ data: testData })
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        expect(signResponse.status).toBe(200);
        expect(signResponse.body.signature).toBeDefined();
        expect(signResponse.body.signature.length).toBeGreaterThan(0);

        // Test signature verification
        const verifyResponse = await request(app)
          .post('/hsm/verify')
          .send({
            data: testData,
            signature: signResponse.body.signature,
          })
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        expect(verifyResponse.status).toBe(200);
        expect(verifyResponse.body.valid).toBe(true);

        // Test verification with tampered data
        const tamperVerifyResponse = await request(app)
          .post('/hsm/verify')
          .send({
            data: testData + '_tampered',
            signature: signResponse.body.signature,
          })
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        expect(tamperVerifyResponse.body.valid).toBe(false);
      } else {
        console.log(
          'HSM not available in test environment - using software fallback'
        );

        // Test software fallback
        const fallbackResponse = await request(app)
          .post('/crypto/sign')
          .send({ data: testData })
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        expect(fallbackResponse.status).toBe(200);
        expect(fallbackResponse.body.method).toBe('software');
      }
    });

    test('should protect against HSM key extraction attempts', async () => {
      const maliciousRequests = [
        { endpoint: '/hsm/export-key', data: { keyId: 'master' } },
        { endpoint: '/hsm/backup', data: { destination: '/tmp/backup' } },
        { endpoint: '/hsm/debug', data: { command: 'dump_keys' } },
        { endpoint: '/hsm/config', data: { action: 'reveal_secrets' } },
      ];

      for (const maliciousRequest of maliciousRequests) {
        const response = await request(app)
          .post(maliciousRequest.endpoint)
          .send(maliciousRequest.data)
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        // Should reject key extraction attempts
        expect(response.status).toBeGreaterThanOrEqual(403);
      }
    });

    test('should validate cryptographic key rotation', async () => {
      // Test key rotation initiation (admin only)
      const rotationResponse = await request(app)
        .post('/hsm/rotate-keys')
        .send({ keyType: 'test', reason: 'security_test' })
        .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
        .set('Content-Type', 'application/json');

      if (rotationResponse.status === 200) {
        expect(rotationResponse.body.rotationId).toBeDefined();
        expect(rotationResponse.body.status).toBe('initiated');
      }

      // Regular users should not be able to rotate keys
      const unauthorizedRotation = await request(app)
        .post('/hsm/rotate-keys')
        .send({ keyType: 'test' })
        .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.regular)}`)
        .set('Content-Type', 'application/json');

      expect(unauthorizedRotation.status).toBe(403);
    });
  });

  describe('Error Masking and Information Disclosure', () => {
    test('should mask sensitive information in error responses', async () => {
      const sensitiveQueries = [
        '{ debugInfo { databaseUrl } }',
        '{ internalConfig { secrets } }',
        '{ systemInfo { environmentVariables } }',
        '{ adminPanelUrl }',
        '{ databaseCredentials }',
      ];

      for (const query of sensitiveQueries) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Content-Type', 'application/json');

        const responseString = JSON.stringify(response.body);

        // Should not expose sensitive information
        expect(responseString).not.toMatch(/password/i);
        expect(responseString).not.toMatch(/secret/i);
        expect(responseString).not.toMatch(/key/i);
        expect(responseString).not.toMatch(/token/i);
        expect(responseString).not.toMatch(/postgresql:\/\//i);
        expect(responseString).not.toMatch(/redis:\/\//i);
        expect(responseString).not.toMatch(/localhost:\d+/);
      }
    });

    test('should limit error stack trace exposure', async () => {
      const errorInducingQueries = [
        '{ causeInternalError }',
        '{ accessNonExistentField }',
        '{ triggerDatabaseError }',
        '{ divideByZero }',
      ];

      for (const query of errorInducingQueries) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Content-Type', 'application/json');

        if (response.body.errors) {
          response.body.errors.forEach(error => {
            // Should not expose file paths
            expect(error.message).not.toMatch(
              /\/home\/|\/var\/|\/usr\/|\/opt\//
            );
            expect(error.message).not.toMatch(/node_modules/);
            expect(error.message).not.toMatch(/\.js:\d+/);

            // Should not expose stack traces
            expect(error.extensions?.stack).toBeUndefined();

            // Should not expose internal error details
            expect(error.message).not.toMatch(/Error: /);
          });
        }
      }
    });

    test('should prevent timing attacks on authentication', async () => {
      const validToken = generateTestToken(TEST_USERS.regular);
      const invalidToken = 'invalid.jwt.token';

      const timings = {
        valid: [],
        invalid: [],
      };

      // Measure timing for valid tokens
      for (let i = 0; i < 10; i++) {
        const start = process.hrtime.bigint();
        await request(app)
          .post('/graphql')
          .send({ query: '{ userProfile { address } }' })
          .set('Authorization', `Bearer ${validToken}`)
          .set('Content-Type', 'application/json');
        const end = process.hrtime.bigint();
        timings.valid.push(Number(end - start) / 1000000); // Convert to milliseconds
      }

      // Measure timing for invalid tokens
      for (let i = 0; i < 10; i++) {
        const start = process.hrtime.bigint();
        await request(app)
          .post('/graphql')
          .send({ query: '{ userProfile { address } }' })
          .set('Authorization', `Bearer ${invalidToken}`)
          .set('Content-Type', 'application/json');
        const end = process.hrtime.bigint();
        timings.invalid.push(Number(end - start) / 1000000);
      }

      const avgValidTime =
        timings.valid.reduce((a, b) => a + b, 0) / timings.valid.length;
      const avgInvalidTime =
        timings.invalid.reduce((a, b) => a + b, 0) / timings.invalid.length;
      const timingDifference = Math.abs(avgValidTime - avgInvalidTime);

      console.log(`Authentication Timing Analysis:
        Average valid token time: ${avgValidTime.toFixed(2)}ms
        Average invalid token time: ${avgInvalidTime.toFixed(2)}ms
        Timing difference: ${timingDifference.toFixed(2)}ms
      `);

      // Timing difference should be minimal to prevent timing attacks
      expect(timingDifference).toBeLessThan(10); // Less than 10ms difference
    });
  });

  describe('Rate Limiting and DoS Protection', () => {
    test('should enforce rate limits per IP address', async () => {
      const rateLimitTest = async clientIp => {
        const rapidRequests = Array(150)
          .fill(null)
          .map(() =>
            request(app)
              .post('/graphql')
              .send({ query: '{ wrfToken { symbol } }' })
              .set('X-Forwarded-For', clientIp)
              .set('Content-Type', 'application/json')
          );

        const results = await Promise.allSettled(rapidRequests);

        const successful = results.filter(
          r => r.status === 'fulfilled' && r.value.status === 200
        ).length;

        const rateLimited = results.filter(
          r => r.status === 'fulfilled' && r.value.status === 429
        ).length;

        return { successful, rateLimited, total: results.length };
      };

      const ip1Results = await rateLimitTest('192.168.1.100');
      const ip2Results = await rateLimitTest('192.168.1.101');

      // Should rate limit excessive requests
      expect(ip1Results.rateLimited).toBeGreaterThan(0);
      expect(ip2Results.rateLimited).toBeGreaterThan(0);

      // Different IPs should be rate limited independently
      expect(ip1Results.successful + ip2Results.successful).toBeGreaterThan(
        ip1Results.successful
      );
    });

    test('should protect against query complexity attacks', async () => {
      const complexityLevels = [
        {
          name: 'normal',
          query: '{ wrfToken { symbol } }',
          shouldPass: true,
        },
        {
          name: 'moderate',
          query: `{
            wrfToken {
              weatherStations(first: 10) {
                stationId
                proposals(first: 5) {
                  title
                }
              }
            }
          }`,
          shouldPass: true,
        },
        {
          name: 'high',
          query: `{
            wrfToken {
              weatherStations(first: 50) {
                stationId
                proposals(first: 20) {
                  title
                  votes(first: 100) {
                    support
                  }
                }
              }
            }
          }`,
          shouldPass: false,
        },
      ];

      for (const test of complexityLevels) {
        const response = await request(app)
          .post('/graphql')
          .send({ query: test.query })
          .set('Content-Type', 'application/json');

        if (test.shouldPass) {
          expect(response.status).not.toBe(400);
        } else {
          expect(response.status).toBe(400);
          expect(response.body.errors[0].message).toMatch(
            /complexity|depth|limit/i
          );
        }
      }
    });

    test('should handle connection flooding gracefully', async () => {
      const floodSize = 200;
      const connectionStart = Date.now();

      const floodRequests = Array(floodSize)
        .fill(null)
        .map(async () => {
          try {
            const response = await request(app)
              .post('/graphql')
              .send({ query: '{ wrfToken { symbol } }' })
              .set('Content-Type', 'application/json')
              .timeout(10000);

            return {
              status: response.status,
              success: response.status < 400,
            };
          } catch (error) {
            return {
              status: 'error',
              success: false,
              error: error.message,
            };
          }
        });

      const results = await Promise.allSettled(floodRequests);
      const connectionTime = Date.now() - connectionStart;

      const successful = results.filter(
        r => r.status === 'fulfilled' && r.value.success
      ).length;

      const failed = results.length - successful;

      console.log(`Connection Flood Test:
        Total requests: ${floodSize}
        Successful: ${successful}
        Failed: ${failed}
        Total time: ${connectionTime}ms
        Success rate: ${((successful / floodSize) * 100).toFixed(2)}%
      `);

      // Server should remain responsive
      expect(connectionTime).toBeLessThan(30000); // Should complete within 30 seconds
      expect(successful / floodSize).toBeGreaterThan(0.5); // At least 50% success rate
    });

    test('should protect against slowloris attacks', async () => {
      // Simulate slow requests that don't complete quickly
      const slowRequests = Array(20)
        .fill(null)
        .map(async () => {
          return new Promise(resolve => {
            const req = request(app)
              .post('/graphql')
              .send({ query: '{ wrfToken { symbol } }' })
              .set('Content-Type', 'application/json');

            // Add artificial delay to simulate slowloris
            setTimeout(() => {
              req.end((err, res) => {
                resolve({
                  status: res ? res.status : 'timeout',
                  error: err ? err.message : null,
                });
              });
            }, 5000);
          });
        });

      const start = Date.now();
      const results = await Promise.all(slowRequests);
      const duration = Date.now() - start;

      // Server should timeout slow requests appropriately
      expect(duration).toBeLessThan(15000); // Should not wait indefinitely

      const timeouts = results.filter(
        r => r.status === 'timeout' || r.error
      ).length;
      expect(timeouts).toBeGreaterThan(0); // Should timeout some slow requests
    });
  });

  describe('Cryptographic Security', () => {
    test('should use secure random number generation', async () => {
      const response = await request(app)
        .post('/crypto/generate-nonce')
        .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.regular)}`)
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.nonce).toBeDefined();

      const nonce = response.body.nonce;
      expect(nonce.length).toBeGreaterThan(16); // Should be sufficiently long

      // Test multiple nonces for uniqueness
      const nonces = new Set();
      for (let i = 0; i < 10; i++) {
        const nonceResponse = await request(app)
          .post('/crypto/generate-nonce')
          .set(
            'Authorization',
            `Bearer ${generateTestToken(TEST_USERS.regular)}`
          )
          .set('Content-Type', 'application/json');

        nonces.add(nonceResponse.body.nonce);
      }

      expect(nonces.size).toBe(10); // All nonces should be unique
    });

    test('should validate cryptographic hash functions', async () => {
      const testData = 'test_data_for_hashing';

      const response = await request(app)
        .post('/crypto/hash')
        .send({
          data: testData,
          algorithm: 'sha256',
        })
        .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.regular)}`)
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.hash).toBeDefined();

      // Verify hash consistency
      const expectedHash = crypto
        .createHash('sha256')
        .update(testData)
        .digest('hex');
      expect(response.body.hash).toBe(expectedHash);

      // Test with different algorithms
      const algorithms = ['sha256', 'sha512'];
      for (const algorithm of algorithms) {
        const algResponse = await request(app)
          .post('/crypto/hash')
          .send({ data: testData, algorithm })
          .set(
            'Authorization',
            `Bearer ${generateTestToken(TEST_USERS.regular)}`
          )
          .set('Content-Type', 'application/json');

        expect(algResponse.status).toBe(200);
        expect(algResponse.body.hash).toBeDefined();
        expect(algResponse.body.algorithm).toBe(algorithm);
      }
    });

    test('should protect against cryptographic downgrade attacks', async () => {
      const weakAlgorithms = ['md5', 'sha1', 'des', 'rc4'];

      for (const algorithm of weakAlgorithms) {
        const response = await request(app)
          .post('/crypto/hash')
          .send({
            data: 'test',
            algorithm: algorithm,
          })
          .set(
            'Authorization',
            `Bearer ${generateTestToken(TEST_USERS.regular)}`
          )
          .set('Content-Type', 'application/json');

        // Should reject weak algorithms
        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/unsupported|weak|deprecated/i);
      }
    });
  });

  describe('Data Privacy and Compliance', () => {
    test('should handle personal data according to GDPR requirements', async () => {
      const userToken = generateTestToken(TEST_USERS.regular);

      // Test data export (GDPR Article 20)
      const exportResponse = await request(app)
        .get('/gdpr/export')
        .set('Authorization', `Bearer ${userToken}`);

      if (exportResponse.status === 200) {
        expect(exportResponse.body.userData).toBeDefined();
        expect(exportResponse.body.format).toBe('json');
        expect(exportResponse.body.exported_at).toBeDefined();
      }

      // Test data deletion request (GDPR Article 17)
      const deleteResponse = await request(app)
        .post('/gdpr/delete-request')
        .send({ reason: 'user_request' })
        .set('Authorization', `Bearer ${userToken}`)
        .set('Content-Type', 'application/json');

      if (deleteResponse.status === 200) {
        expect(deleteResponse.body.requestId).toBeDefined();
        expect(deleteResponse.body.status).toBe('pending');
      }
    });

    test('should protect against data exfiltration', async () => {
      const exfiltrationAttempts = [
        '{ allUsers { email privateKey } }',
        '{ dumpDatabase { tables } }',
        '{ exportAllData { users transactions } }',
        '{ adminBackup { sensitiveData } }',
      ];

      for (const query of exfiltrationAttempts) {
        const response = await request(app)
          .post('/graphql')
          .send({ query })
          .set('Authorization', `Bearer ${generateTestToken(TEST_USERS.admin)}`)
          .set('Content-Type', 'application/json');

        // Should not allow bulk data export without proper authorization
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });
  });

  const generateTestToken = (user, expiresIn = '1h') => {
    return jwt.sign(
      {
        address: user.address,
        role: user.role,
        verified: user.verified,
        iat: Math.floor(Date.now() / 1000),
      },
      TEST_SECRETS.JWT_SECRET,
      { expiresIn, issuer: 'wrfcoin-platform', audience: 'wrfcoin-api' }
    );
  };
});
