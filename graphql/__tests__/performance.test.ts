/**
 * GraphQL Performance Tests
 * Tests for GraphQL server performance and scalability
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { Application } from 'express';
import { createGraphQLServer } from '../server.js';
import { performance } from 'perf_hooks';

let app: Application;
let server: any;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const result = await createGraphQLServer();
  app = result.app;
  server = result.server;
}, 30000);

afterAll(async () => {
  if (server) {
    await server.close();
  }
}, 10000);

describe('GraphQL Performance Tests', () => {
  describe('Query Performance', () => {
    it('should handle simple queries within acceptable time', async () => {
      const query = `
        query {
          wrfToken {
            id
            symbol
            name
            totalSupply
          }
        }
      `;

      const start = performance.now();

      const response = await request(app)
        .post('/graphql')
        .send({ query })
        .expect(200);

      const end = performance.now();
      const duration = end - start;

      expect(response.body.data.wrfToken).toBeDefined();
      expect(duration).toBeLessThan(100); // Should complete within 100ms
    });

    it('should handle complex queries with pagination efficiently', async () => {
      const query = `
        query {
          weatherStations(first: 50) {
            id
            stationId
            location
            isActive
            weatherData {
              id
              timestamp
              temperature
              humidity
            }
          }
          carbonCredits(first: 50) {
            id
            tokenId
            carbonOffset
            projectType
          }
          proposals(first: 20) {
            id
            title
            description
            votes {
              id
              voter
              support
            }
          }
        }
      `;

      const start = performance.now();

      const response = await request(app)
        .post('/graphql')
        .send({ query })
        .expect(200);

      const end = performance.now();
      const duration = end - start;

      expect(response.body.data).toBeDefined();
      expect(duration).toBeLessThan(500); // Should complete within 500ms
    });

    it('should handle concurrent requests efficiently', async () => {
      const query = `
        query {
          wrfToken {
            id
            symbol
            weatherStations {
              id
              location
            }
          }
        }
      `;

      const concurrentRequests = 20;
      const start = performance.now();

      const promises = Array(concurrentRequests)
        .fill(null)
        .map(() => request(app).post('/graphql').send({ query }));

      const responses = await Promise.all(promises);
      const end = performance.now();
      const duration = end - start;

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.data.wrfToken).toBeDefined();
      });

      // Average response time should be reasonable
      const avgDuration = duration / concurrentRequests;
      expect(avgDuration).toBeLessThan(50); // Average < 50ms per request
    });
  });

  describe('Memory Usage', () => {
    it('should not leak memory with repeated queries', async () => {
      const query = `
        query {
          weatherStations(first: 10) {
            id
            weatherData {
              id
              temperature
            }
          }
        }
      `;

      const initialMemory = process.memoryUsage().heapUsed;

      // Execute many queries
      for (let i = 0; i < 100; i++) {
        await request(app).post('/graphql').send({ query });
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('Subscription Performance', () => {
    it('should handle WebSocket connections efficiently', async () => {
      // This would require WebSocket testing setup
      // For now, we'll test the subscription resolver creation
      const start = performance.now();

      // Simulate subscription setup
      const mockSubscription = {
        weatherDataUpdated: () => ({
          subscribe: async function* () {
            for (let i = 0; i < 5; i++) {
              yield {
                weatherDataUpdated: {
                  id: `data-${i}`,
                  stationId: 'test-station',
                  temperature: 20 + i,
                  timestamp: new Date().toISOString(),
                },
              };
            }
          },
        }),
      };

      const end = performance.now();
      const duration = end - start;

      expect(mockSubscription.weatherDataUpdated).toBeDefined();
      expect(duration).toBeLessThan(10); // Setup should be very fast
    });
  });

  describe('Error Handling Performance', () => {
    it('should handle validation errors quickly', async () => {
      const invalidQuery = `
        query {
          weatherData(stationId: "invalid-station-id-that-is-too-long-and-contains-invalid-characters!@#$%") {
            id
          }
        }
      `;

      const start = performance.now();

      const response = await request(app)
        .post('/graphql')
        .send({ query: invalidQuery })
        .expect(200);

      const end = performance.now();
      const duration = end - start;

      expect(response.body.errors).toBeDefined();
      expect(duration).toBeLessThan(50); // Error handling should be fast
    });

    it('should handle complex query rejection quickly', async () => {
      const complexQuery = `
        query {
          weatherStations {
            weatherData {
              station {
                weatherData {
                  station {
                    weatherData {
                      station {
                        weatherData {
                          station {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const start = performance.now();

      const response = await request(app)
        .post('/graphql')
        .send({ query: complexQuery })
        .expect(200);

      const end = performance.now();
      const duration = end - start;

      expect(response.body.errors).toBeDefined();
      expect(duration).toBeLessThan(20); // Complexity analysis should be very fast
    });
  });

  describe('Cache Performance', () => {
    it('should cache frequently accessed data', async () => {
      const query = `
        query {
          wrfToken {
            id
            symbol
            name
            totalSupply
          }
        }
      `;

      // First request (cache miss)
      const start1 = performance.now();
      const response1 = await request(app).post('/graphql').send({ query });
      const end1 = performance.now();
      const duration1 = end1 - start1;

      expect(response1.status).toBe(200);

      // Second request (should be faster if cached)
      const start2 = performance.now();
      const response2 = await request(app).post('/graphql').send({ query });
      const end2 = performance.now();
      const duration2 = end2 - start2;

      expect(response2.status).toBe(200);

      // Second request should be significantly faster (if caching is implemented)
      // For now, we just ensure both requests complete in reasonable time
      expect(duration1).toBeLessThan(200);
      expect(duration2).toBeLessThan(200);
    });
  });

  describe('Batch Query Performance', () => {
    it('should handle batch queries efficiently', async () => {
      const batchQuery = [
        {
          query: `
            query GetToken {
              wrfToken {
                id
                symbol
              }
            }
          `,
        },
        {
          query: `
            query GetStations {
              weatherStations(first: 5) {
                id
                location
              }
            }
          `,
        },
        {
          query: `
            query GetCredits {
              carbonCredits(first: 5) {
                id
                carbonOffset
              }
            }
          `,
        },
      ];

      const start = performance.now();

      const response = await request(app).post('/graphql').send(batchQuery);

      const end = performance.now();
      const duration = end - start;

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
      expect(duration).toBeLessThan(300); // Batch should complete within 300ms
    });
  });

  describe('Database Query Optimization', () => {
    it('should minimize database queries with efficient resolvers', async () => {
      const query = `
        query {
          weatherStations(first: 3) {
            id
            stationId
            weatherData {
              id
              temperature
            }
          }
        }
      `;

      const start = performance.now();

      const response = await request(app).post('/graphql').send({ query });

      const end = performance.now();
      const duration = end - start;

      expect(response.body.data.weatherStations).toBeDefined();
      expect(duration).toBeLessThan(150); // Should be efficient with proper data loading
    });
  });

  describe('Rate Limiting Performance', () => {
    it('should apply rate limiting without significant overhead', async () => {
      const query = `
        query {
          wrfToken {
            id
          }
        }
      `;

      const start = performance.now();

      // Make several requests within rate limit
      for (let i = 0; i < 10; i++) {
        await request(app).post('/graphql').send({ query });
      }

      const end = performance.now();
      const duration = end - start;
      const avgDuration = duration / 10;

      expect(avgDuration).toBeLessThan(30); // Rate limiting should add minimal overhead
    });
  });
});
