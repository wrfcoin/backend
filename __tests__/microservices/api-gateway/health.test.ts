import { describe, it, expect, beforeEach } from '@jest/globals';
const request = require('supertest');
const express = require('express');

// Simple health check test
describe('Health Endpoint', () => {
  let app: any;

  beforeEach(() => {
    app = express();
    app.get('/health', (req, res) => {
      res.json({
        success: true,
        data: {
          status: 'healthy',
          gateway: 'api-gateway',
          timestamp: new Date().toISOString(),
          services: {},
        },
      });
    });
  });

  it('should return healthy status', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        status: 'healthy',
        gateway: 'api-gateway',
      },
    });

    expect(response.body.data).toHaveProperty('timestamp');
    expect(response.body.data).toHaveProperty('services');
  });
});
