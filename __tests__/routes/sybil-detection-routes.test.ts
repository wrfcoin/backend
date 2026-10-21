import express from 'express';
import request from 'supertest';
import { createSybilDetectionRouter } from '../../server/routes/sybil-detection-routes.js';

describe('sybil detection routes', () => {
  it('creates a sybil report and appends evidence', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/integrity/sybil', createSybilDetectionRouter());

    const detect = await request(app)
      .post('/api/integrity/sybil/detect')
      .send({
        participantId: 'did:wrf:participant-1',
        actorClass: 'robot',
        indicators: {
          ip_node_density: 3,
          payload_similarity_score: 0.8,
        },
      });

    expect(detect.status).toBe(201);
    expect(detect.body.success).toBe(true);
    const reportId = detect.body.data.reportId;

    const evidence = await request(app)
      .post(`/api/integrity/sybil/reports/${reportId}/evidence`)
      .send({
        type: 'manual_review_note',
        summary: 'Validated cluster behavior across repeated payload signatures',
        opaqueReference: 'sha256:evidence-1',
      });

    expect(evidence.status).toBe(201);
    expect(evidence.body.success).toBe(true);
  });
});
