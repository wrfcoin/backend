import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { probeCore4Readiness } = require('../server/utils/core4-launch-health');

describe('core4 launch health helpers', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  it('checks core4 /readyz and reports up for ready responses', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { status: 'ready' },
    });

    const result = await probeCore4Readiness({
      baseUrl: 'http://core4.test',
      timeoutMs: 50,
    });

    expect(axios.get).toHaveBeenCalledWith(
      'http://core4.test/readyz',
      expect.objectContaining({ timeout: 50 })
    );
    expect(result.status).toBe('up');
    expect(result.readinessStatus).toBe('ready');
  });

  it('reports down when core4 /readyz returns not_ready', async () => {
    axios.get.mockResolvedValue({
      status: 503,
      data: { status: 'not_ready', reason: 'state divergence' },
    });

    const result = await probeCore4Readiness({
      baseUrl: 'http://core4.test',
    });

    expect(result.status).toBe('down');
    expect(result.httpStatus).toBe(503);
    expect(result.readinessStatus).toBe('not_ready');
    expect(result.lastError).toContain('/readyz');
  });

  it('reports down when core4 /readyz returns ready false', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { ready: false },
    });

    const result = await probeCore4Readiness({
      baseUrl: 'http://core4.test',
    });

    expect(result.status).toBe('down');
    expect(result.httpStatus).toBe(200);
    expect(result.readinessStatus).toBe('false');
  });
});
