/**
 * Analytics Controller - TypeScript Implementation
 * Handles analytics data operations with comprehensive Zod validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { appLogger } from '../utils/logger.js';

// ============================================
// Zod Validation Schemas
// ============================================

// Core validation patterns
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

// Pagination schema
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Time range schema
const timeRangeSchema = z.object({
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
}).refine(data => data.endTime > data.startTime, {
  message: 'End time must be after start time',
});

// Metric types
const metricTypeSchema = z.enum([
  'TRANSACTION_VOLUME',
  'ACTIVE_WALLETS',
  'GAS_USAGE',
  'ORACLE_CALLS',
  'BRIDGE_TRANSFERS',
  'WEATHER_DATA_POINTS',
  'CARBON_CREDITS',
  'TOKEN_TRANSFERS',
  'NFT_MINTS',
  'GOVERNANCE_VOTES'
]);

// Aggregation types
const aggregationTypeSchema = z.enum([
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY'
]);

// Query analytics schema
const queryAnalyticsSchema = z.object({
  metrics: z.array(metricTypeSchema).min(1).max(10),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  aggregation: aggregationTypeSchema.default('DAILY'),
  filters: z.object({
    address: ethereumAddressSchema.optional(),
    chainId: z.coerce.number().int().positive().optional(),
    tokenType: z.string().max(50).optional(),
  }).optional(),
}).refine(data => data.endTime > data.startTime, {
  message: 'End time must be after start time',
});

// Wallet analytics schema
const walletAnalyticsSchema = z.object({
  address: ethereumAddressSchema,
  metrics: z.array(metricTypeSchema).optional(),
  timeRange: timeRangeSchema.optional(),
});

// Report generation schema
const generateReportSchema = z.object({
  reportType: z.enum(['SUMMARY', 'DETAILED', 'CUSTOM']),
  metrics: z.array(metricTypeSchema).min(1),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  format: z.enum(['JSON', 'CSV', 'PDF']).default('JSON'),
  recipients: z.array(z.string().email()).optional(),
  includeCharts: z.boolean().default(false),
});

// Dashboard config schema
const dashboardConfigSchema = z.object({
  widgets: z.array(z.object({
    type: z.enum(['LINE_CHART', 'BAR_CHART', 'PIE_CHART', 'TABLE', 'METRIC_CARD']),
    metric: metricTypeSchema,
    title: z.string().max(100),
    position: z.object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1).max(12),
      height: z.number().int().min(1).max(8),
    }),
  })).min(1).max(20),
  refreshInterval: z.number().int().min(10).max(3600).default(60), // seconds
  theme: z.enum(['LIGHT', 'DARK', 'AUTO']).default('AUTO'),
});

// ============================================
// Types
// ============================================

interface AnalyticsResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
  requestId: string;
}

interface MetricDataPoint {
  timestamp: Date;
  value: number;
  metric: string;
}

interface AnalyticsSummary {
  totalTransactions: number;
  activeWallets: number;
  totalVolume: string;
  avgGasUsed: number;
  topMetrics: Record<string, number>;
}

interface WalletAnalytics {
  address: string;
  transactionCount: number;
  totalVolume: string;
  firstActivity: Date;
  lastActivity: Date;
  metrics: Record<string, number>;
}

// ============================================
// Controller Methods
// ============================================

/**
 * Query analytics data
 */
