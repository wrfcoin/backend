/**
 * Oracle Controller - TypeScript Implementation
 * Handles oracle data operations with comprehensive Zod validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { weatherLogger } from '../utils/logger.js';
import { fetchLiveWeatherData } from '../services/live-weather-fetcher.js';

// ============================================
// Zod Validation Schemas
// ============================================

// Core validation patterns
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash format');

// Oracle identifier schema
const oracleIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid oracle ID format');

// Data feed types
const dataFeedTypeSchema = z.enum([
  'WEATHER',
  'PRICE',
  'CARBON_CREDIT',
  'TEMPERATURE',
  'HUMIDITY',
  'WIND_SPEED',
  'AIR_QUALITY',
  'CUSTOM'
]);

// Pagination schema
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Oracle registration schema
const registerOracleSchema = z.object({
  name: z.string().min(3).max(100).trim(),
  description: z.string().max(500).optional(),
  providerAddress: ethereumAddressSchema,
  dataFeedType: dataFeedTypeSchema,
  updateFrequency: z.number().int().min(1).max(86400), // seconds, max 1 day
  minStake: z.string().max(78).regex(/^[0-9]+$/, 'Invalid stake amount'),
  endpoint: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Oracle data submission schema
const submitOracleDataSchema = z.object({
  oracleId: oracleIdSchema,
  dataType: dataFeedTypeSchema,
  value: z.union([z.number(), z.string(), z.object({})]),
  timestamp: z.coerce.date(),
  signature: z.string().min(1),
  proof: z.string().optional(),
  source: z.string().max(200).optional(),
});

// Oracle query schema
const queryOracleDataSchema = z.object({
  oracleId: oracleIdSchema.optional(),
  dataType: dataFeedTypeSchema.optional(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  aggregation: z.enum(['AVERAGE', 'MIN', 'MAX', 'LATEST', 'SUM']).optional(),
});

// ============================================
// Types
// ============================================

interface OracleResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
  requestId: string;
}

interface OracleInfo {
  id: string;
  name: string;
  providerAddress: string;
  dataFeedType: string;
  reputation: number;
  isActive: boolean;
  lastUpdate: Date;
}

interface OracleDataPoint {
  oracleId: string;
  dataType: string;
  value: unknown;
  timestamp: Date;
  blockNumber?: number;
}

// ============================================
// Controller Methods
// ============================================

/**
 * Register a new oracle provider
 */
export const registerOracle = async (
  req: Request,
  res: Response
): Promise<OracleResponse<OracleInfo>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for registration request
    const bodyResult = registerOracleSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: OracleResponse<OracleInfo> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Oracle registration validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const registrationData = bodyResult.data;

    // Simulate oracle registration
    const newOracle: OracleInfo = {
      id: `oracle_${uuidv4().slice(0, 8)}`,
      name: registrationData.name,
      providerAddress: registrationData.providerAddress,
      dataFeedType: registrationData.dataFeedType,
      reputation: 100,
      isActive: true,
      lastUpdate: new Date(),
    };

    const response: OracleResponse<OracleInfo> = {
      success: true,
      data: newOracle,
      message: 'Oracle registered successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in registerOracle', {
      error: { message: (error as Error).message, stack: (error as Error).stack },
      requestId,
    });
    const errorResponse: OracleResponse<OracleInfo> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to register oracle',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit oracle data
 */
export const submitData = async (
  req: Request,
  res: Response
): Promise<OracleResponse<OracleDataPoint>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for data submission
    const bodyResult = submitOracleDataSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: OracleResponse<OracleDataPoint> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Oracle data submission validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const submissionData = bodyResult.data;

    // Simulate data storage
    const dataPoint: OracleDataPoint = {
      oracleId: submissionData.oracleId,
      dataType: submissionData.dataType,
      value: submissionData.value,
      timestamp: submissionData.timestamp,
      blockNumber: Math.floor(Math.random() * 10000000),
    };

    const response: OracleResponse<OracleDataPoint> = {
      success: true,
      data: dataPoint,
      message: 'Oracle data submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in submitData', {
      error: { message: (error as Error).message, stack: (error as Error).stack },
      requestId,
    });
    const errorResponse: OracleResponse<OracleDataPoint> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit oracle data',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Query oracle data
 */
