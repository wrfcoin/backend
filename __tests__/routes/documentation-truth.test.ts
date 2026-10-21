import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

const router = require('../../server/routes/documentation-routes');
const documentationIndex = require('../../server/data/documentation-index.json');

const repositoryRoot = path.resolve(__dirname, '..', '..');

describe('documentation route truth boundary', () => {
  const app = express();
  app.use('/api/documentation', router);

  test('every manifest path exists on disk', () => {
    expect(documentationIndex.length).toBeGreaterThan(0);
    for (const entry of documentationIndex) {
      expect(fs.existsSync(path.join(repositoryRoot, entry.path))).toBe(true);
    }
  });

  test('the build gate verifies every indexed document inside dist', () => {
    const buildScript = fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8');
    expect(buildScript).toContain('verify-documentation-build-assets.mjs');
    const verifier = fs.readFileSync(
      path.join(repositoryRoot, 'scripts/verify-documentation-build-assets.mjs'),
      'utf8',
    );
    expect(verifier).toContain("path.join('dist', entry.path)");
  });

  test('the public list is sourced from the checked-in manifest', async () => {
    const publicEntries = documentationIndex.filter((entry: { internal?: boolean }) => !entry.internal);
    const response = await request(app).get('/api/documentation').expect(200);
    expect(response.body.count).toBe(publicEntries.length);
    expect(response.body.resources.map((entry: { path: string }) => entry.path))
      .toEqual(publicEntries.map((entry: { path: string }) => entry.path));
  });

  // backend#1224: operations docs carried `ssh root@<lan-ip> "pct exec ..."`,
  // internal hosts and /debug/seed-account. They are operator-only.
  describe('internal documents', () => {
    const internalEntries = documentationIndex.filter((entry: { internal?: boolean }) => entry.internal);
    const OPERATOR = { authorization: 'Bearer test-operator-token-1224' };

    beforeAll(() => {
      process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token-1224';
    });
    afterAll(() => {
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
    });

    test('every served public document is free of host, SSH and debug content', () => {
      for (const entry of documentationIndex.filter((e: { internal?: boolean }) => !e.internal)) {
        const content = fs.readFileSync(path.join(repositoryRoot, entry.path), 'utf8');
        expect({ id: entry.id, leaks: /ssh |root@|pct exec|192\.168\.|seed-account/.test(content) })
          .toEqual({ id: entry.id, leaks: false });
      }
    });

    test('anonymous callers cannot list, search or fetch internal documents', async () => {
      expect(internalEntries.length).toBeGreaterThan(0);
      const list = await request(app).get('/api/documentation').expect(200);
      const categories = await request(app).get('/api/documentation/categories/list').expect(200);
      const listedIds = list.body.resources.map((entry: { id: string }) => entry.id);
      for (const entry of internalEntries) {
        expect(listedIds).not.toContain(entry.id);
        await request(app).get(`/api/documentation/${entry.id}`).expect(404);
        const search = await request(app)
          .get(`/api/documentation/search/query?q=${encodeURIComponent(entry.title)}`)
          .expect(200);
        expect(search.body.results.map((r: { id: string }) => r.id)).not.toContain(entry.id);
      }
      const categoryTotal = categories.body.categories.reduce((n: number, c: { count: number }) => n + c.count, 0);
      expect(categoryTotal).toBe(documentationIndex.length - internalEntries.length);
      expect(JSON.stringify(list.body)).not.toContain('"internal"');
    });

    test('an operator token sees and fetches internal documents', async () => {
      const list = await request(app).get('/api/documentation').set(OPERATOR).expect(200);
      expect(list.body.count).toBe(documentationIndex.length);
      for (const entry of internalEntries) {
        const response = await request(app).get(`/api/documentation/${entry.id}`).set(OPERATOR).expect(200);
        expect(response.body.path).toBe(entry.path);
      }
    });
  });

  test('search for a nonsense term returns no results', async () => {
    const response = await request(app)
      .get('/api/documentation/search/query?q=definitely-not-a-real-document-term')
      .expect(200);
    expect(response.body).toMatchObject({ count: 0, results: [] });
  });

  test('document lookup returns checked-in content', async () => {
    const entry = documentationIndex[0];
    const response = await request(app).get(`/api/documentation/${entry.id}`).expect(200);
    expect(response.body.path).toBe(entry.path);
    expect(response.body.content).toBe(fs.readFileSync(path.join(repositoryRoot, entry.path), 'utf8'));
  });

  test('unwired API references return the standard unavailable envelope', async () => {
    const response = await request(app).get('/api/documentation/api/wallet').expect(501);
    expect(response.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'documentation.api-reference' },
    });
  });

  test('production router contains no development-data marker', () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot, 'server/routes/documentation-routes.js'),
      'utf8',
    );
    expect(source.toLocaleLowerCase()).not.toContain('mock');
  });
});
