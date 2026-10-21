/**
 * GraphQL Resolvers Index
 * Combines all resolver modules for the Wrfcoin GraphQL API
 */

import { GraphQLScalarType, Kind } from 'graphql';
import { DateTimeTypeDefinition } from 'graphql-scalars';
import { mergeResolvers } from '@graphql-tools/merge';

// Import resolver modules - all Task 57 resolvers now activated
import { tokenResolvers } from './token-resolvers.js';
import { weatherResolvers } from './weather-resolvers.js';
import { carbonCreditResolvers } from './carbon-credit-resolvers.js';
import { computationalNftResolvers } from './computational-nft-resolvers.js';
import { governanceResolvers } from './governance-resolvers.js';
import { ammResolvers } from './amm-resolvers.js';
import { userResolvers } from './user-resolvers.js';
import { analyticsResolvers } from './analytics-resolvers.js';
import { subscriptionResolvers } from './subscription-resolvers.js';

// Custom scalar type definitions
const scalarResolvers = {
  // DateTime scalar
  DateTime: new GraphQLScalarType({
    name: 'DateTime',
    description: 'A date-time string at UTC, such as 2007-12-03T10:15:30Z',
    serialize: (value: any) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (typeof value === 'string' || typeof value === 'number') {
        return new Date(value).toISOString();
      }
      throw new Error('Value must be a Date, string, or number');
    },
    parseValue: (value: any) => {
      if (typeof value === 'string') {
        return new Date(value);
      }
      throw new Error('DateTime must be a string');
    },
    parseLiteral: ast => {
      if (ast.kind === Kind.STRING) {
        return new Date(ast.value);
      }
      throw new Error('DateTime must be a string literal');
    },
  }),

  // BigInt scalar for large numbers (token amounts, etc.)
  BigInt: new GraphQLScalarType({
    name: 'BigInt',
    description: 'A large integer value, represented as a string',
    serialize: (value: any) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'string' || typeof value === 'number') {
        return BigInt(value).toString();
      }
      throw new Error('Value must be a BigInt, string, or number');
    },
    parseValue: (value: any) => {
      if (typeof value === 'string') {
        return BigInt(value);
      }
      throw new Error('BigInt must be a string');
    },
    parseLiteral: ast => {
      if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
        return BigInt(ast.value);
      }
      throw new Error('BigInt must be a string or integer literal');
    },
  }),

  // Bytes32 scalar for blockchain hashes
  Bytes32: new GraphQLScalarType({
    name: 'Bytes32',
    description: 'A 32-byte hex string, typically used for blockchain hashes',
    serialize: (value: any) => {
      if (typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)) {
        return value;
      }
      throw new Error('Bytes32 must be a valid 32-byte hex string');
    },
    parseValue: (value: any) => {
      if (typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)) {
        return value;
      }
      throw new Error('Bytes32 must be a valid 32-byte hex string');
    },
    parseLiteral: ast => {
      if (ast.kind === Kind.STRING && /^0x[a-fA-F0-9]{64}$/.test(ast.value)) {
        return ast.value;
      }
      throw new Error('Bytes32 must be a valid 32-byte hex string literal');
    },
  }),

  // Address scalar for Ethereum addresses
  Address: new GraphQLScalarType({
    name: 'Address',
    description: 'An Ethereum address (20-byte hex string)',
    serialize: (value: any) => {
      if (typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)) {
        return value.toLowerCase(); // Normalize to lowercase
      }
      throw new Error('Address must be a valid Ethereum address');
    },
    parseValue: (value: any) => {
      if (typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)) {
        return value.toLowerCase();
      }
      throw new Error('Address must be a valid Ethereum address');
    },
    parseLiteral: ast => {
      if (ast.kind === Kind.STRING && /^0x[a-fA-F0-9]{40}$/.test(ast.value)) {
        return ast.value.toLowerCase();
      }
      throw new Error('Address must be a valid Ethereum address literal');
    },
  }),

  // WeiAmount scalar for token amounts in wei
  WeiAmount: new GraphQLScalarType({
    name: 'WeiAmount',
    description:
      'A token amount in wei (smallest unit), represented as a string',
    serialize: (value: any) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'string') {
        // Validate it's a valid number string
        if (!/^\d+$/.test(value)) {
          throw new Error('WeiAmount must be a positive integer string');
        }
        return value;
      }
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error('WeiAmount must be a positive integer');
        }
        return value.toString();
      }
      throw new Error('WeiAmount must be a BigInt, string, or number');
    },
    parseValue: (value: any) => {
      if (typeof value === 'string') {
        if (!/^\d+$/.test(value)) {
          throw new Error('WeiAmount must be a positive integer string');
        }
        return value;
      }
      throw new Error('WeiAmount must be a string');
    },
    parseLiteral: ast => {
      if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
        const value = ast.value;
        if (!/^\d+$/.test(value)) {
          throw new Error('WeiAmount must be a positive integer');
        }
        return value;
      }
      throw new Error('WeiAmount must be a string or integer literal');
    },
  }),
};

// Union resolvers for search functionality
const unionResolvers = {
  SearchResult: {
    __resolveType: (obj: any) => {
      if (obj.address && obj.wrfBalance !== undefined) {
        return 'User';
      }
      if (obj.tokenId && obj.carbonOffset !== undefined) {
        return 'CarbonCredit';
      }
      if (obj.proposalId && obj.proposer !== undefined) {
        return 'GovernanceProposal';
      }
      if (obj.stationId && obj.location !== undefined) {
        return 'WeatherStation';
      }
      if (obj.tokenId && obj.modelType !== undefined) {
        return 'ComputationalNFT';
      }
      return null;
    },
  },
};

// Root resolvers
const rootResolvers = {
  Query: {
    // Health check query
    _health: () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
    }),
  },

  // No root mutations or subscriptions needed - they are defined in individual resolvers
};

// Merge all resolvers - all Task 57 resolvers now active
export const resolvers = mergeResolvers([
  scalarResolvers,
  unionResolvers,
  rootResolvers,
  tokenResolvers,
  weatherResolvers,
  carbonCreditResolvers,
  computationalNftResolvers,
  governanceResolvers,
  ammResolvers,
  userResolvers,
  analyticsResolvers,
  subscriptionResolvers,
]);

// Export individual resolver modules for testing - all Task 57 resolvers now available
export {
  tokenResolvers,
  weatherResolvers,
  carbonCreditResolvers,
  computationalNftResolvers,
  governanceResolvers,
  ammResolvers,
  userResolvers,
  analyticsResolvers,
  subscriptionResolvers,
};