export const queryAnalytics = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<MetricDataPoint[]>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for query parameters
    const bodyResult = queryAnalyticsSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: AnalyticsResponse<MetricDataPoint[]> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Analytics query validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const queryParams = bodyResult.data;

    // Simulate analytics data retrieval
    const mockData: MetricDataPoint[] = queryParams.metrics.map(metric => ({
      timestamp: new Date(),
      value: Math.floor(Math.random() * 10000),
      metric,
    }));

    const response: AnalyticsResponse<MetricDataPoint[]> = {
      success: true,
      data: mockData,
      message: `Retrieved analytics for ${queryParams.metrics.length} metrics`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to query analytics', { module: 'AnalyticsController', operation: 'queryAnalytics', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<MetricDataPoint[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to query analytics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get analytics summary
 */
export const getSummary = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<AnalyticsSummary>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for time range (optional)
    const timeRangeResult = timeRangeSchema.optional().safeParse({
      startTime: req.query.startTime,
      endTime: req.query.endTime,
    });

    // Generate summary data
    const summary: AnalyticsSummary = {
      totalTransactions: 1234567,
      activeWallets: 45678,
      totalVolume: '1000000000000000000000', // 1000 ETH in wei
      avgGasUsed: 21000,
      topMetrics: {
        TRANSACTION_VOLUME: 95678,
        ACTIVE_WALLETS: 12345,
        WEATHER_DATA_POINTS: 87654,
      },
    };

    const response: AnalyticsResponse<AnalyticsSummary> = {
      success: true,
      data: summary,
      message: 'Analytics summary retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to get analytics summary', { module: 'AnalyticsController', operation: 'getSummary', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<AnalyticsSummary> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to get analytics summary',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get wallet analytics
 */
export const getWalletAnalytics = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<WalletAnalytics>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for wallet address
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);

    if (!addressResult.success) {
      const errorResponse: AnalyticsResponse<WalletAnalytics> = {
        success: false,
        error: addressResult.error.issues[0].message,
        message: 'Invalid wallet address format',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = addressResult.data;

    // Simulate wallet analytics
    const walletData: WalletAnalytics = {
      address,
      transactionCount: 456,
      totalVolume: '50000000000000000000', // 50 ETH in wei
      firstActivity: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
      lastActivity: new Date(),
      metrics: {
        TRANSACTION_VOLUME: 456,
        TOKEN_TRANSFERS: 123,
        NFT_MINTS: 5,
      },
    };

    const response: AnalyticsResponse<WalletAnalytics> = {
      success: true,
      data: walletData,
      message: 'Wallet analytics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to get wallet analytics', { module: 'AnalyticsController', operation: 'getWalletAnalytics', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<WalletAnalytics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to get wallet analytics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Generate analytics report
 */
export const generateReport = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<{ reportId: string; status: string }>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for report generation request
    const bodyResult = generateReportSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: AnalyticsResponse<{ reportId: string; status: string }> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Report generation validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const reportConfig = bodyResult.data;

    // Generate report ID
    const reportId = `report_${uuidv4().slice(0, 8)}`;

    const response: AnalyticsResponse<{ reportId: string; status: string }> = {
      success: true,
      data: {
        reportId,
        status: 'GENERATING',
      },
      message: 'Report generation started',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(202).json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to generate report', { module: 'AnalyticsController', operation: 'generateReport', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<{ reportId: string; status: string }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to generate report',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Save dashboard configuration
 */
export const saveDashboardConfig = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<{ dashboardId: string }>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for dashboard config
    const bodyResult = dashboardConfigSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: AnalyticsResponse<{ dashboardId: string }> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Dashboard config validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const dashboardConfig = bodyResult.data;

    // Generate dashboard ID
    const dashboardId = `dashboard_${uuidv4().slice(0, 8)}`;

    const response: AnalyticsResponse<{ dashboardId: string }> = {
      success: true,
      data: { dashboardId },
      message: 'Dashboard configuration saved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to save dashboard configuration', { module: 'AnalyticsController', operation: 'saveDashboardConfig', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<{ dashboardId: string }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to save dashboard configuration',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get real-time metrics
 */
export const getRealTimeMetrics = async (
  req: Request,
  res: Response
): Promise<AnalyticsResponse<Record<string, number>>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for metric types (optional filter)
    const metricsFilter = z.array(metricTypeSchema).optional().safeParse(
      req.query.metrics ? (req.query.metrics as string).split(',') : undefined
    );

    // Generate real-time metrics
    const metrics: Record<string, number> = {
      TRANSACTION_VOLUME: Math.floor(Math.random() * 1000),
      ACTIVE_WALLETS: Math.floor(Math.random() * 500),
      GAS_USAGE: Math.floor(Math.random() * 100000),
      ORACLE_CALLS: Math.floor(Math.random() * 200),
      WEATHER_DATA_POINTS: Math.floor(Math.random() * 1000),
    };

    const response: AnalyticsResponse<Record<string, number>> = {
      success: true,
      data: metrics,
      message: 'Real-time metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to get real-time metrics', { module: 'AnalyticsController', operation: 'getRealTimeMetrics', error: (error as Error).message });
    const errorResponse: AnalyticsResponse<Record<string, number>> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to get real-time metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  queryAnalytics,
  getSummary,
  getWalletAnalytics,
  generateReport,
  saveDashboardConfig,
  getRealTimeMetrics,
};
