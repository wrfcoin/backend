// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Enhanced Weather Station Rewards System - TypeScript
 * Advanced achievement tracking and reward tiers for weather data collection
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { PoolClient } from 'pg';
const { getSharedPgPool } = require('./utils/shared-pg-pool');
import { Registry, collectDefaultMetrics } from 'prom-client';
import { weatherLogger } from './utils/logger.js';
import { isReservedMobileStationId } from '../shared/mobile-station-messages.js';
import {
  ApiResponse,
  ApiError,
  ApiResult,
  WeatherData,
  WeatherReward,
  PaginationParams,
  PaginatedResponse,
} from '../shared/types/api-types.js';
import {
  EthereumAddress,
  PositiveNumber,
  SecurityAuditLog,
} from '../shared/types/security-types.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;
const { createDatabaseSSLConfig } = require('./config/secure-ssl-config.js');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

// Types for achievement system
interface AchievementTier {
  level: number;
  threshold: number;
  reward: number;
  title: string;
  icon: string;
}

interface AchievementDefinition {
  name: string;
  description: string;
  tiers: AchievementTier[];
}

interface UserAchievement {
  id: string;
  userId: string;
  achievementType: string;
  level: number;
  unlockedAt: Date;
  rewardClaimed: boolean;
  claimedAt?: Date;
}

interface WeatherStation {
  id: string;
  userId: string;
  name: string;
  location: {
    lat: number;
    lon: number;
    address: string;
  };
  totalSubmissions: number;
  qualityScore: number;
  lastSubmission: Date;
  isActive: boolean;
}

interface RewardCalculation {
  baseReward: number;
  qualityBonus: number;
  consistencyBonus: number;
  achievementBonus: number;
  totalReward: number;
  qualityScore: number;
}

const app = express();
const PORT: number = parseInt(process.env.PORT || '8001', 10);
const probeState = { draining: false };
const prometheusRegistry = new Registry();
prometheusRegistry.setDefaultLabels({ app: 'wrfcoin-weather-earnings' });
collectDefaultMetrics({ register: prometheusRegistry, prefix: 'wrfcoin_backend_' });

// Database connection - uses secure SSL config with rejectUnauthorized: true
const pool = getSharedPgPool({
  connectionString: process.env.DATABASE_URL,
  ssl: createDatabaseSSLConfig(),
});

