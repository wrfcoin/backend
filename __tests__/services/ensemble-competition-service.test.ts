import { EnsembleCompetitionService } from '../../server/services/aiml/ensemble-competition-service.js';

describe('EnsembleCompetitionService', () => {
  it('scores closed rounds and ranks models by decayed skill', async () => {
    let now = Date.parse('2026-03-05T09:30:00Z');
    const service = new EnsembleCompetitionService({
      nowFn: () => new Date(now),
      halfLifeDays: 7,
      retirementThreshold: 0.4,
      retirementConsecutiveRounds: 2,
    });

    const basePayload = {
      domainBounds: { north: 41, south: 39, east: -104, west: -106 },
      validTimeRange: {
        start: '2026-03-05T09:00:00Z',
        end: '2026-03-05T10:00:00Z',
      },
    };

    await service.registerSubmission({
      modelId: 'model-alpha',
      modelName: 'Model Alpha',
      ...basePayload,
      metrics: { mae: 1, rmse: 2, bias: 0.1, skill_score: 0.82 },
    });

    await service.registerSubmission({
      modelId: 'model-beta',
      modelName: 'Model Beta',
      ...basePayload,
      metrics: { mae: 2, rmse: 3, bias: -0.2, skill_score: 0.62 },
    });

    now = Date.parse('2026-03-05T12:00:00Z');
    const firstScore = await service.scoreClosedRounds(new Date(now));
    expect(firstScore.scoredRounds).toHaveLength(1);

    const leaderboard = await service.getLeaderboard({ sortBy: 'decayed_skill', order: 'desc' });
    expect(leaderboard.standings.length).toBeGreaterThanOrEqual(2);

    const alpha = leaderboard.standings.find(item => item.modelId === 'model-alpha');
    const beta = leaderboard.standings.find(item => item.modelId === 'model-beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect((alpha as any).decayedSkillScore).toBeGreaterThan((beta as any).decayedSkillScore);

    now = Date.parse('2026-03-06T12:00:00Z');
    await service.registerSubmission({
      modelId: 'model-beta',
      modelName: 'Model Beta',
      domainBounds: basePayload.domainBounds,
      validTimeRange: {
        start: '2026-03-06T09:00:00Z',
        end: '2026-03-06T10:00:00Z',
      },
      metrics: { mae: 3, rmse: 4, bias: 0.5, skill_score: 0.2 },
    });

    await service.scoreClosedRounds(new Date(now));

    const modelStatus = await service.getModelStatus('model-beta');
    expect(modelStatus).toBeDefined();
    expect(modelStatus?.retirement.consecutiveBelowThreshold).toBeGreaterThanOrEqual(1);
  });

  it('auto-scores when submission window already closed', async () => {
    const now = Date.parse('2026-03-05T15:00:00Z');
    const service = new EnsembleCompetitionService({
      nowFn: () => new Date(now),
    });

    const result = await service.registerSubmission({
      modelId: 'model-gamma',
      domainBounds: { north: 41, south: 39, east: -104, west: -106 },
      validTimeRange: {
        start: '2026-03-05T11:00:00Z',
        end: '2026-03-05T12:00:00Z',
      },
      metrics: { mae: 1.5, rmse: 2.1, bias: 0, skill_score: 0.7 },
    });

    expect(result.autoScored).toBe(true);
    const standing = await service.getModelStatus('model-gamma');
    expect(standing?.rounds).toBe(1);
  });
});
