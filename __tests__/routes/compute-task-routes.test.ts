import express from 'express';
import request from 'supertest';
import { createComputeTaskRouter } from '../../server/routes/compute-task-routes.js';
import { ComputeTaskApiService } from '../../server/services/forecast/compute-task-api-service.js';

describe('compute-task routes', () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    const service = new ComputeTaskApiService();
    app.use('/api', createComputeTaskRouter(service));
    return app;
  }

  it('supports authenticated task lifecycle endpoints', async () => {
    const app = createApp();

    const register = await request(app)
      .post('/api/compute/nodes/register')
      .send({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        capabilities: {
          gpu: true,
          memoryGb: 32,
          regions: ['us-west', 'us-central'],
        },
      });

    expect(register.status).toBe(201);
    const token = register.body.token;
    expect(token).toBeTruthy();

    const available = await request(app)
      .get('/api/compute/tasks/available')
      .set('Authorization', `Bearer ${token}`);
    expect(available.status).toBe(200);
    expect(Array.isArray(available.body.tasks)).toBe(true);
    expect(available.body.tasks.length).toBeGreaterThan(0);

    const taskId = available.body.tasks[0].id;

    const claim = await request(app)
      .post(`/api/compute/tasks/${taskId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(claim.status).toBe(200);
    expect(claim.body.leaseId).toBeDefined();

    const heartbeat = await request(app)
      .post(`/api/compute/tasks/${taskId}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        leaseId: claim.body.leaseId,
        progress: 45,
      });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.ok).toBe(true);

    const complete = await request(app)
      .post(`/api/compute/tasks/${taskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        leaseId: claim.body.leaseId,
        outputCid: 'bafyoutput',
      });
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);
  });

  it('rejects unauthenticated access to task endpoints', async () => {
    const app = createApp();
    const response = await request(app).get('/api/compute/tasks/available');
    expect(response.status).toBe(401);
  });
});