// CORS configuration
app.use(
  cors({
    origin: [
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
      ...(resolveAllowedOrigins({ developmentDefaults: ['http://localhost:5000', 'http://0.0.0.0:5000'] })),
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json());

// Achievement definitions with tier progression
const ACHIEVEMENT_DEFINITIONS: Record<string, AchievementDefinition> = {
  weather_collector: {
    name: 'Weather Data Collector',
    description: 'Collect weather data consistently',
    tiers: [
      {
        level: 1,
        threshold: 10,
        reward: 0.5,
        title: 'Novice Collector',
        icon: '🌤️',
      },
      {
        level: 2,
        threshold: 25,
        reward: 1.0,
        title: 'Weather Enthusiast',
        icon: '🌦️',
      },
      {
        level: 3,
        threshold: 50,
        reward: 2.0,
        title: 'Data Guardian',
        icon: '⛈️',
      },
      {
        level: 4,
        threshold: 100,
        reward: 5.0,
        title: 'Weather Master',
        icon: '🌪️',
      },
      {
        level: 5,
        threshold: 250,
        reward: 10.0,
        title: 'Climate Oracle',
        icon: '🌈',
      },
    ],
  },
  consistency_champion: {
    name: 'Consistency Champion',
    description: 'Maintain consecutive days of data collection',
    tiers: [
      {
        level: 1,
        threshold: 3,
        reward: 0.3,
        title: '3-Day Streak',
        icon: '📅',
      },
      {
        level: 2,
        threshold: 7,
        reward: 0.7,
        title: 'Weekly Warrior',
        icon: '📊',
      },
      {
        level: 3,
        threshold: 30,
        reward: 3.0,
        title: 'Monthly Marvel',
        icon: '🗓️',
      },
      {
        level: 4,
        threshold: 90,
        reward: 9.0,
        title: 'Quarterly Champion',
        icon: '📈',
      },
      {
        level: 5,
        threshold: 365,
        reward: 36.5,
        title: 'Annual Legend',
        icon: '🏆',
      },
    ],
  },
  quality_pioneer: {
    name: 'Quality Pioneer',
    description: 'Maintain high data quality scores',
    tiers: [
      {
        level: 1,
        threshold: 80,
        reward: 0.4,
        title: 'Quality Aware',
        icon: '✅',
      },
      {
        level: 2,
        threshold: 85,
        reward: 0.8,
        title: 'Precision Tracker',
        icon: '🎯',
      },
      {
        level: 3,
        threshold: 90,
        reward: 1.8,
        title: 'Accuracy Expert',
        icon: '🔬',
      },
      {
        level: 4,
        threshold: 95,
        reward: 4.5,
        title: 'Quality Master',
        icon: '💎',
      },
      {
        level: 5,
        threshold: 99,
        reward: 9.9,
        title: 'Perfection Pioneer',
        icon: '⭐',
      },
    ],
  },
};

// Helper functions
function createApiResponse<T>(
  data: T,
  meta?: Record<string, any>
): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}

function createApiError(
  code: string,
  message: string,
  details?: unknown
): ApiError {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
}

// Calculate comprehensive reward based on multiple factors
function calculateEnhancedReward(
  weatherData: WeatherData,
  station: WeatherStation
): RewardCalculation {
  const baseReward = 0.1;

  // Quality score calculation (0-100)
  let qualityScore = 60; // Base score

  // Temperature validation
  if (weatherData.temperature_c != null && weatherData.temperature_c >= -50 && weatherData.temperature_c <= 60) {
    qualityScore += 10;
  }

  // Humidity validation
  if (weatherData.humidity_percent != null && weatherData.humidity_percent >= 0 && weatherData.humidity_percent <= 100) {
    qualityScore += 10;
  }

  // Pressure validation
  if (weatherData.pressure_hpa != null && weatherData.pressure_hpa >= 900 && weatherData.pressure_hpa <= 1100) {
    qualityScore += 10;
  }

  // Additional sensor bonuses
  if (weatherData.wind_speed_ms !== undefined) qualityScore += 5;
  if (weatherData.wind_direction_deg !== undefined) qualityScore += 5;
  if (weatherData.precipitation_mm !== undefined) qualityScore += 5;

  qualityScore = Math.min(qualityScore, 100);

  // Quality bonus (up to 200% of base)
  const qualityBonus = baseReward * (qualityScore / 50 - 1);

  // Consistency bonus based on station history
  const consistencyBonus = station.totalSubmissions > 50 ? baseReward * 0.5 : 0;

  // Achievement bonus placeholder
  const achievementBonus = 0;

  const totalReward =
    baseReward +
    Math.max(0, qualityBonus) +
    consistencyBonus +
    achievementBonus;

  return {
    baseReward,
    qualityBonus: Math.max(0, qualityBonus),
    consistencyBonus,
    achievementBonus,
    totalReward,
    qualityScore,
  };
}

// Check and award achievements
async function checkAchievements(
  userId: string,
  stationId: string,
  client: PoolClient
): Promise<UserAchievement[]> {
  try {
    // Get user statistics
    const statsQuery = `
      SELECT
        COUNT(*) as total_submissions,
        AVG(quality_score) as avg_quality,
        MAX(consecutive_days) as max_streak
      FROM weather_submissions
      WHERE user_id = $1 AND station_id = $2
    `;

    const statsResult = await client.query(statsQuery, [userId, stationId]);
    const stats = statsResult.rows[0];

    // Batch fetch ALL existing achievements for this user in ONE query
    const existingQuery = `
      SELECT achievement_type, MAX(level) as max_level
      FROM user_achievements
      WHERE user_id = $1
      GROUP BY achievement_type
    `;
    const existingResult = await client.query(existingQuery, [userId]);
    const existingMap = new Map<string, number>(
      existingResult.rows.map(row => [row.achievement_type, Number(row.max_level)])
    );

    // Determine which achievements are newly earned (in application code)
    const toInsert: Array<{ achievementType: string; level: number }> = [];

    for (const [achievementType, definition] of Object.entries(
      ACHIEVEMENT_DEFINITIONS
    )) {
      let currentValue = 0;

      switch (achievementType) {
        case 'weather_collector':
          currentValue = parseInt(stats.total_submissions) || 0;
          break;
        case 'consistency_champion':
          currentValue = parseInt(stats.max_streak) || 0;
          break;
        case 'quality_pioneer':
          currentValue = parseFloat(stats.avg_quality) || 0;
          break;
      }

      // Find highest tier achieved
      const achievedTier = [...definition.tiers]
        .reverse()
        .find(tier => currentValue >= tier.threshold);

      if (achievedTier) {
        const existingMaxLevel = existingMap.get(achievementType) ?? 0;
        if (achievedTier.level > existingMaxLevel) {
          toInsert.push({ achievementType, level: achievedTier.level });
        }
      }
    }

    // Bulk INSERT all new achievements in ONE query
    if (toInsert.length === 0) {
      return [];
    }

    const valueClauses: string[] = [];
    const params: Array<string | number> = [userId];
    let paramIdx = 2;

    for (const { achievementType, level } of toInsert) {
      valueClauses.push(`($1, $${paramIdx}, $${paramIdx + 1}, NOW(), false)`);
      params.push(achievementType, level);
      paramIdx += 2;
    }

    const insertQuery = `
      INSERT INTO user_achievements (user_id, achievement_type, level, unlocked_at, reward_claimed)
      VALUES ${valueClauses.join(', ')}
      ON CONFLICT DO NOTHING
      RETURNING *
    `;

    const insertResult = await client.query(insertQuery, params);
    return insertResult.rows;
  } catch (error) {
    weatherLogger.error('Error checking achievements', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

// Submit weather data endpoint
app.post(
  '/api/weather/submit',
  async (
    req: Request<{}, ApiResult<WeatherReward>, WeatherData>,
    res: Response<ApiResult<WeatherReward>>
  ): Promise<void> => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const weatherData: WeatherData = req.body;
      const userId = (req.headers['user-id'] as string) || 'demo_user';

      // Validate required fields
      if (
        !weatherData.stationId ||
        weatherData.temperature_c === undefined ||
        weatherData.humidity_percent === undefined
      ) {
        res
          .status(400)
          .json(
            createApiError(
              'INVALID_DATA',
              'Missing required weather data fields'
            )
          );
        return;
      }

      // #1310: `mob-` ids are minted only by the mobile registration service
      // (derived from the wallet). This legacy path must never create one.
      if (isReservedMobileStationId(weatherData.stationId)) {
        res
          .status(400)
          .json(createApiError('INVALID_DATA', "stationId uses the reserved 'mob-' prefix"));
        return;
      }

      // Get or create weather station
      const stationQuery = `
      SELECT * FROM weather_stations WHERE id = $1 AND user_id = $2
    `;
      let stationResult = await client.query(stationQuery, [
        weatherData.stationId,
        userId,
      ]);

      let station: WeatherStation;
      if (stationResult.rows.length === 0) {
        // Create new station
        const createStationQuery = `
        INSERT INTO weather_stations (id, user_id, name, location, total_submissions, quality_score, last_submission, is_active)
        VALUES ($1, $2, $3, $4, 0, 0, NOW(), true)
        RETURNING *
      `;

        const location = weatherData.location || {
          lat: 0,
          lon: 0,
          name: 'Unknown',
        };
        stationResult = await client.query(createStationQuery, [
          weatherData.stationId,
          userId,
          `Station ${weatherData.stationId}`,
          JSON.stringify(location),
        ]);
      }

      station = stationResult.rows[0];

      // Calculate reward
      const rewardCalc = calculateEnhancedReward(weatherData, station);

      // Insert weather submission
      const submissionQuery = `
      INSERT INTO weather_submissions (
        user_id, station_id, temperature, humidity, pressure, wind_speed, 
        wind_direction, rainfall, quality_score, reward_amount, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `;

      const submissionResult = await client.query(submissionQuery, [
        userId,
        weatherData.stationId,
        weatherData.temperature_c,
        weatherData.humidity_percent,
        weatherData.pressure_hpa,
        weatherData.wind_speed_ms,
        weatherData.wind_direction_deg,
        weatherData.precipitation_mm,
        rewardCalc.qualityScore,
        rewardCalc.totalReward,
      ]);

      // Update station statistics
      const updateStationQuery = `
      UPDATE weather_stations 
      SET total_submissions = total_submissions + 1,
          quality_score = (quality_score * total_submissions + $1) / (total_submissions + 1),
          last_submission = NOW()
      WHERE id = $2 AND user_id = $3
    `;

      await client.query(updateStationQuery, [
        rewardCalc.qualityScore,
        weatherData.stationId,
        userId,
      ]);

      // Check for new achievements
      const newAchievements = await checkAchievements(
        userId,
        weatherData.stationId,
        client
      );

      await client.query('COMMIT');

      // Create lineage record for reward settlement (#213)
      let lineageId: string | null = null;
      let lineageRecordId: number | null = null;
      try {
        const contentHash = crypto
          .createHash('sha256')
          .update(JSON.stringify({
            userId,
            stationId: weatherData.stationId,
            temperature: weatherData.temperature_c,
            humidity: weatherData.humidity_percent,
            pressure: weatherData.pressure_hpa,
            timestamp: weatherData.timestamp,
          }))
          .digest('hex');

        const { lineageService } = await import('./services/lineage-service.js');

        // Look up most recent iot_ingestion lineage for this station (last 5 min)
        const parentRecord = await lineageService.getRecentByStationAndStage(
          weatherData.stationId,
          'iot_ingestion',
          5
        );

        const lineageRecord = await lineageService.createLineageRecord({
          stageId: 'reward_settlement',
          stationId: weatherData.stationId,
          contentHash,
          sourceType: 'weather_station',
          sourceReference: `reward:${userId}:${weatherData.stationId}`,
          parentLineageId: parentRecord?.lineageId || null,
          metadata: {
            userId,
            qualityScore: rewardCalc.qualityScore,
            totalReward: rewardCalc.totalReward,
          },
        });
        lineageId = lineageRecord.lineageId;
        lineageRecordId = lineageRecord.id;

        // Soft gate: warn if chain has integrity issues (should become hard gate after validation period)
        if (parentRecord) {
          const integrity = await lineageService.verifyIntegrity(lineageRecord.lineageId);
          if (!integrity.isIntact) {
            weatherLogger.warn('Lineage chain integrity issues detected for reward settlement', {
              lineageId: lineageRecord.lineageId,
              issues: integrity.issues,
              stationId: weatherData.stationId,
            });
          }
        }
      } catch (lineageErr) {
        weatherLogger.warn('Failed to create lineage record for reward settlement', {
          error: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
          stationId: weatherData.stationId,
        });
      }

      const reward: WeatherReward = {
        stationId: weatherData.stationId,
        amount: rewardCalc.totalReward as PositiveNumber,
        timestamp: new Date(),
        achievementTier: Math.floor(rewardCalc.qualityScore / 20),
        transactionHash:
          lineageId
            ? `0x${lineageId}` as `0x${string}`
            : `0x${Buffer.from(`${userId}_${weatherData.stationId}_${Date.now()}`).toString('hex').slice(0, 64)}` as `0x${string}`,
        blockNumber: lineageRecordId ?? Math.floor(Math.random() * 1000000) + 500000,
      };

      res.json(
        createApiResponse(reward, {
          rewardCalculation: rewardCalc,
          newAchievements: newAchievements.length,
          achievements: newAchievements,
          lineageId,
        })
      );
    } catch (error) {
      await client.query('ROLLBACK');
      weatherLogger.error('Error submitting weather data', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'SUBMISSION_ERROR',
            'Failed to process weather data submission',
            error
          )
        );
    } finally {
      client.release();
    }
  }
);

// Get user achievements
app.get(
  '/api/achievements/:userId',
  async (
    req: Request<{ userId: string }>,
    res: Response<ApiResult<UserAchievement[]>>
  ) => {
    try {
      const { userId } = req.params;

      const query = `
      SELECT ua.*, ad.name, ad.description, ad.icon, ad.title
      FROM user_achievements ua
      JOIN achievement_definitions ad ON ua.achievement_type = ad.type AND ua.level = ad.level
      WHERE ua.user_id = $1
      ORDER BY ua.unlocked_at DESC
    `;

      const result = await pool.query(query, [userId]);
      res.json(createApiResponse(result.rows));
    } catch (error) {
      weatherLogger.error('Error fetching achievements', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'ACHIEVEMENTS_ERROR',
            'Failed to fetch user achievements',
            error
          )
        );
    }
  }
);

// Get weather station statistics
app.get(
  '/api/stations/:userId',
  async (
    req: Request<{ userId: string }>,
    res: Response<ApiResult<WeatherStation[]>>
  ) => {
    try {
      const { userId } = req.params;

      const query = `
      SELECT * FROM weather_stations 
      WHERE user_id = $1 
      ORDER BY last_submission DESC
    `;

      const result = await pool.query(query, [userId]);
      res.json(createApiResponse(result.rows));
    } catch (error) {
      weatherLogger.error('Error fetching stations', { error: error instanceof Error ? error.message : String(error) });
      res
        .status(500)
        .json(
          createApiError(
            'STATIONS_ERROR',
            'Failed to fetch weather stations',
            error
          )
        );
    }
  }
);

// Health check
app.get(
  '/health',
  (
    req: Request,
    res: Response<ApiResult<{ status: string; timestamp: string }>>
  ) => {
    if (probeState.draining) {
      res.status(503).json(
        createApiError('SERVICE_DRAINING', 'Service is shutting down')
      );
      return;
    }
    res.json(
      createApiResponse({
        status: 'healthy',
        timestamp: new Date().toISOString(),
      })
    );
  }
);

app.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.set('Content-Type', prometheusRegistry.contentType);
    res.end(await prometheusRegistry.metrics());
  } catch (error) {
    weatherLogger.error('Failed to render Prometheus metrics', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).send('Failed to render metrics');
  }
});

// Error handler
app.use((error: Error, req: Request, res: Response, next: Function) => {
  weatherLogger.error('Unhandled error', { error: error.message });
  res.status(500).json(
    createApiError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    })
  );
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  weatherLogger.info(`Enhanced Weather Rewards Server (TypeScript) running on port ${PORT}`);
  weatherLogger.info(`Health check: http://0.0.0.0:${PORT}/health`);
  weatherLogger.info('Achievement system: Type-safe weather data rewards');
});

registerGracefulShutdown({
  serviceName: 'enhanced-weather-rewards',
  server,
  logger: weatherLogger,
  state: probeState,
  cleanupFns: [
    {
      name: 'enhanced-weather-rewards-db-pool',
      handler: async () => {
        await pool.end();
      },
    },
  ],
});

export default app;
