/**
 * GraphQL Server Integration Tests
 * Comprehensive tests for the Wrfcoin GraphQL API
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
const request = require('supertest');
import { Application } from 'express';
import { createGraphQLServer } from '../server.js';

// Test server instance
let app: Application;
let server: any;

// Test data
const mockWeatherData = {
  stationId: 'test-station-1',
  temperature: 25.5,
  humidity: 65.0,
  pressure: 1013.25,
  windSpeed: 5.2,
  rainfall: 0.0,
  confidence: 95.0,
  signature: '0x' + '0'.repeat(130), // Mock signature
};

const mockUser = {
  address: '0x1234567890123456789012345678901234567890',
  privateKey: '0x' + '1'.repeat(64),
  token: 'mock.jwt.token',
};

// Setup and teardown
beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://localhost:5432/wrfcoin_test';
  process.env.JWT_SECRET = 'test-secret';

  // Create test server
  const result = await createGraphQLServer();
  app = result.app;
  server = result.server;
}, 30000);

afterAll(async () => {
  if (server) {
    await server.close();
  }
}, 10000);

beforeEach(async () => {
  // Clean test database before each test
  // In a real implementation, you'd use test fixtures or factories
});

describe('GraphQL Server', () => {
  describe('Health and Schema', () => {
    it('should respond to health check', async () => {
      const response = await request(app).get('/health').expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('service', 'wrfcoin-graphql');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should serve GraphQL schema introspection', async () => {
      const introspectionQuery = `
        query IntrospectionQuery {
          __schema {
            queryType {
              name
            }
            mutationType {
              name
            }
            subscriptionType {
              name
            }
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: introspectionQuery })
        .expect(200);

      expect(response.body.data.__schema).toBeDefined();
      expect(response.body.data.__schema.queryType.name).toBe('Query');
      expect(response.body.data.__schema.mutationType.name).toBe('Mutation');
      expect(response.body.data.__schema.subscriptionType.name).toBe(
        'Subscription'
      );
    });
  });

  describe('WRF Token Queries', () => {
    it('should fetch WRF token information', async () => {
      const query = `
        query GetWRFToken {
          wrfToken {
            id
            address
            symbol
            name
            decimals
            totalSupply
            maxSupply
            paused
            weatherRewardRate
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query })
        .expect(200);

      expect(response.body.data.wrfToken).toBeDefined();
      expect(response.body.data.wrfToken.symbol).toBe('WRF');
      expect(response.body.data.wrfToken.name).toBe('Wrfcoin');
      expect(response.body.data.wrfToken.decimals).toBe(18);
    });

    it('should fetch weather stations', async () => {
      const query = `
        query GetWRFTokenWithStations {
          wrfToken {
            weatherStations {
              id
              stationId
              location
              isActive
              qualityScore
            }
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query })
        .expect(200);

      expect(response.body.data.wrfToken.weatherStations).toBeDefined();
      expect(Array.isArray(response.body.data.wrfToken.weatherStations)).toBe(
        true
      );
    });
  });

  describe('Weather Data', () => {
    it('should fetch weather stations with pagination', async () => {
      const query = `
        query GetWeatherStations($first: Int, $skip: Int) {
          weatherStations(first: $first, skip: $skip) {
            id
            stationId
            location
            isActive
            lastRewardTime
            totalRewards
            qualityScore
          }
        }
      `;

      const variables = { first: 5, skip: 0 };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.weatherStations).toBeDefined();
      expect(Array.isArray(response.body.data.weatherStations)).toBe(true);
      expect(response.body.data.weatherStations.length).toBeLessThanOrEqual(5);
    });

    it('should fetch weather data for a station', async () => {
      const query = `
        query GetWeatherData($stationId: String!, $from: DateTime, $to: DateTime) {
          weatherData(stationId: $stationId, from: $from, to: $to) {
            id
            stationId
            timestamp
            temperature
            humidity
            pressure
            windSpeed
            rainfall
            confidence
          }
        }
      `;

      const variables = {
        stationId: 'test-station-1',
        from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
      };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.weatherData).toBeDefined();
      expect(Array.isArray(response.body.data.weatherData)).toBe(true);
    });
  });

  describe('Mutations', () => {
    it('should submit weather data with authentication', async () => {
      const mutation = `
        mutation SubmitWeatherData($input: WeatherDataInput!) {
          submitWeatherData(input: $input) {
            success
            weatherData {
              id
              stationId
              temperature
              humidity
            }
            rewards
            error
          }
        }
      `;

      const variables = { input: mockWeatherData };

      const response = await request(app)
        .post('/graphql')
        .set('Authorization', `Bearer ${mockUser.token}`)
        .send({ query: mutation, variables })
        .expect(200);

      expect(response.body.data.submitWeatherData).toBeDefined();
      expect(response.body.data.submitWeatherData.success).toBe(true);
    });

    it('should reject weather data without authentication', async () => {
      const mutation = `
        mutation SubmitWeatherData($input: WeatherDataInput!) {
          submitWeatherData(input: $input) {
            success
            error
          }
        }
      `;

      const variables = { input: mockWeatherData };

      const response = await request(app)
        .post('/graphql')
        .send({ query: mutation, variables })
        .expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].extensions.code).toBe(
        'AUTHENTICATION_ERROR'
      );
    });

    it('should validate weather data inputs', async () => {
      const mutation = `
        mutation SubmitWeatherData($input: WeatherDataInput!) {
          submitWeatherData(input: $input) {
            success
            error
          }
        }
      `;

      const invalidData = {
        ...mockWeatherData,
        temperature: 150, // Invalid temperature
      };

      const variables = { input: invalidData };

      const response = await request(app)
        .post('/graphql')
        .set('Authorization', `Bearer ${mockUser.token}`)
        .send({ query: mutation, variables })
        .expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].extensions.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Carbon Credits', () => {
    it('should fetch carbon credits with filters', async () => {
      const query = `
        query GetCarbonCredits($where: CarbonCreditFilter) {
          carbonCredits(where: $where) {
            id
            tokenId
            carbonOffset
            projectType
            verificationStandard
            isRetired
            forSale
            price
            owner
          }
        }
      `;

      const variables = {
        where: {
          projectType: 'Renewable Energy',
          isRetired: false,
          forSale: true,
        },
      };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.carbonCredits).toBeDefined();
      expect(Array.isArray(response.body.data.carbonCredits)).toBe(true);
    });
  });

  describe('Governance', () => {
    it('should fetch governance proposals', async () => {
      const query = `
        query GetProposals($where: ProposalFilter) {
          proposals(where: $where) {
            id
            proposalId
            title
            description
            proposer
            state
            votingType
            forVotes
            againstVotes
            abstainVotes
            createdAt
          }
        }
      `;

      const variables = {
        where: {
          state: 'ACTIVE',
        },
      };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.proposals).toBeDefined();
      expect(Array.isArray(response.body.data.proposals)).toBe(true);
    });

    it('should cast a vote with authentication', async () => {
      const mutation = `
        mutation CastVote($input: VoteInput!) {
          castVote(input: $input) {
            success
            vote {
              id
              proposalId
              voter
              support
              weight
            }
            transactionHash
            error
          }
        }
      `;

      const variables = {
        input: {
          proposalId: '1',
          support: 'FOR',
          reason: 'This proposal will benefit the network',
          signature: mockWeatherData.signature,
        },
      };

      const response = await request(app)
        .post('/graphql')
        .set('Authorization', `Bearer ${mockUser.token}`)
        .send({ query: mutation, variables })
        .expect(200);

      expect(response.body.data.castVote).toBeDefined();
      expect(response.body.data.castVote.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid GraphQL syntax', async () => {
      const invalidQuery = `
        query {
          wrfToken {
            id
            invalidField
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: invalidQuery })
        .expect(400);

      expect(response.body.errors).toBeDefined();
    });

    it('should handle query depth limits', async () => {
      const deepQuery = `
        query {
          wrfToken {
            weatherStations {
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
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query: deepQuery })
        .expect(200);

      expect(response.body.errors).toBeDefined();
      expect(response.body.errors[0].message).toContain('too complex');
    });

    it('should handle rate limiting', async () => {
      const query = `
        query {
          wrfToken {
            id
          }
        }
      `;

      // Make many requests quickly
      const requests = Array(150)
        .fill(null)
        .map(() => request(app).post('/graphql').send({ query }));

      const responses = await Promise.all(requests);

      // Some requests should be rate limited
      const rateLimited = responses.some(
        res =>
          res.body.errors &&
          res.body.errors[0].extensions.code === 'RATE_LIMIT_ERROR'
      );

      expect(rateLimited).toBe(true);
    });
  });

  describe('Search Functionality', () => {
    it('should search across different entity types', async () => {
      const query = `
        query Search($query: String!, $type: SearchType) {
          search(query: $query, type: $type) {
            ... on User {
              id
              address
              wrfBalance
            }
            ... on CarbonCredit {
              id
              tokenId
              carbonOffset
            }
            ... on GovernanceProposal {
              id
              title
              description
            }
          }
        }
      `;

      const variables = {
        query: 'renewable',
        type: 'ALL',
      };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.search).toBeDefined();
      expect(Array.isArray(response.body.data.search)).toBe(true);
    });
  });

  describe('Market Data', () => {
    it('should fetch current market data', async () => {
      const query = `
        query GetMarketData {
          marketData {
            id
            timestamp
            wrfPrice
            wrfMarketCap
            wrfVolume24h
            carbonCreditVolume24h
            averageCarbonPrice
            totalUsers
            activeWeatherStations
            totalValueLocked
          }
        }
      `;

      const response = await request(app)
        .post('/graphql')
        .send({ query })
        .expect(200);

      expect(response.body.data.marketData).toBeDefined();
      expect(response.body.data.marketData.timestamp).toBeDefined();
    });

    it('should fetch market data history', async () => {
      const query = `
        query GetMarketDataHistory($from: DateTime!, $to: DateTime!, $interval: String) {
          marketDataHistory(from: $from, to: $to, interval: $interval) {
            id
            timestamp
            wrfPrice
            wrfVolume24h
          }
        }
      `;

      const variables = {
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
        interval: '1h',
      };

      const response = await request(app)
        .post('/graphql')
        .send({ query, variables })
        .expect(200);

      expect(response.body.data.marketDataHistory).toBeDefined();
      expect(Array.isArray(response.body.data.marketDataHistory)).toBe(true);
    });
  });
});
