import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { ServiceDiscovery } from '../../../microservices/api-gateway/src/services/service-discovery.js';

// Mock axios
jest.mock('axios');

describe('ServiceDiscovery', () => {
  let serviceDiscovery: ServiceDiscovery;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (serviceDiscovery) {
      serviceDiscovery.stop();
    }
  });

  describe('constructor', () => {
    it('should initialize service discovery', () => {
      serviceDiscovery = new ServiceDiscovery();
      expect(serviceDiscovery).toBeInstanceOf(ServiceDiscovery);
    });
  });

  describe('isServiceHealthy', () => {
    it('should return false for unknown service', () => {
      serviceDiscovery = new ServiceDiscovery();
      expect(serviceDiscovery.isServiceHealthy('unknown')).toBe(false);
    });
  });

  describe('getServiceUrl', () => {
    it('should return null for unhealthy service', () => {
      serviceDiscovery = new ServiceDiscovery();
      expect(serviceDiscovery.getServiceUrl('unknown')).toBe(null);
    });
  });

  describe('getHealthStatus', () => {
    it('should return health status for all services', () => {
      serviceDiscovery = new ServiceDiscovery();
      const status = serviceDiscovery.getHealthStatus();

      expect(status).toHaveProperty('nftService');
      expect(status).toHaveProperty('userService');
      expect(status).toHaveProperty('mainService');

      expect(status.nftService).toHaveProperty('name');
      expect(status.nftService).toHaveProperty('url');
      expect(status.nftService).toHaveProperty('healthy');
    });
  });
});
