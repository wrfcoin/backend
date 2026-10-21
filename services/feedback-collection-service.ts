// SPDX-License-Identifier: MIT
/**
 * @title Oracle API Service
 * @dev RESTful API service for oracle data access and management
 */

import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { body, query, validationResult } from 'express-validator';
import {
  OracleIntegrationService,
  DataType,
  OracleProvider,
} from './carbon_tracking.js';
import { appLogger } from '../server/utils/logger.js';
import strictCorsConfig from '../server/utils/strict-cors-config.js';
import {
  GracefulShutdown,
  createHttpServerShutdownHandler,
} from '../shared/graceful-shutdown/index.js';

export interface OracleAPIConfig {
  port: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  apiKey?: string;
  enableCORS: boolean;
  allowedOrigins?: string[];
}

export class OracleAPIService {
  private app: express.Application;
  private oracleService: OracleIntegrationService;
  private config: OracleAPIConfig;

  constructor(
    oracleService: OracleIntegrationService,
    config: OracleAPIConfig
  ) {
    this.app = express();
    this.oracleService = oracleService;
    this.config = config;
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet());

    // CORS configuration
    if (this.config.enableCORS) {
      // backend#1236: an explicit allowedOrigins list, else CORS_ORIGIN. In
      // production both must pass the policy (no '*' fallback); outside
      // production the historical '*' default is kept.
      const origins: string[] = strictCorsConfig.resolveServiceCorsOrigins(this.config.allowedOrigins, {
        developmentDefaults: ['*'],
      });
      const corsOptions = {
        origin: origins.length === 1 && origins[0] === '*' ? '*' : origins,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: true,
      };
      this.app.use(cors(corsOptions));
    }

    // Rate limiting
    const limiter = rateLimit({
      windowMs: this.config.rateLimitWindowMs,
      max: this.config.rateLimitMax,
      message: {
        error: 'Too many requests from this IP, please try again later.',
      },
      standardHeaders: true,
      legacyHeaders: false,
    });
    (this.app as any).use(limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // API Key authentication middleware
    if (this.config.apiKey) {
      this.app.use(this.authenticateAPIKey.bind(this));
    }

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      appLogger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  /**
   * API Key authentication middleware
   */
  private authenticateAPIKey(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const apiKey =
      req.header('X-API-Key') ||
      req.header('Authorization')?.replace('Bearer ', '');

    if (!apiKey || apiKey !== this.config.apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Valid API key required',
      });
      return;
    }

    next();
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/api/v1/health', this.getHealth.bind(this));

    // Oracle data endpoints
    this.app.get(
      '/api/v1/oracle/data/:feedId',
      [
        query('dataType')
          .isIn(Object.values(DataType))
          .withMessage('Invalid data type'),
        query('includeHistory')
          .optional()
          .isBoolean()
          .withMessage('includeHistory must be boolean'),
      ],
      this.getOracleData.bind(this)
    );

    this.app.get(
      '/api/v1/oracle/aggregated/:feedId',
      [
        query('dataType')
          .isIn(Object.values(DataType))
          .withMessage('Invalid data type'),
      ],
      this.getAggregatedData.bind(this)
    );

    // Weather data endpoints
    this.app.get(
      '/api/v1/weather/current/:location',
      this.getCurrentWeather.bind(this)
    );
    this.app.get(
      '/api/v1/weather/history/:location',
      [
        query('from').isISO8601().withMessage('from must be valid ISO date'),
        query('to').isISO8601().withMessage('to must be valid ISO date'),
      ],
      this.getWeatherHistory.bind(this)
    );

    // Climate data endpoints
    this.app.get(
      '/api/v1/climate/current/:regionId',
      this.getCurrentClimate.bind(this)
    );
    this.app.get(
      '/api/v1/climate/trends/:regionId',
      this.getClimateTrends.bind(this)
    );

