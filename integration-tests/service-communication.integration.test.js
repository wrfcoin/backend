/**
 * Service Communication Integration Tests
 * Tests for Task 67: Inter-service communication validation
 *
 * Focus Areas:
 * - Service registry functionality
 * - Circuit breaker patterns
 * - Service discovery
 * - Health monitoring
 * - Error propagation
 */

const request = require('supertest');
const express = require('express');
const { performance } = require('perf_hooks');

describe('Service Communication Integration', () => {
  const SERVICE_ENDPOINTS = {
    mainApi: 'http://localhost:4001',
    crossChain: 'http://localhost:3000',
    wallet: 'http://localhost:4000',
    compute: 'http://localhost:6000',
    aiml: 'http://localhost:6001',
    storage: 'http://localhost:7000',
    iot: 'http://localhost:3002',
    governance: 'http://localhost:8000',
    weatherEarnings: 'http://localhost:8080',
    nodeDiscovery: 'http://localhost:9001',
  };

  const mockServices = [];

  beforeAll(() => {
    console.log('Setting up service communication tests...');
  });

  afterAll(async () => {
    // Cleanup mock services
    for (const server of mockServices) {
      if (server && server.close) {
        server.close();
      }
    }
    console.log('Service communication tests cleanup completed');
  });

  describe('Service Registry Integration', () => {
    test('should register and discover services', async () => {
      const {
        ServiceRegistry,
      } = require('../graphql/services/service-registry');

      const registry = new ServiceRegistry();

      // Test service registration
      const testService = {
        name: 'test-service',
        host: 'localhost',
        port: 9998,
        health: '/health',
        timeout: 5000,
      };

      await registry.registerService(testService.name, testService);

      // Verify service is registered
      const services = registry.getRegisteredServices();
      expect(services).toHaveProperty(testService.name);
      expect(services[testService.name].host).toBe(testService.host);
    });

    test('should handle service deregistration', async () => {
      const {
        ServiceRegistry,
      } = require('../graphql/services/service-registry');

      const registry = new ServiceRegistry();

      const serviceName = 'temp-service';
      await registry.registerService(serviceName, {
        host: 'localhost',
        port: 9997,
        health: '/health',
      });

      // Verify registration
      expect(registry.getRegisteredServices()).toHaveProperty(serviceName);

      // Deregister
      await registry.deregisterService(serviceName);

      // Verify deregistration
      expect(registry.getRegisteredServices()).not.toHaveProperty(serviceName);
    });

    test('should perform health checks on registered services', async () => {
      const {
        ServiceRegistry,
      } = require('../graphql/services/service-registry');

      // Create a mock healthy service
      const healthyService = express();
      healthyService.get('/health', (req, res) => {
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
      });
      const server = healthyService.listen(9996);
      mockServices.push(server);

      const registry = new ServiceRegistry();
      await registry.registerService('healthy-service', {
        host: 'localhost',
        port: 9996,
        health: '/health',
        timeout: 2000,
      });

      // Perform health check
      const health = await registry.checkServiceHealth('healthy-service');
      expect(health).toBe(true);
    });

    test('should detect unhealthy services', async () => {
      const {
        ServiceRegistry,
      } = require('../graphql/services/service-registry');

      const registry = new ServiceRegistry();
      await registry.registerService('unhealthy-service', {
        host: 'localhost',
        port: 9995, // Non-existent port
        health: '/health',
        timeout: 1000,
      });

      const health = await registry.checkServiceHealth('unhealthy-service');
      expect(health).toBe(false);
    });
  });

  describe('Circuit Breaker Pattern', () => {
    test('should implement circuit breaker for service failures', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      const client = new ServiceClient({
        host: 'localhost',
        port: 9994, // Non-existent service
        timeout: 1000,
        retries: 2,
        circuitBreaker: {
          threshold: 3,
          timeout: 5000,
          resetTimeout: 10000,
        },
      });

      // Trigger circuit breaker by making failed requests
      const failures = [];
      for (let i = 0; i < 5; i++) {
        try {
          await client.get('/test');
        } catch (error) {
          failures.push(error);
        }
      }

      expect(failures.length).toBe(5);

      const status = client.getCircuitBreakerStatus();
      expect(status.state).toBe('OPEN');
      expect(status.failures).toBeGreaterThanOrEqual(3);
    });

    test('should transition to half-open state after timeout', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      // Create a service that will become available
      let isServiceUp = false;
      const toggleService = express();
      toggleService.get('/test', (req, res) => {
        if (isServiceUp) {
          res.json({ status: 'ok' });
        } else {
          res.status(500).json({ error: 'service down' });
        }
      });
      const server = toggleService.listen(9993);
      mockServices.push(server);

      const client = new ServiceClient({
        host: 'localhost',
        port: 9993,
        timeout: 1000,
        retries: 1,
        circuitBreaker: {
          threshold: 2,
          timeout: 1000, // Short timeout for test
        },
      });

      // Break the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await client.get('/test');
        } catch (e) {
          // Expected
        }
      }

      expect(client.getCircuitBreakerStatus().state).toBe('OPEN');

      // Wait for circuit breaker timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Enable service
      isServiceUp = true;

      // Should transition to half-open and potentially close
      const response = await client.get('/test');
      expect(response.status).toBe('ok');
    }, 10000);

    test('should fail fast when circuit is open', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      const client = new ServiceClient({
        host: 'localhost',
        port: 9992, // Non-existent
        timeout: 1000,
        retries: 1,
        circuitBreaker: {
          threshold: 2,
          timeout: 30000, // Long timeout
        },
      });

      // Break the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await client.get('/test');
        } catch (e) {
          // Expected
        }
      }

      // Circuit should be open
      expect(client.getCircuitBreakerStatus().state).toBe('OPEN');

      // Requests should fail fast
      const start = performance.now();
      try {
        await client.get('/test');
      } catch (error) {
        const duration = performance.now() - start;
        expect(duration).toBeLessThan(100); // Should fail immediately
        expect(error.message).toContain('Circuit breaker is OPEN');
      }
    });
  });

  describe('Service Discovery', () => {
    test('should discover services via health check endpoints', async () => {
      const {
        ServiceDiscovery,
      } = require('../graphql/services/service-discovery');

      // Create mock services
      const service1 = express();
      service1.get('/health', (req, res) => {
        res.json({
          service: 'test-service-1',
          status: 'healthy',
          capabilities: ['weather', 'api'],
        });
      });
      const server1 = service1.listen(9991);
      mockServices.push(server1);

      const service2 = express();
      service2.get('/health', (req, res) => {
        res.json({
          service: 'test-service-2',
          status: 'healthy',
          capabilities: ['storage', 'backup'],
        });
      });
      const server2 = service2.listen(9990);
      mockServices.push(server2);

      const discovery = new ServiceDiscovery();

      // Configure discovery to check our mock services
      discovery.addDiscoveryTarget('localhost', [9991, 9990]);

      const discoveredServices = await discovery.discoverServices();

      expect(discoveredServices.length).toBe(2);
      expect(discoveredServices.some(s => s.service === 'test-service-1')).toBe(
        true
      );
      expect(discoveredServices.some(s => s.service === 'test-service-2')).toBe(
        true
      );
    });

    test('should handle service discovery timeouts', async () => {
      const {
        ServiceDiscovery,
      } = require('../graphql/services/service-discovery');

      const discovery = new ServiceDiscovery({
        timeout: 1000,
        concurrency: 5,
      });

      // Try to discover non-existent services
      discovery.addDiscoveryTarget('localhost', [9989, 9988, 9987]);

      const start = performance.now();
      const services = await discovery.discoverServices();
      const duration = performance.now() - start;

      expect(services).toEqual([]);
      expect(duration).toBeLessThan(2000); // Should timeout quickly
    });

    test('should filter services by capabilities', async () => {
      const {
        ServiceDiscovery,
      } = require('../graphql/services/service-discovery');

      // Create services with different capabilities
      const weatherService = express();
      weatherService.get('/health', (req, res) => {
        res.json({
          service: 'weather-service',
          capabilities: ['weather', 'iot'],
        });
      });
      const server1 = weatherService.listen(9986);
      mockServices.push(server1);

      const storageService = express();
      storageService.get('/health', (req, res) => {
        res.json({
          service: 'storage-service',
          capabilities: ['storage', 'ipfs'],
        });
      });
      const server2 = storageService.listen(9985);
      mockServices.push(server2);

      const discovery = new ServiceDiscovery();
      discovery.addDiscoveryTarget('localhost', [9986, 9985]);

      // Discover weather services only
      const weatherServices =
        await discovery.discoverServicesByCapability('weather');

      expect(weatherServices.length).toBe(1);
      expect(weatherServices[0].service).toBe('weather-service');
    });
  });

  describe('Health Monitoring', () => {
    test('should continuously monitor service health', async () => {
      const { HealthMonitor } = require('../graphql/services/health-monitor');

      // Create a service that toggles health
      let isHealthy = true;
      const monitoredService = express();
      monitoredService.get('/health', (req, res) => {
        if (isHealthy) {
          res.json({ status: 'healthy' });
        } else {
          res.status(503).json({ status: 'unhealthy' });
        }
      });
      const server = monitoredService.listen(9984);
      mockServices.push(server);

      const monitor = new HealthMonitor({
        checkInterval: 500, // Check every 500ms
        timeout: 1000,
      });

      const healthChanges = [];
      monitor.on('healthChange', (serviceName, isHealthy, previousHealth) => {
        healthChanges.push({ serviceName, isHealthy, previousHealth });
      });

      // Add service to monitoring
      monitor.addService('toggle-service', {
        host: 'localhost',
        port: 9984,
        path: '/health',
      });

      // Start monitoring
      monitor.start();

      // Wait for initial health check
      await new Promise(resolve => setTimeout(resolve, 600));

      // Toggle service health
      isHealthy = false;
      await new Promise(resolve => setTimeout(resolve, 600));

      // Toggle back
      isHealthy = true;
      await new Promise(resolve => setTimeout(resolve, 600));

      monitor.stop();

      // Should have detected health changes
      expect(healthChanges.length).toBeGreaterThan(0);

      const healthyToUnhealthy = healthChanges.find(
        change => change.previousHealth === true && change.isHealthy === false
      );
      expect(healthyToUnhealthy).toBeDefined();
    }, 10000);

    test('should aggregate health metrics', async () => {
      const { HealthMonitor } = require('../graphql/services/health-monitor');

      // Create multiple services with different health patterns
      const alwaysHealthy = express();
      alwaysHealthy.get('/health', (req, res) => {
        res.json({ status: 'healthy' });
      });
      const server1 = alwaysHealthy.listen(9983);
      mockServices.push(server1);

      const alwaysUnhealthy = express();
      alwaysUnhealthy.get('/health', (req, res) => {
        res.status(503).json({ status: 'unhealthy' });
      });
      const server2 = alwaysUnhealthy.listen(9982);
      mockServices.push(server2);

      const monitor = new HealthMonitor({
        checkInterval: 300,
        timeout: 1000,
      });

      monitor.addService('healthy-service', {
        host: 'localhost',
        port: 9983,
        path: '/health',
      });

      monitor.addService('unhealthy-service', {
        host: 'localhost',
        port: 9982,
        path: '/health',
      });

      monitor.start();

      // Let it run for a bit
      await new Promise(resolve => setTimeout(resolve, 1000));

      const metrics = monitor.getAggregatedMetrics();
      monitor.stop();

      expect(metrics).toHaveProperty('totalServices');
      expect(metrics).toHaveProperty('healthyServices');
      expect(metrics).toHaveProperty('unhealthyServices');
      expect(metrics).toHaveProperty('healthPercentage');

      expect(metrics.totalServices).toBe(2);
      expect(metrics.healthyServices).toBe(1);
      expect(metrics.unhealthyServices).toBe(1);
      expect(metrics.healthPercentage).toBe(50);
    }, 5000);
  });

  describe('Error Propagation', () => {
    test('should propagate service errors with context', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      // Create service that returns errors with context
      const errorService = express();
      errorService.get('/error', (req, res) => {
        res.status(500).json({
          error: 'Service internal error',
          code: 'INTERNAL_ERROR',
          service: 'test-error-service',
          timestamp: new Date().toISOString(),
          requestId: req.headers['x-request-id'] || 'unknown',
        });
      });
      const server = errorService.listen(9981);
      mockServices.push(server);

      const client = new ServiceClient({
        host: 'localhost',
        port: 9981,
        timeout: 2000,
        retries: 1,
      });

      try {
        await client.get(
          '/error',
          {},
          {
            'X-Request-ID': 'test-request-123',
          }
        );
      } catch (error) {
        expect(error.message).toContain('Service internal error');
        expect(error.response?.data?.code).toBe('INTERNAL_ERROR');
        expect(error.response?.data?.service).toBe('test-error-service');
        expect(error.response?.data?.requestId).toBe('test-request-123');
      }
    });

    test('should handle network timeouts gracefully', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      // Create slow service
      const slowService = express();
      slowService.get('/slow', (req, res) => {
        setTimeout(() => {
          res.json({ message: 'slow response' });
        }, 3000); // 3 second delay
      });
      const server = slowService.listen(9980);
      mockServices.push(server);

      const client = new ServiceClient({
        host: 'localhost',
        port: 9980,
        timeout: 1000, // 1 second timeout
        retries: 1,
      });

      const start = performance.now();

      try {
        await client.get('/slow');
      } catch (error) {
        const duration = performance.now() - start;

        expect(error.message).toMatch(/timeout|ECONNABORTED/i);
        expect(duration).toBeLessThan(2000); // Should timeout before 2 seconds
        expect(duration).toBeGreaterThan(900); // But close to 1 second timeout
      }
    });

    test('should retry failed requests with exponential backoff', async () => {
      const { ServiceClient } = require('../graphql/services/service-client');

      let requestCount = 0;
      const flakyService = express();
      flakyService.get('/flaky', (req, res) => {
        requestCount++;
        if (requestCount < 3) {
          res.status(500).json({ error: 'temporary failure' });
        } else {
          res.json({ message: 'success', attempts: requestCount });
        }
      });
      const server = flakyService.listen(9979);
      mockServices.push(server);

      const client = new ServiceClient({
        host: 'localhost',
        port: 9979,
        timeout: 2000,
        retries: 3,
        retryDelay: 100, // Start with 100ms delay
      });

      const start = performance.now();
      const response = await client.get('/flaky');
      const duration = performance.now() - start;

      expect(response.message).toBe('success');
      expect(response.attempts).toBe(3);
      expect(requestCount).toBe(3);

      // Should have some delay due to retries
      expect(duration).toBeGreaterThan(200); // At least 100ms + 200ms delays
    });
  });

  describe('Load Balancing and Failover', () => {
    test('should distribute requests across multiple service instances', async () => {
      const { LoadBalancer } = require('../graphql/services/load-balancer');

      // Create multiple instances of the same service
      const instances = [];
      for (let i = 0; i < 3; i++) {
        const instance = express();
        instance.get('/api/data', (req, res) => {
          res.json({ instance: i, data: 'response' });
        });
        const server = instance.listen(9978 - i);
        instances.push(server);
        mockServices.push(server);
      }

      const loadBalancer = new LoadBalancer({
        strategy: 'round-robin',
        healthCheck: true,
      });

      // Add service instances
      for (let i = 0; i < 3; i++) {
        loadBalancer.addInstance(`instance-${i}`, {
          host: 'localhost',
          port: 9978 - i,
          weight: 1,
        });
      }

      // Make multiple requests
      const requests = [];
      for (let i = 0; i < 9; i++) {
        requests.push(loadBalancer.request('GET', '/api/data'));
      }

      const responses = await Promise.all(requests);

      // Should distribute across all instances
      const instanceCounts = {};
      responses.forEach(response => {
        const instance = response.data.instance;
        instanceCounts[instance] = (instanceCounts[instance] || 0) + 1;
      });

      // Each instance should receive roughly equal requests
      Object.values(instanceCounts).forEach(count => {
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(4);
      });
    });

    test('should failover to healthy instances', async () => {
      const { LoadBalancer } = require('../graphql/services/load-balancer');

      // Create healthy and unhealthy instances
      const healthyInstance = express();
      healthyInstance.get('/api/data', (req, res) => {
        res.json({ instance: 'healthy', data: 'response' });
      });
      healthyInstance.get('/health', (req, res) => {
        res.json({ status: 'healthy' });
      });
      const server1 = healthyInstance.listen(9975);
      mockServices.push(server1);

      const unhealthyInstance = express();
      unhealthyInstance.get('/api/data', (req, res) => {
        res.status(500).json({ error: 'service down' });
      });
      unhealthyInstance.get('/health', (req, res) => {
        res.status(503).json({ status: 'unhealthy' });
      });
      const server2 = unhealthyInstance.listen(9974);
      mockServices.push(server2);

      const loadBalancer = new LoadBalancer({
        strategy: 'failover',
        healthCheck: true,
        healthCheckInterval: 500,
      });

      loadBalancer.addInstance('healthy', {
        host: 'localhost',
        port: 9975,
        priority: 1,
      });

      loadBalancer.addInstance('unhealthy', {
        host: 'localhost',
        port: 9974,
        priority: 2,
      });

      // Wait for health checks
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Make requests - should only go to healthy instance
      const requests = [];
      for (let i = 0; i < 5; i++) {
        requests.push(loadBalancer.request('GET', '/api/data'));
      }

      const responses = await Promise.all(requests);

      // All responses should come from healthy instance
      responses.forEach(response => {
        expect(response.data.instance).toBe('healthy');
      });
    });
  });
});
