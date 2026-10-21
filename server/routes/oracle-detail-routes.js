/**
 * Oracle Network Detailed API Routes
 *
 * These routes provide data for the Oracle Network Dashboard and validator reputation display
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { generalLimiter } = require('../../middleware/rateLimiting');
const { pool } = require('../db');

// All oracle detail operations require authentication (#231)
router.use(requireAuth);
// Rate limit oracle detail endpoints (#237)
router.use(generalLimiter);
const { ClimateOracleNetwork } = require('../oracle/climate-oracle-network');
const { blockchainLogger } = require('../utils/logger');

// backend#1315: submissions belong to the guarded oracle-submit-routes router,
// mounted by the primary API. This dashboard router also mounts in server.js;
// it deliberately exposes no legacy submit-data handler there.

// Create a singleton instance if not already created
const climateOracleNetwork =
  global.climateOracleNetwork || new ClimateOracleNetwork();
if (!global.climateOracleNetwork) {
  global.climateOracleNetwork = climateOracleNetwork;

  // Ensure the network is initialized
  (async () => {
    try {
      blockchainLogger.info('Initializing Climate Oracle Network', { service: 'oracle-detail-routes' });
      await climateOracleNetwork.initialize();
      blockchainLogger.info('Climate Oracle Network initialized successfully', { service: 'oracle-detail-routes' });
    } catch (error) {
      blockchainLogger.error('Failed to initialize Climate Oracle Network', { error: { message: error.message, stack: error.stack } });
    }
  })();
}

/**
 * GET /api/oracle/status
 *
 * Returns the current status of the Climate Oracle Network
 */
