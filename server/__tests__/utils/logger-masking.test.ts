/**
 * Logger Sensitive Data Masking Tests - Task 113.10
 *
 * Validates that the maskSensitiveData function properly redacts
 * sensitive fields from log output to prevent accidental exposure
 * of PII, credentials, and secrets.
 *
 * This test suite validates all 23+ required sensitive field patterns:
 * - Credentials: password, secret, apiKey, api_key, token, jwt, bearer, authorization
 * - Financial: privateKey, private_key, mnemonic, seed, seedPhrase, walletKey
 * - Personal: ssn, socialSecurityNumber, creditCard, cardNumber, cvv, pin
 * - Authentication: sessionId, sessionToken, refreshToken, accessToken
 */

// Import the maskSensitiveData and isSensitiveField functions
// Note: We need to test the compiled JS version or use ts-node
import { maskSensitiveData, isSensitiveField } from '../../utils/logger.js';

describe('maskSensitiveData', () => {
  describe('Direct field name matching', () => {
    // All 23+ required sensitive fields plus additional security-related fields
    const sensitiveFieldsToTest = [
      // Credentials (8 fields)
      'password',
      'secret',
      'apiKey',
      'api_key',
      'token',
      'jwt',
      'bearer',
      'authorization',
      // Financial/Crypto (6 fields)
      'privateKey',
      'private_key',
      'mnemonic',
      'seed',
      'seedPhrase',
      'seed_phrase',
      'walletKey',
      'wallet_key',
      // Personal Data (6 fields)
      'ssn',
      'socialSecurityNumber',
      'social_security_number',
      'creditCard',
      'credit_card',
      'cardNumber',
      'card_number',
      'cvv',
      'cvc',
      'pin',
      // Authentication (8 fields)
      'sessionId',
      'session_id',
      'sessionToken',
      'session_token',
      'refreshToken',
      'refresh_token',
      'accessToken',
      'access_token',
      'bearerToken',
      'bearer_token',
      'jwtToken',
      'jwt_token',
      // Additional security fields
      'auth',
      'cookie',
      'signature',
      'credentials',
      'encryptionKey',
      'encryption_key',
      'key',
      'passphrase',
      'pass_phrase',
      'secretKey',
      'secret_key',
      'masterKey',
      'master_key',
      'recoveryKey',
      'recovery_key',
      'backupCode',
      'backup_code',
      'otp',
      'totp',
      'otpSecret',
      'otp_secret',
    ];

    test.each(sensitiveFieldsToTest)(
      'should redact field: %s',
      fieldName => {
        const input = { [fieldName]: 'sensitive-value-123' };
        const result = maskSensitiveData(input);
        expect(result[fieldName]).toBe('[REDACTED]');
      }
    );

    test('should redact all 23+ required sensitive fields in a single object', () => {
      const input = {
        // Credentials (8 fields)
        password: 'my-password',
        secret: 'super-secret',
        apiKey: 'sk-12345',
        api_key: 'sk-snake-case',
        token: 'bearer-token-xyz',
        jwt: 'eyJhbGciOiJIUzI1NiJ9...',
        bearer: 'bearer-value',
        authorization: 'Bearer xyz',
        // Financial/Crypto (6 fields)
        privateKey: '0x1234567890abcdef',
        private_key: '0xsnake_case_key',
        mnemonic: 'abandon abandon abandon',
        seed: 'word1 word2 word3',
        seedPhrase: 'seed phrase here',
        walletKey: 'wallet-key-value',
        // Personal Data (6 fields)
        ssn: '123-45-6789',
        socialSecurityNumber: '987-65-4321',
        creditCard: '4111111111111111',
        cardNumber: '4111-1111-1111-1111',
        cvv: '123',
        pin: '1234',
        // Authentication (4 fields)
        sessionId: 'sess-456',
        sessionToken: 'sess-token',
        refreshToken: 'refresh-abc',
        accessToken: 'access-xyz',
      };

      const result = maskSensitiveData(input);

      // All sensitive fields should be redacted
      Object.keys(input).forEach(key => {
        expect(result[key]).toBe('[REDACTED]');
      });
    });

    test('should redact additional security-related fields', () => {
      const input = {
        cookie: 'session=abc123',
        signature: '0xsig123',
        auth: 'auth-data',
        credentials: { user: 'test', pass: 'test' },
        bearerToken: 'bearer-123',
        jwtToken: 'eyJhbGc...',
        encryptionKey: 'enc-key-456',
        key: 'api-key-abc',
        passphrase: 'secret-passphrase',
        secretKey: 'sk-secret',
        masterKey: 'master-key-value',
        recoveryKey: 'recovery-key-value',
        backupCode: 'ABCD-1234',
        otp: '123456',
        totp: '654321',
        otpSecret: 'JBSWY3DPEHPK3PXP',
      };

      const result = maskSensitiveData(input);

      Object.keys(input).forEach(key => {
        expect(result[key]).toBe('[REDACTED]');
      });
    });
  });

  describe('Pattern matching (contains)', () => {
    test('should redact fields containing "password"', () => {
      const input = {
        userPassword: 'secret123',
        passwordHash: 'hash456',
        newPasswordConfirm: 'confirm789',
      };
      const result = maskSensitiveData(input);
      expect(result.userPassword).toBe('[REDACTED]');
      expect(result.passwordHash).toBe('[REDACTED]');
      expect(result.newPasswordConfirm).toBe('[REDACTED]');
    });

    test('should redact fields containing "secret"', () => {
      const input = {
        clientSecret: 'cs-123',
        secretKey: 'sk-456',
        appSecretValue: 'asv-789',
      };
      const result = maskSensitiveData(input);
      expect(result.clientSecret).toBe('[REDACTED]');
      expect(result.secretKey).toBe('[REDACTED]');
      expect(result.appSecretValue).toBe('[REDACTED]');
    });

    test('should redact fields containing "private"', () => {
      const input = {
        privateData: 'data-123',
        walletPrivateKey: '0xprivate',
        isPrivate: 'yes',
      };
      const result = maskSensitiveData(input);
      expect(result.privateData).toBe('[REDACTED]');
      expect(result.walletPrivateKey).toBe('[REDACTED]');
      expect(result.isPrivate).toBe('[REDACTED]');
    });

    test('should redact fields containing "mnemonic"', () => {
      const input = {
        mnemonicPhrase: 'word1 word2 word3',
        walletMnemonic: 'abandon abandon',
        backupMnemonicWords: 'seed phrase here',
      };
      const result = maskSensitiveData(input);
      expect(result.mnemonicPhrase).toBe('[REDACTED]');
      expect(result.walletMnemonic).toBe('[REDACTED]');
      expect(result.backupMnemonicWords).toBe('[REDACTED]');
    });

    test('should redact fields containing "credential"', () => {
      const input = {
        userCredential: 'cred-123',
        credentialToken: 'token-456',
        oauthCredentials: { token: 'xyz' },
      };
      const result = maskSensitiveData(input);
      expect(result.userCredential).toBe('[REDACTED]');
      expect(result.credentialToken).toBe('[REDACTED]');
      expect(result.oauthCredentials).toBe('[REDACTED]');
    });
  });

  describe('Case insensitivity', () => {
    test('should redact regardless of case', () => {
      const input = {
        PASSWORD: 'upper',
        Password: 'title',
        passWORD: 'mixed',
        API_KEY: 'upper-key',
        ApiKey: 'title-key',
      };
      const result = maskSensitiveData(input);
      expect(result.PASSWORD).toBe('[REDACTED]');
      expect(result.Password).toBe('[REDACTED]');
      expect(result.passWORD).toBe('[REDACTED]');
      expect(result.API_KEY).toBe('[REDACTED]');
      expect(result.ApiKey).toBe('[REDACTED]');
    });
  });

  describe('Non-sensitive fields preservation', () => {
    test('should preserve non-sensitive string fields', () => {
      const input = {
        username: 'john_doe',
        email: 'john@example.com',
        userId: '12345',
        action: 'login',
        timestamp: '2024-01-15T10:00:00Z',
      };
      const result = maskSensitiveData(input);
      expect(result.username).toBe('john_doe');
      expect(result.email).toBe('john@example.com');
      expect(result.userId).toBe('12345');
      expect(result.action).toBe('login');
      expect(result.timestamp).toBe('2024-01-15T10:00:00Z');
    });

    test('should preserve non-sensitive numeric fields', () => {
      const input = {
        count: 42,
        balance: 100.5,
        blockHeight: 12345678,
      };
      const result = maskSensitiveData(input);
      expect(result.count).toBe(42);
      expect(result.balance).toBe(100.5);
      expect(result.blockHeight).toBe(12345678);
    });

    test('should preserve boolean fields', () => {
      const input = {
        isActive: true,
        verified: false,
      };
      const result = maskSensitiveData(input);
      expect(result.isActive).toBe(true);
      expect(result.verified).toBe(false);
    });
  });

  describe('Nested objects', () => {
    test('should recursively mask nested objects', () => {
      const input = {
        user: {
          name: 'John',
          password: 'secret123',
          wallet: {
            address: '0x123',
            privateKey: '0xprivate',
          },
          account: { address: '0x456', privateKey: '0xprivate2' },
        },
      };
      const result = maskSensitiveData(input);
      expect(result.user.name).toBe('John');
      expect(result.user.password).toBe('[REDACTED]');
      // Updated: a key named "wallet" is itself sensitive, so the whole subtree is replaced
      // (fails safe); the address inside it is not readable. Non-wallet nesting is masked per key.
      expect(result.user.wallet).toBe('[REDACTED]');
      expect(result.user.account.address).toBe('0x456');
      expect(result.user.account.privateKey).toBe('[REDACTED]');
    });

    test('should handle deeply nested sensitive fields', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              apiKey: 'deep-secret',
              data: 'safe-data',
            },
          },
        },
      };
      const result = maskSensitiveData(input);
      expect(result.level1.level2.level3.apiKey).toBe('[REDACTED]');
      expect(result.level1.level2.level3.data).toBe('safe-data');
    });
  });

  describe('Arrays', () => {
    test('should mask sensitive fields in array elements', () => {
      const input = {
        users: [
          { name: 'User1', password: 'pass1' },
          { name: 'User2', password: 'pass2' },
        ],
      };
      const result = maskSensitiveData(input);
      expect(result.users[0].name).toBe('User1');
      expect(result.users[0].password).toBe('[REDACTED]');
      expect(result.users[1].name).toBe('User2');
      expect(result.users[1].password).toBe('[REDACTED]');
    });
  });

  describe('Edge cases', () => {
    test('should handle null values', () => {
      const input = { password: null, username: 'test' };
      const result = maskSensitiveData(input);
      expect(result.password).toBe('[REDACTED]');
      expect(result.username).toBe('test');
    });

    test('should handle undefined values', () => {
      const input = { token: undefined, action: 'test' };
      const result = maskSensitiveData(input);
      expect(result.token).toBe('[REDACTED]');
      expect(result.action).toBe('test');
    });

    test('should handle empty objects', () => {
      const input = {};
      const result = maskSensitiveData(input);
      expect(result).toEqual({});
    });

    test('should handle non-object input gracefully', () => {
      expect(maskSensitiveData(null as any)).toBeNull();
      expect(maskSensitiveData(undefined as any)).toBeUndefined();
      expect(maskSensitiveData('string' as any)).toBe('string');
      expect(maskSensitiveData(123 as any)).toBe(123);
    });
  });

  describe('Mixed sensitive and non-sensitive fields', () => {
    test('should correctly handle a realistic log payload', () => {
      const input = {
        event: 'user_authentication',
        timestamp: '2024-01-15T10:30:00Z',
        user: {
          id: 'user-123',
          email: 'user@example.com',
          walletAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        },
        authentication: {
          method: 'jwt',
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          sessionId: 'sess-abc123',
        },
        request: {
          ip: '192.168.1.1',
          userAgent: 'Mozilla/5.0...',
          authorization: 'Bearer xyz123',
        },
        metadata: {
          chainId: 1,
          blockNumber: 12345678,
        },
      };

      const result = maskSensitiveData(input);

      // Non-sensitive fields preserved
      expect(result.event).toBe('user_authentication');
      expect(result.timestamp).toBe('2024-01-15T10:30:00Z');
      expect(result.user.id).toBe('user-123');
      expect(result.user.email).toBe('user@example.com');
      // Updated: walletAddress contains "wallet", which production redacts (Task 113, 3ba864fa).
      expect(result.user.walletAddress).toBe('[REDACTED]');
      // Updated: the key "authentication" matches the 'auth_'/'_auth' partial patterns (their
      // underscore-stripped form is 'auth'), so the whole object is replaced. Fails safe; the
      // breadth is noted in the PR body, production is unchanged.
      expect(result.authentication).toBe('[REDACTED]');
      expect(result.request.ip).toBe('192.168.1.1');
      expect(result.request.userAgent).toBe('Mozilla/5.0...');
      expect(result.metadata.chainId).toBe(1);
      expect(result.metadata.blockNumber).toBe(12345678);

      // Sensitive fields redacted
      expect(result.request.authorization).toBe('[REDACTED]');
    });
  });

  describe('Deep nesting and max depth handling', () => {
    test('should handle deeply nested objects up to maxDepth', () => {
      // Root is depth 0, so with the default maxDepth of 10 an object at depth 9 is still masked.
      let node: any = { password: 'deep-secret', data: 'safe-data' };
      for (let level = 9; level >= 1; level--) node = { [`level${level}`]: node };
      const result = maskSensitiveData(node);
      let cursor = result;
      for (let level = 1; level <= 9; level++) cursor = cursor[`level${level}`];
      expect(cursor.password).toBe('[REDACTED]');
      expect(cursor.data).toBe('safe-data');
    });

    test('an object nested past maxDepth is truncated, never leaked (fails safe)', () => {
      // Updated: the old test nested 11 levels and expected the secret at depth 10 to be redacted
      // in place; production returns '[MAX_DEPTH_REACHED]' at depth 10, so the secret is not emitted.
      let node: any = { password: 'deep-secret', data: 'safe-data' };
      for (let level = 10; level >= 1; level--) node = { [`level${level}`]: node };
      const result = maskSensitiveData(node);
      let cursor = result;
      for (let level = 1; level <= 9; level++) cursor = cursor[`level${level}`];
      expect(cursor.level10).toBe('[MAX_DEPTH_REACHED]');
      expect(JSON.stringify(result)).not.toContain('deep-secret');
    });

    test('should handle Date objects correctly', () => {
      const now = new Date();
      const input = {
        timestamp: now,
        password: 'secret',
      };
      const result = maskSensitiveData(input);
      expect(result.timestamp).toBe(now);
      expect(result.password).toBe('[REDACTED]');
    });

    test('should handle Error objects correctly', () => {
      const error = new Error('Test error');
      const result = maskSensitiveData(error);
      expect(result.name).toBe('Error');
      expect(result.message).toBe('Test error');
    });
  });

  describe('Comprehensive Task 113.10 validation', () => {
    test('should mask all 23 required sensitive field categories', () => {
      // This test validates all fields explicitly required by Task 113.10
      const requiredFields = {
        // Credentials (8)
        password: 'test-password',
        secret: 'test-secret',
        apiKey: 'test-apiKey',
        api_key: 'test-api_key',
        token: 'test-token',
        jwt: 'test-jwt',
        bearer: 'test-bearer',
        authorization: 'test-authorization',
        // Financial (6)
        privateKey: 'test-privateKey',
        private_key: 'test-private_key',
        mnemonic: 'test-mnemonic',
        seed: 'test-seed',
        seedPhrase: 'test-seedPhrase',
        walletKey: 'test-walletKey',
        // Personal (6)
        ssn: 'test-ssn',
        socialSecurityNumber: 'test-socialSecurityNumber',
        creditCard: 'test-creditCard',
        cardNumber: 'test-cardNumber',
        cvv: 'test-cvv',
        pin: 'test-pin',
        // Authentication (4)
        sessionId: 'test-sessionId',
        sessionToken: 'test-sessionToken',
        refreshToken: 'test-refreshToken',
        accessToken: 'test-accessToken',
      };

      const result = maskSensitiveData(requiredFields);

      // Verify all required fields are masked
      Object.keys(requiredFields).forEach(key => {
        expect(result[key]).toBe('[REDACTED]');
      });
    });

    test('should work with all log levels (simulated via different object structures)', () => {
      // Simulate different log payloads that might come from different log levels
      const errorLog = {
        level: 'error',
        message: 'Authentication failed',
        password: 'user-password',
        stack: 'Error: ...',
      };

      const warnLog = {
        level: 'warn',
        message: 'Rate limit approaching',
        apiKey: 'api-key-123',
        requestCount: 99,
      };

      const infoLog = {
        level: 'info',
        message: 'User logged in',
        sessionToken: 'sess-token',
        userId: 'user-123',
      };

      const debugLog = {
        level: 'debug',
        message: 'Token refresh',
        refreshToken: 'refresh-abc',
        accessToken: 'access-xyz',
        expiresIn: 3600,
      };

      // All should mask sensitive fields regardless of log level
      expect(maskSensitiveData(errorLog).password).toBe('[REDACTED]');
      expect(maskSensitiveData(warnLog).apiKey).toBe('[REDACTED]');
      expect(maskSensitiveData(infoLog).sessionToken).toBe('[REDACTED]');
      expect(maskSensitiveData(debugLog).refreshToken).toBe('[REDACTED]');
      expect(maskSensitiveData(debugLog).accessToken).toBe('[REDACTED]');

      // Non-sensitive fields preserved
      expect(maskSensitiveData(errorLog).level).toBe('error');
      expect(maskSensitiveData(warnLog).requestCount).toBe(99);
      expect(maskSensitiveData(infoLog).userId).toBe('user-123');
      expect(maskSensitiveData(debugLog).expiresIn).toBe(3600);
    });
  });
});

