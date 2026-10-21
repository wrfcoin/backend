const express = require('express');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const router = require('../../server/routes/mcp-routes');
const contextProvider = require('../../server/mcp/contextProvider');

describe('retired MCP context boundary', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', router);

  test('POST /api/mcp/context fails closed without generated data', async () => {
    const response = await request(app)
      .post('/api/mcp/context')
      .send({ providerId: 'blockchain-provider', type: 'block-data' })
      .expect(501);

    expect(response.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'mcp-context' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/blockNumber|balance|temperature/);
  });

  test('provider output is deterministic and explicitly unavailable', async () => {
    const first = await contextProvider.getContext('blockchain-provider', 'block-data');
    const second = await contextProvider.getContext('blockchain-provider', 'block-data');
    expect(first).toEqual(second);
    expect(first).toMatchObject({ success: false, unavailable: true });
  });

  test('production entrypoints do not mount MCP', () => {
    for (const relativePath of [
      'server/enhanced_unified_api_optimized.ts',
      'server/server.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
      expect(source).not.toMatch(/(?:safeMount|app\.use)\(['"]\/api\/mcp['"]/);
    }
  });

  test('context provider contains no random generator', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'server/mcp/contextProvider.js'),
      'utf8',
    );
    expect(source).not.toMatch(/Math\.random|randomBytes/);
  });
});