router.get('/status', async (req, res) => {
  try {
    blockchainLogger.info('Oracle status endpoint accessed', { service: 'oracle-detail-routes' });
    // Return static data for the Oracle Dashboard
    const status = {
      status: 'active',
      totalDataPoints: 2367429,
      averageAccuracy: 0.957,
      lastUpdateTime: new Date().toISOString(),
      activeValidatorCount: 7,
      pendingRequests: 14,
      processedRequestsLast24h: 2874,
      reputationThreshold: 0.85,
      networkLatency: 2.3,
      consensusLevel: 'high',
      stakingTotal: 4850000,
      dataVerificationRate: 0.993,
      crossChainBridgesCount: 5,
      activeBridgesCount: 4,
    };

    res.json(status);
  } catch (error) {
    blockchainLogger.error('Error fetching oracle status', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch oracle network status' });
  }
});

/**
 * GET /api/oracle/validators
 *
 * Returns list of validators participating in the oracle network
 */
router.get('/validators', async (req, res) => {
  try {
    blockchainLogger.info('Oracle validators endpoint accessed', { service: 'oracle-detail-routes' });
    // Return static validator data with enhanced information
    const validators = [
      {
        id: 1,
        name: 'MeteoCore Validator',
        status: 'ACTIVE',
        accuracy: 0.982,
        responseTime: 873,
        reliability: 0.995,
        stake: 750000,
        uptime: 0.9998,
        dataPointsSubmitted: 392481,
        verifiedPredictions: 98.6,
        specialties: ['temperature', 'precipitation', 'wind'],
      },
      {
        id: 2,
        name: 'ClimateGuard Node',
        status: 'ACTIVE',
        accuracy: 0.967,
        responseTime: 912,
        reliability: 0.988,
        stake: 685000,
        uptime: 0.997,
        dataPointsSubmitted: 347692,
        verifiedPredictions: 97.2,
        specialties: ['humidity', 'air quality', 'temperature'],
      },
      {
        id: 3,
        name: 'AtmosVerify',
        status: 'ACTIVE',
        accuracy: 0.978,
        responseTime: 754,
        reliability: 0.992,
        stake: 825000,
        uptime: 0.9985,
        dataPointsSubmitted: 405317,
        verifiedPredictions: 98.8,
        specialties: ['pressure systems', 'storm modeling', 'humidity'],
      },
      {
        id: 4,
        name: 'WeatherChain Labs',
        status: 'ACTIVE',
        accuracy: 0.971,
        responseTime: 689,
        reliability: 0.989,
        stake: 720000,
        uptime: 0.996,
        dataPointsSubmitted: 367529,
        verifiedPredictions: 97.9,
        specialties: ['precipitation', 'snow modeling', 'flood prediction'],
      },
      {
        id: 5,
        name: 'GeoClimate Oracle',
        status: 'ACTIVE',
        accuracy: 0.963,
        responseTime: 932,
        reliability: 0.981,
        stake: 650000,
        uptime: 0.9945,
        dataPointsSubmitted: 312478,
        verifiedPredictions: 96.7,
        specialties: ['temperature', 'air quality', 'heat waves'],
      },
      {
        id: 6,
        name: 'SkyData Validator',
        status: 'ACTIVE',
        accuracy: 0.949,
        responseTime: 1021,
        reliability: 0.977,
        stake: 575000,
        uptime: 0.993,
        dataPointsSubmitted: 284519,
        verifiedPredictions: 95.8,
        specialties: ['cloud patterns', 'visibility', 'fog prediction'],
      },
      {
        id: 7,
        name: 'ClimateConsensus',
        status: 'ACTIVE',
        accuracy: 0.944,
        responseTime: 1067,
        reliability: 0.973,
        stake: 645000,
        uptime: 0.9925,
        dataPointsSubmitted: 301456,
        verifiedPredictions: 95.3,
        specialties: ['storm tracking', 'wind patterns', 'cyclone modeling'],
      },
      {
        id: 8,
        name: 'PressurePoint Node',
        status: 'INACTIVE',
        accuracy: 0.923,
        responseTime: 1246,
        reliability: 0.941,
        stake: 460000,
        uptime: 0.979,
        dataPointsSubmitted: 215982,
        verifiedPredictions: 93.1,
        specialties: [
          'pressure systems',
          'barometric analysis',
          'synoptic charts',
        ],
      },
      {
        id: 9,
        name: 'TempTracker Validator',
        status: 'INACTIVE',
        accuracy: 0.917,
        responseTime: 1318,
        reliability: 0.932,
        stake: 420000,
        uptime: 0.976,
        dataPointsSubmitted: 197624,
        verifiedPredictions: 92.5,
        specialties: [
          'temperature anomalies',
          'heat records',
          'thermal patterns',
        ],
      },
      {
        id: 10,
        name: 'EcoClimate Oracle',
        status: 'PENDING',
        accuracy: 0.937,
        responseTime: 1105,
        reliability: 0.961,
        stake: 550000,
        uptime: 0.988,
        dataPointsSubmitted: 0,
        verifiedPredictions: 0,
        specialties: [
          'biodiversity impacts',
          'ecological monitoring',
          'habitat analysis',
        ],
      },
    ];

    const activeCount = validators.filter(v => v.status === 'ACTIVE').length;

    res.json({
      validators,
      totalCount: validators.length,
      activeCount,
    });
  } catch (error) {
    blockchainLogger.error('Error fetching validators', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch validators' });
  }
});

/**
 * GET /api/oracle/validators/:id
 *
 * Returns detailed information about a specific validator
 */
router.get('/validators/:id', async (req, res) => {
  try {
    const validatorId = req.params.id;

    // Try to find the validator - handle both numeric and string IDs
    const validator = await climateOracleNetwork.getValidatorById(validatorId);

    if (!validator) {
      return res.status(404).json({ error: 'Validator not found' });
    }

    // Get additional reputation metrics for this validator
    const reputationData =
      await climateOracleNetwork.getValidatorReputation(validatorId);

    // Combine base validator data with reputation metrics
    const detailedValidator = {
      ...validator,
      ...reputationData,
      dataPoints:
        await climateOracleNetwork.getValidatorDataPoints(validatorId),
      verifiedPredictions:
        await climateOracleNetwork.getValidatorVerifiedPredictions(validatorId),
      historyLength:
        await climateOracleNetwork.getValidatorHistoryLength(validatorId),
      specialties:
        await climateOracleNetwork.getValidatorSpecialties(validatorId),
    };

    res.json(detailedValidator);
  } catch (error) {
    blockchainLogger.error('Error fetching validator', { validatorId: req.params.id, error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch validator details' });
  }
});

/**
 * GET /api/oracle/data-submissions
 *
 * Returns recent data submissions to the oracle network
 */
router.get('/data-submissions', async (req, res) => {
  try {
    blockchainLogger.info('Oracle data submissions endpoint accessed', { service: 'oracle-detail-routes' });

    const { oracle_id, station_id } = req.query;
    let submissions = [];

    // Query real data from weather_submissions table
    try {
      const filterValue = station_id || oracle_id;
      const sql = filterValue
        ? `SELECT id, station_id, temperature, pressure, humidity, quality_score,
             reward_amount, source, submitted_at
           FROM weather_submissions WHERE station_id = $1
           ORDER BY submitted_at DESC LIMIT 50`
        : `SELECT id, station_id, temperature, pressure, humidity, quality_score,
             reward_amount, source, submitted_at
           FROM weather_submissions
           ORDER BY submitted_at DESC LIMIT 50`;
      const params = filterValue ? [filterValue] : [];

      const result = await pool.query(sql, params);
      if (result.rows && result.rows.length > 0) {
        submissions = result.rows.map(row => ({
          id: `sub-${row.id}`,
          timestamp: row.submitted_at,
          type: row.temperature != null ? 'temperature' : row.pressure != null ? 'pressure' : 'humidity',
          location: row.station_id || 'unknown',
          status: (row.quality_score || 0) >= 50 ? 'verified' : 'pending',
          confidence: Number(((row.quality_score || 0) / 100).toFixed(2)),
          validations: Math.max(1, Math.floor((row.quality_score || 0) / 15)),
        }));
      }
    } catch (dbError) {
      blockchainLogger.warn('DB query failed for data-submissions, returning empty state', {
        error: dbError.message,
      });
    }

    res.json(submissions);
  } catch (error) {
    blockchainLogger.error('Error fetching data submissions', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch data submissions' });
  }
});

/**
 * GET /api/oracle/bridges
 *
 * Returns status of cross-chain bridges used by the oracle network
 */
router.get('/bridges', (req, res) => {
  blockchainLogger.info('Oracle bridges endpoint accessed', { service: 'oracle-detail-routes' });
  // Enhanced static bridges response with more data and variety
  res.json({
    bridges: [
      {
        id: 'bridge-1',
        name: 'Ethereum Climate Bridge',
        provider: 'LayerZero',
        status: 'online',
        sourceChain: 'wrfcoin',
        targetChain: 'ethereum',
        lastSync: new Date(Date.now() - 120000).toISOString(),
        transactionsLast24h: 142,
        totalDataPoints: 8756,
        latency: 2.3,
        network: 'Ethereum',
        lastSync: new Date(Date.now() - 120000).toISOString(),
      },
      {
        id: 'bridge-2',
        name: 'Cosmos Weather Oracle',
        provider: 'IBC',
        status: 'online',
        sourceChain: 'wrfcoin',
        targetChain: 'cosmos-hub',
        lastSync: new Date(Date.now() - 300000).toISOString(),
        transactionsLast24h: 87,
        totalDataPoints: 5421,
        latency: 3.1,
        network: 'Cosmos',
        lastSync: new Date(Date.now() - 300000).toISOString(),
      },
      {
        id: 'bridge-3',
        name: 'Solana Weather Data Bridge',
        provider: 'Wormhole',
        status: 'online',
        sourceChain: 'wrfcoin',
        targetChain: 'solana',
        lastSync: new Date(Date.now() - 450000).toISOString(),
        transactionsLast24h: 64,
        totalDataPoints: 3982,
        latency: 1.8,
        network: 'Solana',
        lastSync: new Date(Date.now() - 450000).toISOString(),
      },
      {
        id: 'bridge-4',
        name: 'Avalanche Climate Feed',
        provider: 'Axelar',
        status: 'offline',
        sourceChain: 'wrfcoin',
        targetChain: 'avalanche',
        lastSync: new Date(Date.now() - 86400000).toISOString(),
        transactionsLast24h: 0,
        totalDataPoints: 2841,
        latency: null,
        network: 'Avalanche',
        lastSync: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'bridge-5',
        name: 'Binance Smart Chain Oracle',
        provider: 'Synapse',
        status: 'online',
        sourceChain: 'wrfcoin',
        targetChain: 'bsc',
        lastSync: new Date(Date.now() - 180000).toISOString(),
        transactionsLast24h: 118,
        totalDataPoints: 6423,
        latency: 2.8,
        network: 'BSC',
        lastSync: new Date(Date.now() - 180000).toISOString(),
      },
    ],
    totalCount: 5,
    activeCount: 4,
  });
});

/**
 * GET /api/oracle/leaderboard
 *
 * Returns oracle validator leaderboard ranked by reputation.
 * Query params:
 *   - limit (number, default 50, max 200)
 *
 * Response shape matches frontend useOracleLeaderboard hook and may include
 * an empty-state message when no validators are registered:
 *   { entries: [{ oracle_id, reputation_score, reputation_pct, tier }], total_oracles, total?, message? }
 */
router.get('/leaderboard', async (req, res) => {
  try {
    blockchainLogger.info('Oracle leaderboard endpoint accessed', { service: 'oracle-detail-routes' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    let entries = [];
    let totalOracles = 0;

    // Try to aggregate real data from validator_oracle_participation table.
    try {
      const result = await pool.query(
        `SELECT
           "validatorId" AS oracle_id,
           COUNT(*)::int AS participation_count,
           COALESCE(AVG(accuracy), 0) AS avg_accuracy,
           COALESCE(SUM("rewardAmount"), 0) AS total_rewards
         FROM validator_oracle_participation
         GROUP BY "validatorId"
         ORDER BY avg_accuracy DESC, total_rewards DESC
         LIMIT $1`,
        [limit],
      );

      if (result.rows && result.rows.length > 0) {
        const countResult = await pool.query(
          'SELECT COUNT(DISTINCT "validatorId")::int AS total FROM validator_oracle_participation',
        );
        totalOracles = countResult.rows[0]?.total || result.rows.length;

        entries = result.rows.map((row) => {
          const pct = Math.round(Number(row.avg_accuracy) * 10000) / 100; // 0-100 with 2 decimals
          const score = Math.round(pct * 10000); // 0-1_000_000
          return {
            oracle_id: row.oracle_id,
            reputation_score: score,
            reputation_pct: pct,
            tier: tierFromPct(pct),
          };
        });
      }
    } catch (dbError) {
      blockchainLogger.warn('DB query failed for leaderboard, falling back to oracle network registry', {
        error: dbError.message,
      });
      const validators = await climateOracleNetwork.getValidators();
      totalOracles = validators.length;
      entries = await Promise.all(
        validators.slice(0, limit).map(async validator => {
          const reputation = await climateOracleNetwork.getValidatorReputation(validator.id);
          const rawScore =
            reputation?.reputationScore ??
            reputation?.reputation_score ??
            validator.reputationScore ??
            validator.reputation_score ??
            0;
          const pct = rawScore <= 1 ? Math.round(rawScore * 10000) / 100 : rawScore;
          return {
            oracle_id: validator.name || String(validator.id),
            reputation_score: Math.round(pct * 10000),
            reputation_pct: pct,
            tier: tierFromPct(pct),
          };
        })
      );
    }

    const response = {
      entries,
      total_oracles: totalOracles,
      total: totalOracles,
    };

    if (entries.length === 0 && totalOracles === 0) {
      response.message = 'No validators registered yet';
    }

    res.json(response);
  } catch (error) {
    blockchainLogger.error('Error fetching oracle leaderboard', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch oracle leaderboard' });
  }
});

/** Map a reputation percentage (0-100) to a tier name. */
function tierFromPct(pct) {
  if (pct >= 95) return 'Platinum';
  if (pct >= 85) return 'Gold';
  if (pct >= 70) return 'Silver';
  return 'Bronze';
}

module.exports = router;