export const queryData = async (
  req: Request,
  res: Response
): Promise<OracleResponse<OracleDataPoint[]>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for query parameters
    const queryResult = queryOracleDataSchema.safeParse(req.query);
    const paginationResult = paginationSchema.safeParse(req.query);

    if (!queryResult.success) {
      const errorResponse: OracleResponse<OracleDataPoint[]> = {
        success: false,
        error: queryResult.error.issues[0].message,
        message: 'Query validation failed: ' + queryResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const queryParams = queryResult.data;
    const pagination = paginationResult.success ? paginationResult.data : { page: 1, limit: 20 };

    // Fetch live weather data from community stations
    const liveWeatherData = await fetchLiveWeatherData();

    // Build response with real weather data
    const weatherDataPoint: OracleDataPoint = {
      oracleId: queryParams.oracleId || 'oracle_duluth_weather',
      dataType: queryParams.dataType || 'WEATHER',
      value: {
        temperature: liveWeatherData.temperature,
        humidity: liveWeatherData.humidity,
        pressure: liveWeatherData.pressure,
        windSpeed: liveWeatherData.windSpeed,
        windDirection: liveWeatherData.windDirection,
        rainfall: liveWeatherData.rainfall,
        source: liveWeatherData.source,
        stationName: liveWeatherData.stationName,
        location: liveWeatherData.location,
        isMockData: liveWeatherData.isMockData,
      },
      timestamp: liveWeatherData.timestamp,
      blockNumber: Math.floor(Date.now() / 1000), // Use current unix timestamp as block number
    };

    const oracleData: OracleDataPoint[] = [weatherDataPoint];

    const response: OracleResponse<OracleDataPoint[]> = {
      success: true,
      data: oracleData,
      message: liveWeatherData.isMockData
        ? `Retrieved ${oracleData.length} data points (mock data - live sources unavailable)`
        : `Retrieved ${oracleData.length} data points from ${liveWeatherData.stationName}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in queryData', {
      error: { message: (error as Error).message, stack: (error as Error).stack },
      requestId,
    });
    const errorResponse: OracleResponse<OracleDataPoint[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to query oracle data',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get oracle by ID
 */
export const getOracleById = async (
  req: Request,
  res: Response
): Promise<OracleResponse<OracleInfo>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for oracle ID
    const idResult = oracleIdSchema.safeParse(req.params.id);

    if (!idResult.success) {
      const errorResponse: OracleResponse<OracleInfo> = {
        success: false,
        error: idResult.error.issues[0].message,
        message: 'Invalid oracle ID format',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const oracleId = idResult.data;

    // Simulate oracle lookup
    const oracle: OracleInfo = {
      id: oracleId,
      name: `Oracle ${oracleId}`,
      providerAddress: '0x1234567890123456789012345678901234567890',
      dataFeedType: 'WEATHER',
      reputation: 95,
      isActive: true,
      lastUpdate: new Date(),
    };

    const response: OracleResponse<OracleInfo> = {
      success: true,
      data: oracle,
      message: 'Oracle retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in getOracleById', {
      error: { message: (error as Error).message, stack: (error as Error).stack },
      requestId,
    });
    const errorResponse: OracleResponse<OracleInfo> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve oracle',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * List all oracles
 */
export const listOracles = async (
  req: Request,
  res: Response
): Promise<OracleResponse<OracleInfo[]>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for pagination
    const paginationResult = paginationSchema.safeParse(req.query);
    const pagination = paginationResult.success ? paginationResult.data : { page: 1, limit: 20 };

    // Optional filter by data feed type
    const dataTypeFilter = dataFeedTypeSchema.optional().safeParse(req.query.dataType);

    // Simulate oracle listing
    const oracles: OracleInfo[] = [
      {
        id: 'oracle_weather_1',
        name: 'Weather Oracle 1',
        providerAddress: '0x1234567890123456789012345678901234567890',
        dataFeedType: 'WEATHER',
        reputation: 98,
        isActive: true,
        lastUpdate: new Date(),
      },
      {
        id: 'oracle_price_1',
        name: 'Price Oracle 1',
        providerAddress: '0x0987654321098765432109876543210987654321',
        dataFeedType: 'PRICE',
        reputation: 95,
        isActive: true,
        lastUpdate: new Date(),
      },
    ];

    const response: OracleResponse<OracleInfo[]> = {
      success: true,
      data: oracles,
      message: `Retrieved ${oracles.length} oracles`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    weatherLogger.error('Error in listOracles', {
      error: { message: (error as Error).message, stack: (error as Error).stack },
      requestId,
    });
    const errorResponse: OracleResponse<OracleInfo[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to list oracles',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  registerOracle,
  submitData,
  queryData,
  getOracleById,
  listOracles,
};