    // Verification endpoints
    this.app.get(
      '/api/v1/verification/status/:projectId',
      this.getVerificationStatus.bind(this)
    );
    this.app.post(
      '/api/v1/verification/batch',
      [
        body('projectIds').isArray().withMessage('projectIds must be array'),
        body('projectIds.*')
          .isString()
          .withMessage('projectIds must contain strings'),
      ],
      this.getBatchVerificationStatus.bind(this)
    );

    // Price feed endpoints
    this.app.get(
      '/api/v1/price/current/:pair',
      this.getCurrentPrice.bind(this)
    );
    this.app.get(
      '/api/v1/price/history/:pair',
      [
        query('from').isISO8601().withMessage('from must be valid ISO date'),
        query('to').isISO8601().withMessage('to must be valid ISO date'),
      ],
      this.getPriceHistory.bind(this)
    );

    this.app.get('/api/v1/price/markets', this.getAvailableMarkets.bind(this));

    // Oracle management endpoints
    this.app.get('/api/v1/oracle/health', this.getOracleHealth.bind(this));
    this.app.get(
      '/api/v1/oracle/config/:feedId',
      this.getOracleConfig.bind(this)
    );
    this.app.post(
      '/api/v1/oracle/circuit-breaker',
      [
        body('oracleKey').isString().withMessage('oracleKey required'),
        body('enabled').isBoolean().withMessage('enabled must be boolean'),
      ],
      this.toggleCircuitBreaker.bind(this)
    );

    // Cache management endpoints
    this.app.delete('/api/v1/cache', this.clearCache.bind(this));
    this.app.get('/api/v1/cache/stats', this.getCacheStats.bind(this));

    // WebSocket endpoints for real-time data
    this.app.get('/api/v1/stream/:feedId', this.streamData.bind(this));

    // Bulk data endpoints
    this.app.post(
      '/api/v1/bulk/weather',
      [
        body('locations').isArray().withMessage('locations must be array'),
        body('locations.*')
          .isString()
          .withMessage('locations must contain strings'),
      ],
      this.getBulkWeatherData.bind(this)
    );

    this.app.post(
      '/api/v1/bulk/prices',
      [
        body('pairs').isArray().withMessage('pairs must be array'),
        body('pairs.*').isString().withMessage('pairs must contain strings'),
      ],
      this.getBulkPriceData.bind(this)
    );

    // Error handling middleware
    this.app.use(this.errorHandler.bind(this));

