/** backend#1157 — mock AI providers and canned analysis are release-inert. */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const aiPluginRoutes = require('../../server/routes/ai-plugin-routes.js');
const apiNotFound = require('../../server/middleware/api-not-found');
const repoRoot = path.resolve(__dirname, '../..');

describe('retired AI plugin boundary', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiPluginRoutes);

  it.each([
    ['get', '/api/ai'],
    ['get', '/api/ai/openai'],
    ['post', '/api/ai/openai/analyze-weather'],
    ['post', '/api/ai/wolfram/analyze-blockchain'],
    ['post', '/api/ai/huggingface/enhance-forecast'],
    ['put', '/api/ai/openai/settings'],
  ] as const)('%s %s cannot claim provider success', async (method, routePath) => {
    const response = await request(app)[method](routePath).send({
      data: { temperature: 20 },
      blocks: [{}],
      forecast: { id: 'unverified' },
      status: 'active',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      available: false,
      proofClass: 'UNAVAILABLE',
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /analysisId|enhancementId|confidenceImprovement|verificationScore|status":"active/i,
    );
  });

  it('is not mounted by either release server', () => {
    for (const relativePath of [
      'server/server.js',
      'server/enhanced_unified_api_optimized.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(/(?:app\.use|safeMount)\(\s*['"]\/api\/ai['"]/);
    }
  });

  it('retains no hardcoded providers or canned analysis', () => {
    const route = fs.readFileSync(
      path.join(repoRoot, 'server/routes/ai-plugin-routes.js'),
      'utf8',
    );

    expect(route).not.toMatch(
      /OpenAI Plugin|Wolfram Alpha Plugin|Hugging Face Plugin|analysisId|enhancementId|confidenceImprovement|verificationScore/,
    );
    expect(route).toContain('proofClass: \'UNAVAILABLE\'');
  });

  it('cannot fall through to the production SPA after retirement', async () => {
    const releaseApp = express();
    releaseApp.use(apiNotFound);
    releaseApp.get('*', (_req, res) => res.status(200).type('html').send('SPA'));

    const retired = await request(releaseApp).get('/api/ai/openai');
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
});
