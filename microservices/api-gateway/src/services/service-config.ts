export interface ServiceConfig {
  name: string;
  url: string;
  healthPath: string;
  timeout: number;
}

export const testnetMvpScopeEnabled = process.env.TESTNET_MVP_SCOPE === 'true';
const mainServiceUrl = process.env.MAIN_SERVICE_URL || 'http://localhost:4001';
const nftServiceUrl =
  process.env.NFT_SERVICE_URL ||
  (testnetMvpScopeEnabled ? mainServiceUrl : 'http://localhost:4002');
const userServiceUrl =
  process.env.USER_SERVICE_URL ||
  (testnetMvpScopeEnabled ? mainServiceUrl : 'http://localhost:4003');

export const serviceConfig: Record<string, ServiceConfig> = {
  nftService: {
    name: 'nft-marketplace-service',
    url: nftServiceUrl,
    healthPath: '/health',
    timeout: 5000,
  },
  userService: {
    name: 'user-management-service',
    url: userServiceUrl,
    healthPath: '/health',
    timeout: 5000,
  },
  // Legacy main API server for endpoints not yet migrated
  mainService: {
    name: 'main-api-server',
    url: mainServiceUrl,
    healthPath: '/health',
    timeout: 5000,
  },
};
