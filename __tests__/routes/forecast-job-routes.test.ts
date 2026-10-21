import express from 'express';
import request from 'supertest';
import { createForecastJobRouter } from '../../server/routes/forecast-job-routes.js';

describe('forecast-job routes', () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/compute',
      createForecastJobRouter({
        scheduler: fn => setTimeout(fn, 0),
      })
    );
    return app;
  }

  it('accepts forecast job submission and exposes status polling', async () => {
    const app = createApp();

    const submit = await request(app).post('/api/compute/forecast-jobs').send({
      model: 'WRF',
      forecastHours: 12,
      resolutionKm: 10,
      domainBounds: {
        north: 45,
        south: 30,
        west: -120,
        east: -100,
      },
      physicsOptions: {
        mp_physics: 6,
      },
    });

    expect(submit.status).toBe(202);
    expect(submit.body.success).toBe(true);
    const { jobId } = submit.body;

    const queued = await request(app).get(`/api/compute/forecast-jobs/${jobId}`);
    expect(queued.status).toBe(200);
    expect(queued.body.job.orchestration).toBeUndefined();
    expect(queued.body.job.request.rawPayload).toBeUndefined();
    expect([
      'queued',
      'preparing_inputs',
      'running_wps',
      'running_wrf',
      'postprocessing',
    ]).toContain(queued.body.job.status);

    let completed = await request(app).get(`/api/compute/forecast-jobs/${jobId}`);
    for (let i = 0; i < 20 && completed.body.job?.status !== 'completed'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      completed = await request(app).get(`/api/compute/forecast-jobs/${jobId}`);
    }

    expect(completed.status).toBe(200);
    expect(completed.body.job.status).toBe('completed');
    expect(completed.body.job.outputCid).toMatch(/^bafy[a-f0-9]{48}$/);
  });

  it('supports explicit cancellation', async () => {
    const app = createApp();
    const submit = await request(app).post('/api/compute/forecast-jobs').send({
      model: 'WRF',
      forecastHours: 24,
      resolutionKm: 10,
      domainBounds: {
        north: 45,
        south: 30,
        west: -120,
        east: -100,
      },
    });

    expect(submit.status).toBe(202);
    const jobId = submit.body.jobId;

    const cancel = await request(app).post(`/api/compute/forecast-jobs/${jobId}/cancel`).send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.job.status).toBe('cancelled');
  });

  it('rejects non-object body', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/compute/forecast-jobs')
      .send(['not', 'valid']);

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('returns 404 for unknown jobs', async () => {
    const app = createApp();
    const response = await request(app).get('/api/compute/forecast-jobs/forecast_job_missing');
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});