    // 404 handler
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'The requested endpoint does not exist',
      });
    });
  }

  /**
   * Health check endpoint
   */
  private async getHealth(req: Request, res: Response): Promise<void> {
    try {
      const healthScores = this.oracleService.getHealthScores();
      const circuitBreakers = this.oracleService.getCircuitBreakerStatus();
      const cacheStats = this.oracleService.getCacheStats();

      const overallHealth =
        Array.from(healthScores.values()).reduce(
          (sum, score) => sum + score,
          0
        ) / healthScores.size;

      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        oracle: {
          overallHealth: Math.round(overallHealth),
          activeOracles: healthScores.size,
          circuitBreakersActive: Array.from(circuitBreakers.values()).filter(
            Boolean
          ).length,
          cacheSize: cacheStats.size,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Health check failed',
      });
    }
  }

  /**
   * Get oracle data for specific feed
   */
  private async getOracleData(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { feedId } = req.params;
      const { dataType, includeHistory } = req.query;

      const data = await this.oracleService.getAggregatedData(
        feedId,
        dataType as DataType
      );

      const response: any = {
        feedId,
        dataType,
        data,
        timestamp: new Date().toISOString(),
      };

      if (includeHistory === 'true') {
        // Add historical data if requested
        response.history = []; // Would implement historical data retrieval
      }

      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: 'Oracle Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get aggregated data from multiple oracles
   */
  private async getAggregatedData(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { feedId } = req.params;
      const { dataType } = req.query;

      const aggregatedData = await this.oracleService.getAggregatedData(
        feedId,
        dataType as DataType
      );

      res.json({
        feedId,
        dataType,
        aggregatedData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Aggregation Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get current weather data
   */
  private async getCurrentWeather(req: Request, res: Response): Promise<void> {
    try {
      const { location } = req.params;

      const weatherData = await this.oracleService.getAggregatedData(
        `WEATHER_${location.toUpperCase()}`,
        DataType.WEATHER_DATA
      );

      res.json({
        location,
        weather: weatherData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Weather Data Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch weather data',
      });
    }
  }

  /**
   * Get weather history
   */
  private async getWeatherHistory(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { location } = req.params;
      const { from, to } = req.query;

      // This would implement historical weather data retrieval
      res.json({
        location,
        period: { from, to },
        history: [], // Placeholder for historical data
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Weather History Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch weather history',
      });
    }
  }

  /**
   * Get current climate data
   */
  private async getCurrentClimate(req: Request, res: Response): Promise<void> {
    try {
      const { regionId } = req.params;

      const climateData = await this.oracleService.getAggregatedData(
        `CLIMATE_${regionId.toUpperCase()}`,
        DataType.WEATHER_DATA
      );

      res.json({
        regionId,
        climate: climateData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Climate Data Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch climate data',
      });
    }
  }

  /**
   * Get climate trends
   */
  private async getClimateTrends(req: Request, res: Response): Promise<void> {
    try {
      const { regionId } = req.params;

      // This would implement climate trend analysis
      res.json({
        regionId,
        trends: {
          temperature: { trend: 'increasing', rate: 0.1 },
          precipitation: { trend: 'stable', rate: 0.0 },
          co2: { trend: 'increasing', rate: 2.3 },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Climate Trends Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch climate trends',
      });
    }
  }

  /**
   * Get verification status
   */
  private async getVerificationStatus(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const { projectId } = req.params;

      const verificationData = await this.oracleService.getAggregatedData(
        `VERIFICATION_${projectId}`,
        DataType.VERIFICATION_STATUS
      );

      res.json({
        projectId,
        verification: verificationData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Verification Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch verification status',
      });
    }
  }

  /**
   * Get batch verification status
   */
  private async getBatchVerificationStatus(
    req: Request,
    res: Response
  ): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { projectIds } = req.body;

      const verifications = await Promise.allSettled(
        projectIds.map(async (projectId: string) => {
          const data = await this.oracleService.getAggregatedData(
            `VERIFICATION_${projectId}`,
            DataType.VERIFICATION_STATUS
          );
          return { projectId, verification: data };
        })
      );

      const results = verifications.map((result, index) => ({
        projectId: projectIds[index],
        status: result.status,
        data: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason.message : null,
      }));

      res.json({
        results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Batch Verification Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch batch verification status',
      });
    }
  }

  /**
   * Get current price
   */
  private async getCurrentPrice(req: Request, res: Response): Promise<void> {
    try {
      const { pair } = req.params;

      const priceData = await this.oracleService.getAggregatedData(
        pair.toUpperCase(),
        DataType.PRICE_FEED
      );

      res.json({
        pair: pair.toUpperCase(),
        price: priceData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Price Data Error',
        message:
          error instanceof Error ? error.message : 'Unable to fetch price data',
      });
    }
  }

  /**
   * Get price history
   */
  private async getPriceHistory(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { pair } = req.params;
      const { from, to } = req.query;

      // This would implement historical price data retrieval
      res.json({
        pair: pair.toUpperCase(),
        period: { from, to },
        history: [], // Placeholder for historical price data
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Price History Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch price history',
      });
    }
  }

  /**
   * Get available markets
   */
  private async getAvailableMarkets(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const markets = [
        {
          id: 'BTC/USD',
          name: 'Bitcoin/US Dollar',
          providers: ['Chainlink', 'DIA'],
        },
        {
          id: 'ETH/USD',
          name: 'Ethereum/US Dollar',
          providers: ['Chainlink', 'DIA'],
        },
        {
          id: 'CARBON/USD',
          name: 'Carbon Credits/US Dollar',
          providers: ['Custom'],
        },
      ];

      res.json({
        markets,
        count: markets.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Markets Error',
        message: 'Unable to fetch available markets',
      });
    }
  }

  /**
   * Get oracle health scores
   */
  private async getOracleHealth(req: Request, res: Response): Promise<void> {
    try {
      const healthScores = this.oracleService.getHealthScores();
      const circuitBreakers = this.oracleService.getCircuitBreakerStatus();

      const health = Array.from(healthScores.entries()).map(([key, score]) => ({
        oracle: key,
        healthScore: score,
        status:
          score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'unhealthy',
        circuitBreakerActive: circuitBreakers.get(key) || false,
      }));

      res.json({
        oracles: health,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Health Check Error',
        message: 'Unable to fetch oracle health',
      });
    }
  }

  /**
   * Get oracle configuration
   */
  private async getOracleConfig(req: Request, res: Response): Promise<void> {
    try {
      const { feedId } = req.params;

      // This would return oracle configuration for the feed
      res.json({
        feedId,
        config: {
          providers: Object.values(OracleProvider),
          dataTypes: Object.values(DataType),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Config Error',
        message: 'Unable to fetch oracle configuration',
      });
    }
  }

  /**
   * Toggle circuit breaker
   */
  private async toggleCircuitBreaker(
    req: Request,
    res: Response
  ): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { oracleKey, enabled } = req.body;

      this.oracleService.setCircuitBreaker(oracleKey, enabled);

      res.json({
        oracleKey,
        circuitBreakerEnabled: enabled,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Circuit Breaker Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to toggle circuit breaker',
      });
    }
  }

  /**
   * Clear cache
   */
  private async clearCache(req: Request, res: Response): Promise<void> {
    try {
      this.oracleService.clearCache();

      res.json({
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Cache Error',
        message: 'Unable to clear cache',
      });
    }
  }

  /**
   * Get cache statistics
   */
  private async getCacheStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.oracleService.getCacheStats();

      res.json({
        cache: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Cache Stats Error',
        message: 'Unable to fetch cache statistics',
      });
    }
  }

  /**
   * Stream real-time data via Server-Sent Events (SSE).
   *
   * Sends an initial connection event followed by synthetic feedback events
   * every 5 seconds. The connection stays open until the client disconnects.
   *
   * NOTE: A full WebSocket upgrade can be layered on later; SSE provides a
   * simpler unidirectional stream that works today without new dependencies.
   */
  private async streamData(req: Request, res: Response): Promise<void> {
    const { feedId } = req.params;

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Simple hash helper for deterministic IDs
    const simpleHash = (str: string): number =>
      str.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0);

    // Send initial connection event with metadata
    const connectionEvent = {
      type: 'connection',
      feedId,
      connectedAt: new Date().toISOString(),
      message: 'SSE stream established — feedback events will follow every 5s',
    };
    res.write(`event: connection\ndata: ${JSON.stringify(connectionEvent)}\n\n`);

    // Synthetic feedback categories and sources for variety
    const categories = ['performance', 'usability', 'reliability', 'documentation', 'support'];
    const sources = ['web-app', 'mobile-app', 'api-consumer', 'partner-portal', 'cli-tool'];
    let eventSeq = 0;

    // Emit a synthetic feedback event every 5 seconds
    const intervalId = setInterval(() => {
      eventSeq += 1;
      const seed = simpleHash(`${feedId}:${eventSeq}:${Date.now()}`);
      const absSeed = Math.abs(seed);

      const feedbackEvent = {
        type: 'feedback',
        data: {
          id: `fb_${feedId}_${eventSeq}`,
          source: sources[absSeed % sources.length],
          rating: (absSeed % 5) + 1,            // 1-5
          category: categories[absSeed % categories.length],
          timestamp: new Date().toISOString(),
        },
      };

      res.write(`event: feedback\ndata: ${JSON.stringify(feedbackEvent)}\n\n`);
    }, 5_000);

    // Clean up when the client disconnects
    req.on('close', () => {
      clearInterval(intervalId);
      appLogger.info('SSE stream closed', { feedId });
    });
  }

  /**
   * Get bulk weather data
   */
  private async getBulkWeatherData(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { locations } = req.body;

      const weatherData = await Promise.allSettled(
        locations.map(async (location: string) => {
          const data = await this.oracleService.getAggregatedData(
            `WEATHER_${location.toUpperCase()}`,
            DataType.WEATHER_DATA
          );
          return { location, weather: data };
        })
      );

      const results = weatherData.map((result, index) => ({
        location: locations[index],
        status: result.status,
        data: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason.message : null,
      }));

      res.json({
        results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Bulk Weather Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch bulk weather data',
      });
    }
  }

  /**
   * Get bulk price data
   */
  private async getBulkPriceData(req: Request, res: Response): Promise<void> {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        error: 'Validation Error',
        details: errors.array(),
      });
      return;
    }

    try {
      const { pairs } = req.body;

      const priceData = await Promise.allSettled(
        pairs.map(async (pair: string) => {
          const data = await this.oracleService.getAggregatedData(
            pair.toUpperCase(),
            DataType.PRICE_FEED
          );
          return { pair, price: data };
        })
      );

      const results = priceData.map((result, index) => ({
        pair: pairs[index],
        status: result.status,
        data: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason.message : null,
      }));

      res.json({
        results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Bulk Price Error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to fetch bulk price data',
      });
    }
  }

  /**
   * Error handling middleware
   */
  private errorHandler(
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    appLogger.error('API Error', { error: error.message, stack: error.stack });

    res.status(500).json({
      error: 'Internal Server Error',
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'An unexpected error occurred',
    });
  }

  /**
   * Start the API server
   */
  public start(): void {
    const server = this.app.listen(this.config.port, () => {
      appLogger.info('Oracle API Service running', {
        port: this.config.port,
        healthCheck: `http://localhost:${this.config.port}/api/v1/health`,
      });
    });

    // Register with graceful shutdown manager
    const gracefulShutdown = GracefulShutdown.getInstance({
      logger: (message, level) => {
        if (level === 'error') {
          appLogger.error(message);
        } else if (level === 'warn') {
          appLogger.warn(message);
        } else {
          appLogger.info(message);
        }
      },
    });

    gracefulShutdown.registerHandler(
      createHttpServerShutdownHandler(server, {
        name: 'oracle-api-server',
        timeout: 10000,
      })
    );

    gracefulShutdown.setupSignalHandlers();
  }

  /**
   * Create feedback session
   */
  public async createFeedbackSession(sessionData: any): Promise<any> {
    // Mock implementation for feedback session creation
    return {
      sessionId: `feedback_${Date.now()}`,
      ...sessionData,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get feedback session
   */
  public async getFeedbackSession(sessionId: string): Promise<any> {
    // Mock implementation for feedback session retrieval
    return {
      sessionId,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get surveys by type
   */
  public async getSurveysByType(surveyType: string): Promise<any[]> {
    // Mock implementation for surveys retrieval
    return [
      {
        surveyId: `survey_${Date.now()}`,
        type: surveyType,
        questions: [],
      },
    ];
  }

  /**
   * Get survey with questions
   */
  public async getSurveyWithQuestions(surveyId: string): Promise<any> {
    // Mock implementation for survey with questions
    return {
      surveyId,
      questions: [],
      metadata: {},
    };
  }

  /**
   * Expire old sessions
   */
  public async expireOldSessions(): Promise<void> {
    // Mock implementation for session cleanup
    appLogger.info('Expired old feedback sessions');
  }

  /**
   * Get Express app for testing
   */
  public getApp(): express.Application {
    return this.app;
  }
}

// Export interfaces and types for external use
export interface CreateFeedbackSessionRequest {
  sessionType: string;
  session_type: string;
  partner_id: string;
  partner_name: string;
  test_scenario_id?: string;
  metadata?: any;
}

export interface SubmitFeedbackRequest {
  sessionId: string;
  responses: any[];
  metadata?: any;
}

export class FeedbackCollectionService {
  private oracleService: OracleAPIService;

  constructor(oracleService: OracleAPIService) {
    this.oracleService = oracleService;
  }

  public async createSession(
    request: CreateFeedbackSessionRequest
  ): Promise<any> {
    return this.oracleService.createFeedbackSession(request);
  }

  public async createFeedbackSession(
    request: CreateFeedbackSessionRequest
  ): Promise<any> {
    return this.createSession(request);
  }

  public async submitFeedback(request: SubmitFeedbackRequest): Promise<any> {
    // Mock implementation for feedback submission
    return {
      success: true,
      submissionId: `sub_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
  }

  public async getSurveys(): Promise<any[]> {
    // Mock implementation for getting surveys
    return [
      {
        id: 'survey_1',
        title: 'Performance Feedback',
        type: 'performance',
        questions: [],
      },
    ];
  }

  public async getSurveyById(id: string): Promise<any | null> {
    // Mock implementation for getting survey by ID
    return {
      id,
      title: 'Survey',
      type: 'general',
      questions: [],
    };
  }

  public async getSurveyWithQuestions(id: string): Promise<any | null> {
    // Mock implementation for getting survey with questions
    return {
      id,
      title: 'Survey with Questions',
      type: 'general',
      questions: [{ id: 'q1', text: 'How satisfied are you?', type: 'rating' }],
    };
  }

  public async getSurveysByType(type: string): Promise<any[]> {
    // Mock implementation for getting surveys by type
    return [
      {
        id: `survey_${type}_1`,
        title: `${type} Feedback`,
        type,
        questions: [],
      },
    ];
  }

  public async getFeedbackSession(id: string): Promise<any | null> {
    // Mock implementation for getting feedback session
    return {
      id,
      status: 'active',
      type: 'general',
      created_at: new Date().toISOString(),
    };
  }

  public async updateFeedbackSession(id: string, updates: any): Promise<any> {
    // Mock implementation for updating feedback session
    return {
      id,
      ...updates,
      updated_at: new Date().toISOString(),
    };
  }

  public async expireOldSessions(): Promise<void> {
    // Mock implementation for expiring old sessions
    appLogger.info('Expired old feedback sessions');
  }

  public async submitFeedbackResponses(responses: any): Promise<any> {
    // Mock implementation for submitting feedback responses
    return {
      success: true,
      submissionId: `sub_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
  }

  public async getPartnerFeedbackResponses(partnerId: string): Promise<any[]> {
    // Mock implementation for getting partner feedback responses
    return [
      {
        id: 'response_1',
        partnerId,
        satisfaction: 4.5,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  public async getPartnerSatisfactionTrends(partnerId: string): Promise<any> {
    // Mock implementation for getting satisfaction trends
    return {
      partnerId,
      trends: [
        { month: '2025-06', satisfaction: 4.5 },
        { month: '2025-07', satisfaction: 4.7 },
      ],
      averageSatisfaction: 4.6,
    };
  }

  public async calculatePartnerSatisfactionMetrics(
    partnerId: string
  ): Promise<any> {
    // Mock implementation for calculating satisfaction metrics
    return {
      partnerId,
      overallSatisfaction: 4.6,
      responseRate: 0.85,
      totalResponses: 142,
      lastUpdated: new Date().toISOString(),
    };
  }

  public async getAnalyticsSummary(): Promise<any> {
    // Mock implementation for getting analytics summary
    return {
      totalSessions: 1250,
      averageSatisfaction: 4.5,
      responseRate: 0.78,
      topIssues: ['Performance', 'Documentation', 'Support'],
      timestamp: new Date().toISOString(),
    };
  }
}

export default OracleAPIService;
