/** backend#1156 — fabricated Model Context APIs are absent from releases. */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';

const router = require('../../server/routes/model-context-routes');
const apiNotFound = require('../../server/middleware/api-not-found');
const repoRoot = path.resolve(__dirname, '../..');

describe('retired Model Context boundary', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/model-context', router);

  it.each([
    ['get', '/api/model-context'],
    ['post', '/api/model-context'],
    ['put', '/api/model-context/example'],
    ['post', '/api/model-context/example/validation'],
    ['get', '/api/model-context/example/export'],
  ] as const)('%s %s fails closed', async (method, routePath) => {
    const response = await request(app)[method](routePath).send({
      name: 'attempted mutation',
      testDatasetId: 'unverified',
    });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      success: false,
      available: false,
      proofClass: 'UNAVAILABLE',
      code: 'MODEL_CONTEXT_API_RETIRED',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /overallScore|validationId|exportId|api\.wrfcoin\.network|status":"success/i,
    );
  });

  it('is not mounted by either release server', () => {
    for (const relativePath of [
      'server/server.js',
      'server/enhanced_unified_api_optimized.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /(?:app\.use|safeMount)\(\s*['"]\/api\/model-context['"]/,
      );
    }
  });

  it('cannot fall through to the production SPA after retirement', async () => {
    const releaseApp = express();
    releaseApp.use(apiNotFound);
    releaseApp.get('*', (_req, res) => res.status(200).type('html').send('SPA'));

    const retired = await request(releaseApp).get('/api/model-context');
    expect(retired.status).toBe(404);
    expect(retired.type).toMatch(/json/);
    expect(retired.body).toMatchObject({
      success: false,
      available: false,
      proofClass: 'UNAVAILABLE',
      code: 'API_ROUTE_NOT_FOUND',
    });

    const frontend = await request(releaseApp).get('/dashboard');
    expect(frontend.status).toBe(200);
    expect(frontend.text).toBe('SPA');
  });

  it('mounts the API fail-closed boundary before the production SPA', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'server/server.js'),
      'utf8',
    );
    const apiBoundary = source.indexOf(
      'app.use(require(\'./middleware/api-not-found\'))',
    );
    const spaFallback = source.indexOf('app.get(\'*\'');

    expect(apiBoundary).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(apiBoundary);
  });

  it('retains no simulated success fixtures', () => {
    const route = fs.readFileSync(
      path.join(repoRoot, 'server/routes/model-context-routes.js'),
      'utf8',
    );

    expect(route).not.toMatch(
      /ctx_weather_global|overallScore|validationId|exportId|api\.wrfcoin\.network|Model context imported successfully/,
    );
    expect(route).toContain('proofClass: \'UNAVAILABLE\'');
  });
});