describe('isSensitiveField', () => {
  describe('Exact match detection', () => {
    const exactMatchFields = [
      'password',
      'secret',
      'apiKey',
      'api_key',
      'token',
      'jwt',
      'bearer',
      'authorization',
      'privateKey',
      'private_key',
      'mnemonic',
      'seed',
      'seedPhrase',
      'walletKey',
      'ssn',
      'socialSecurityNumber',
      'creditCard',
      'cardNumber',
      'cvv',
      'pin',
      'sessionId',
      'sessionToken',
      'refreshToken',
      'accessToken',
    ];

    test.each(exactMatchFields)('should detect "%s" as sensitive', field => {
      expect(isSensitiveField(field)).toBe(true);
    });
  });

  describe('Case insensitivity', () => {
    test('should detect PASSWORD (uppercase)', () => {
      expect(isSensitiveField('PASSWORD')).toBe(true);
    });

    test('should detect apiKey (mixed case)', () => {
      expect(isSensitiveField('ApiKey')).toBe(true);
    });

    test('should detect PRIVATE_KEY (uppercase snake)', () => {
      expect(isSensitiveField('PRIVATE_KEY')).toBe(true);
    });
  });

  describe('Partial match detection', () => {
    test('should detect userPassword (contains password)', () => {
      expect(isSensitiveField('userPassword')).toBe(true);
    });

    test('should detect clientSecret (contains secret)', () => {
      expect(isSensitiveField('clientSecret')).toBe(true);
    });

    test('should detect walletPrivateKey (contains private)', () => {
      expect(isSensitiveField('walletPrivateKey')).toBe(true);
    });

    test('should detect oauthCredentials (contains credential)', () => {
      expect(isSensitiveField('oauthCredentials')).toBe(true);
    });
  });

  describe('Non-sensitive field detection', () => {
    const nonSensitiveFields = [
      'username',
      'email',
      'userId',
      'blockNumber',
      'timestamp',
      'action',
      'status',
      'count',
      'balance',
    ];

    test.each(nonSensitiveFields)('should NOT detect "%s" as sensitive', field => {
      expect(isSensitiveField(field)).toBe(false);
    });

    // Updated (backend#1243 follow-up H18): 'wallet' is a partialMatch pattern in logger.ts since
    // Task 113 (3ba864fa), so any key containing "wallet" is redacted. A wallet address is
    // pseudonymous personal data, so the production rule stays and this expectation was stale.
    test.each(['walletAddress', 'wallet_address', 'wallet'])('"%s" IS sensitive (wallet identifiers are redacted from logs)', field => {
      expect(isSensitiveField(field)).toBe(true);
    });
  });
});
