const { createHealthMiddleware } = require('./middleware/create-health-middleware');

export interface MainApiProbeState {
  draining: boolean;
}

export interface MainApiBlockchainHealth {
  status?: string;
  services?: Record<string, unknown>;
}

export interface MainApiOperationalProbeOptions {
  state: MainApiProbeState;
  getBlockchainHealthStatus: () => Promise<MainApiBlockchainHealth>;
}

export function mapMainApiBlockchainDependency(
  blockchainHealth: MainApiBlockchainHealth
) {
  const sourceStatus =
    typeof blockchainHealth?.status === 'string'
      ? blockchainHealth.status
      : 'unknown';

  return {
    status: sourceStatus === 'healthy' ? 'up' : 'down',
    sourceStatus,
    services: blockchainHealth?.services ?? {},
  };
}

export function createMainApiOperationalProbes(
  options: MainApiOperationalProbeOptions
) {
  const { state, getBlockchainHealthStatus } = options;

  return createHealthMiddleware(
    'main-api-server',
    {
      blockchain: {
        critical: true,
        check: async () =>
          mapMainApiBlockchainDependency(await getBlockchainHealthStatus()),
      },
    },
    { state }
  );
}
