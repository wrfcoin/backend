import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const mockInfo = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock('../server/utils/logger', () => ({
  appLogger: {
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: jest.fn(),
  },
}));

describe('EmergencyResponseSystem notification dispatch (#215)', () => {
  let EmergencyResponseSystem: any;
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.resetModules();
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
    process.env.NODE_ENV = 'test';
    delete process.env.EMERGENCY_WEBHOOK_URL;
    delete process.env.HEALTH_CHECK_URL;
    globalThis.fetch = originalFetch;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    EmergencyResponseSystem = require('../middleware/emergency-response.js').EmergencyResponseSystem;

    // Clear mocks after module load — the dynamic import() of auth-middleware
    // logs an error at module initialization time which is unrelated to our tests.
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it('sendNotification falls back to console dispatcher for unknown channel types', async () => {
    const system = new EmergencyResponseSystem();
    const channel = { type: 'email', name: 'Email Alert System', enabled: true };
    const incident = {
      id: 'inc-1', title: 'Test', description: 'Test incident',
      severity: 'HIGH', type: 'test', declaredAt: new Date().toISOString(),
    };
    const severityConfig = { notificationLevel: 'executive' };

    await system.sendNotification(channel, incident, severityConfig);

    // Console dispatcher logs at info, not error
    expect(mockInfo).toHaveBeenCalledWith(
      'Emergency notification delivered',
      expect.objectContaining({ channel: 'Email Alert System', channelType: 'email' }),
    );
    // Auth middleware import() may fire an error asynchronously — filter it out
    const emergencyErrors = mockError.mock.calls.filter(
      (args: unknown[]) => !(args[0] as string).includes('auth middleware'),
    );
    expect(emergencyErrors).toHaveLength(0);
  });

  it('sendNotification uses webhook dispatcher when EMERGENCY_WEBHOOK_URL is set', async () => {
    const system = new EmergencyResponseSystem();
    const mockFetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    process.env.EMERGENCY_WEBHOOK_URL = 'http://localhost:9999/hook';

    const channel = { type: 'webhook', name: 'Monitoring', enabled: true, endpoint: '' };
    const incident = {
      id: 'inc-2', title: 'Webhook Test', description: 'desc',
      severity: 'CRITICAL', type: 'test', declaredAt: new Date().toISOString(),
    };

    await system.sendNotification(channel, incident, {});

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9999/hook',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockInfo).toHaveBeenCalledWith(
      'Emergency notification delivered',
      expect.objectContaining({ channelType: 'webhook' }),
    );
  });

  it('sendNotification reports unconfigured when webhook URL is placeholder', async () => {
    const system = new EmergencyResponseSystem();
    const channel = {
      type: 'webhook', name: 'Monitoring',
      endpoint: 'https://monitoring.wrfcoin.org/webhooks/emergency', enabled: true,
    };
    const incident = {
      id: 'inc-3', title: 'Test', description: 'desc',
      severity: 'LOW', type: 'test', declaredAt: new Date().toISOString(),
    };

    await system.sendNotification(channel, incident, {});

    expect(mockWarn).toHaveBeenCalledWith(
      'Emergency notification channel not configured',
      expect.objectContaining({ channelType: 'webhook' }),
    );
    // Auth middleware import() may fire an error asynchronously — filter it out
    const emergencyErrors = mockError.mock.calls.filter(
      (args: unknown[]) => !(args[0] as string).includes('auth middleware'),
    );
    expect(emergencyErrors).toHaveLength(0);
  });

  it('assessSystemHealth returns real status when health endpoint is reachable', async () => {
    const system = new EmergencyResponseSystem();
    const healthBody = { status: 'healthy', uptime: 123 };
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify(healthBody), { status: 200 }),
    );
    process.env.HEALTH_CHECK_URL = 'http://localhost:4001/health';

    const result = await system.assessSystemHealth();

    expect(result.overall).toBe('healthy');
    expect(result.details).toEqual(healthBody);
    expect(result.message).toBe('Backend API is healthy');
  });

  it('assessSystemHealth returns unreachable when fetch throws', async () => {
    const system = new EmergencyResponseSystem();
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    const result = await system.assessSystemHealth();

    expect(result.overall).toBe('unreachable');
    expect(result.infrastructure.network).toBe('degraded');
    expect(mockWarn).toHaveBeenCalledWith(
      'Health probe failed for backend API',
      expect.objectContaining({ error: 'connect ECONNREFUSED' }),
    );
  });

  it('executeAutomatedStep does not log at error level', async () => {
    const system = new EmergencyResponseSystem();
    const step = { action: 'Activate backup', step: 1, automated: true };

    const result = await system.executeAutomatedStep(step, 'inc-4');

    expect(result.requiresManualIntervention).toBe(true);
    expect(result.success).toBe(false);
    expect(mockWarn).toHaveBeenCalled();
    // Auth middleware import() may fire an error asynchronously — filter it out
    const emergencyErrors = mockError.mock.calls.filter(
      (args: unknown[]) => !(args[0] as string).includes('auth middleware'),
    );
    expect(emergencyErrors).toHaveLength(0);
  });

  it('registerNotificationDispatcher adds custom dispatchers', async () => {
    const system = new EmergencyResponseSystem();
    const customHandler = jest.fn().mockResolvedValue({ delivered: true, message: 'custom OK' });
    system.registerNotificationDispatcher('pagerduty', customHandler);

    const channel = { type: 'pagerduty', name: 'PagerDuty', enabled: true };
    const incident = {
      id: 'inc-5', title: 'Custom Test', description: 'desc',
      severity: 'HIGH', type: 'test', declaredAt: new Date().toISOString(),
    };

    await system.sendNotification(channel, incident, {});

    expect(customHandler).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ incidentId: 'inc-5' }),
    );
    expect(mockInfo).toHaveBeenCalledWith(
      'Emergency notification delivered',
      expect.objectContaining({ channelType: 'pagerduty' }),
    );
  });
});
