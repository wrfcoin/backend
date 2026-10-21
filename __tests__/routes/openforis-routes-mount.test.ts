/** backend#1154 — retired OpenForis routes cannot report fabricated success. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import router from '../../server/routes/openforis-routes.js';

describe('retired OpenForis route boundary', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/openforis', router);

  it.each([
    ['get', '/api/openforis/status'],
    ['get', '/api/openforis/projects/example'],
    ['get', '/api/openforis/climate'],
    ['post', '/api/openforis/blockchain/export'],
  ] as const)('%s %s returns honest UNAVAILABLE', async (method, routePath) => {
    const response = await request(app)[method](routePath).send({ dataId: 'example' });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      success: false,
      available: false,
      proofClass: 'UNAVAILABLE',
      code: 'OPENFORIS_INTEGRATION_RETIRED',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /txHash|blockNumber|explorer|completed|anchored/i,
    );
  });
});
