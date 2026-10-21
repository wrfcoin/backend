// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * Proof of Publishing API Server
 * Provides RESTful endpoints for PoP consensus, environmental scoring, and weather rewards
 */

const express = require('express');
const cors = require('cors');
const { appLogger } = require('./utils/logger');
const { requireOperatorToken } = require('./middleware/operator-token-auth.js');
const app = express();

// Middleware
app.use(cors({
  origin: resolveAllowedOrigins({ developmentDefaults: ['http://localhost:5000', 'http://localhost:3000'] }),
  credentials: true,
}));
app.use(express.json());

// In-memory storage for demo (replace with database in production)
const environmentalNodes = new Map();
const weatherStations = new Map();
const environmentalForecasts = new Map();
const rewardHistory = [];

// Geographic regions with scarcity multipliers
const geographicRegions = {
  amazon_rainforest: {
    name: 'Amazon Rainforest',
    multiplier: 3.0,
    priority: 1.0,
  },
  arctic_region: { name: 'Arctic Region', multiplier: 2.5, priority: 0.9 },
  sahara_desert: { name: 'Sahara Desert', multiplier: 2.0, priority: 0.8 },
  north_america: { name: 'North America', multiplier: 1.0, priority: 0.6 },
  europe: { name: 'Europe', multiplier: 1.0, priority: 0.6 },
};

// Initialize Bryan's weather station
weatherStations.set('bryan_acurite_iris_2025', {
  id: 'bryan_acurite_iris_2025',
  name: "Bryan's AcuRite Iris® 2025",
  address: 'wrf717d72395303fcb2aed4df368f32f1078d18e9cc',
  location: [40.7128, -74.006],
  region: 'north_america',
  dataQuality: 0.85,
  locationVerified: true,
  totalSubmissions: 18,
  successfulSubmissions: 18,
  totalEarned: 1.8,
  lastReading: Date.now(),
  status: 'active',
});

// ===============================
// PROOF OF PUBLISHING ENDPOINTS
// ===============================

/**
 * Get PoP consensus status and metrics
 */
app.get('/api/pop/status', (req, res) => {
  const totalNodes = environmentalNodes.size;
  const activeNodes = Array.from(environmentalNodes.values()).filter(
    n => n.active
  ).length;
  const totalEnvironmentalScore = Array.from(
    environmentalNodes.values()
  ).reduce((sum, node) => sum + node.environmentalScore, 0);

  res.json({
    consensus: 'proof_of_publishing',
    status: 'operational',
    totalNodes,
    activeNodes,
    totalEnvironmentalScore: parseFloat(totalEnvironmentalScore.toFixed(3)),
    proofTypes: {
      usefulness: {
        weight: 35,
        description: 'Environmental forecasting and computation',
      },
      information: { weight: 25, description: 'Data quality validation' },
      location: { weight: 20, description: 'Geographic verification' },
      publishing: {
        weight: 20,
        description: 'Environmental report publication',
      },
    },
    geographicRegions: Object.keys(geographicRegions).length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get environmental node rankings
 */
app.get('/api/pop/nodes/rankings', (req, res) => {
  const rankedNodes = Array.from(environmentalNodes.values())
    .sort((a, b) => b.environmentalScore - a.environmentalScore)
    .map((node, index) => ({
      rank: index + 1,
      nodeId: node.id,
      address: node.address,
      environmentalScore: parseFloat(node.environmentalScore.toFixed(3)),
      usefulnessScore: parseFloat(node.usefulnessScore.toFixed(3)),
      informationScore: parseFloat(node.informationScore.toFixed(3)),
      locationScore: parseFloat(node.locationScore.toFixed(3)),
      publishingScore: parseFloat(node.publishingScore.toFixed(3)),
      reputation: parseFloat(node.reputation.toFixed(3)),
      regions: Array.from(node.regions),
      contributionTypes: Array.from(node.contributionTypes),
      totalRewards: node.totalRewards,
      blocksProduced: node.blocksProduced,
      active: node.active,
    }));

  res.json({
    rankings: rankedNodes,
    totalScore: rankedNodes.reduce(
      (sum, node) => sum + node.environmentalScore,
      0
    ),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Register environmental node
 */
app.post('/api/pop/nodes/register', requireOperatorToken, (req, res) => {
  const { nodeId, address, stake, contributionTypes, regions } = req.body;

  if (!nodeId || !address || !stake) {
    return res
      .status(400)
      .json({ error: 'Missing required fields: nodeId, address, stake' });
  }

  const node = {
    id: nodeId,
    address,
    stake,
    contributionTypes: new Set(contributionTypes || []),
    regions: new Set(regions || []),
    environmentalScore: 0.0,
    usefulnessScore: 0.0,
    informationScore: 0.0,
    locationScore: 0.0,
    publishingScore: 0.0,
    reputation: 1.0,
    active: true,
    lastBlockHeight: 0,
    blocksProduced: 0,
    totalRewards: 0,
    registeredAt: Date.now(),
  };

  environmentalNodes.set(nodeId, node);

  res.json({
    success: true,
    nodeId,
    environmentalScore: node.environmentalScore,
    message: 'Environmental node registered successfully',
  });
});

// ===============================
// WEATHER STATION ENDPOINTS
// ===============================

/**
 * Get weather station status and enhanced rewards
 */
app.get('/api/pop/weather/:stationId', (req, res) => {
  const { stationId } = req.params;
  const station = weatherStations.get(stationId);

  if (!station) {
    return res.status(404).json({ error: 'Weather station not found' });
  }

  const region = geographicRegions[station.region];
  const baseReward = 0.1;
  const qualityBonus = station.dataQuality * 0.1;
  const locationBonus = station.locationVerified ? 0.05 : 0;
  const enhancedReward = baseReward * (1 + qualityBonus + locationBonus);
  const improvement = ((enhancedReward - baseReward) / baseReward) * 100;

  res.json({
    station: {
      ...station,
      region: region.name,
      scarcityMultiplier: region.multiplier,
    },
    rewards: {
      baseReward,
      qualityBonus: parseFloat(qualityBonus.toFixed(4)),
      locationBonus: parseFloat(locationBonus.toFixed(4)),
      enhancedReward: parseFloat(enhancedReward.toFixed(4)),
      improvement: parseFloat(improvement.toFixed(1)) + '%',
    },
    popIntegration: {
      readyForEnhancement: true,
      estimatedDailyEarnings: parseFloat((enhancedReward * 1440).toFixed(2)), // 24h * 60min
      potentialYearlyIncrease: parseFloat(
        ((improvement * station.totalEarned * 365) / 100).toFixed(2)
      ),
    },
  });
});

/**
 * Submit weather data for PoP rewards
 */
app.post('/api/pop/weather/:stationId/submit', requireOperatorToken, (req, res) => {
  const { stationId } = req.params;
  const { sensorReadings, timestamp, dataQuality } = req.body;

  const station = weatherStations.get(stationId);
  if (!station) {
    return res.status(404).json({ error: 'Weather station not found' });
  }

  // Update station metrics
  station.totalSubmissions++;
  station.successfulSubmissions++;
  station.lastReading = timestamp || Date.now();

  // Update data quality with exponential moving average
  if (dataQuality) {
    const alpha = 0.1;
    station.dataQuality =
      alpha * dataQuality + (1.0 - alpha) * station.dataQuality;
  }

  // Calculate enhanced reward
  const region = geographicRegions[station.region];
  const baseReward = 0.1;
  const qualityBonus = station.dataQuality * 0.1;
  const locationBonus = station.locationVerified ? 0.05 : 0;
  const regionalMultiplier = region.multiplier;
  const enhancedReward =
    baseReward * (1 + qualityBonus + locationBonus) * regionalMultiplier;

  station.totalEarned += enhancedReward;

  // Record reward
  const rewardRecord = {
    stationId,
    timestamp: Date.now(),
    sensorReadings: sensorReadings || 9,
    baseReward,
    qualityBonus,
    locationBonus,
    regionalMultiplier,
    enhancedReward,
    totalEarned: station.totalEarned,
  };

  rewardHistory.push(rewardRecord);

  res.json({
    success: true,
    transactionId: `tx_weather_pop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    reward: rewardRecord,
    station: {
      dataQuality: parseFloat(station.dataQuality.toFixed(3)),
      totalEarned: parseFloat(station.totalEarned.toFixed(4)),
      totalSubmissions: station.totalSubmissions,
    },
  });
});

// ===============================
// ENVIRONMENTAL FORECASTING
// ===============================

/**
 * Submit environmental forecast
 */
app.post('/api/pop/forecasts/submit', requireOperatorToken, (req, res) => {
  const {
    forecasterNodeId,
    modelType,
    geographicRegion,
    timeRange,
    forecastData,
    complexityScore,
  } = req.body;

  const node = environmentalNodes.get(forecasterNodeId);
  if (!node) {
    return res.status(404).json({ error: 'Forecaster node not found' });
  }

  const forecastId = `forecast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const forecast = {
    id: forecastId,
    forecaster: forecasterNodeId,
    modelType: modelType || 'WRF-Chem',
    geographicRegion,
    timeRange,
    forecastData,
    complexityScore: complexityScore || 0.75,
    timestamp: Date.now(),
    status: 'pending_verification',
  };

  environmentalForecasts.set(forecastId, forecast);

  res.json({
    success: true,
    forecastId,
    status: 'submitted',
    estimatedVerificationTime: '24-48 hours',
    potentialReward: 'Based on accuracy and complexity',
  });
});

/**
 * Get forecast verification status
 */
app.get('/api/pop/forecasts/:forecastId', (req, res) => {
  const { forecastId } = req.params;
  const forecast = environmentalForecasts.get(forecastId);

  if (!forecast) {
    return res.status(404).json({ error: 'Forecast not found' });
  }

  res.json({
    forecast,
    node: environmentalNodes.get(forecast.forecaster),
  });
});

// ===============================
// GEOGRAPHIC REGIONS
// ===============================

/**
 * Get geographic regions and scarcity bonuses
 */
app.get('/api/pop/regions', (req, res) => {
  const regions = Object.entries(geographicRegions).map(([id, region]) => ({
    id,
    ...region,
    dataScarcity: region.multiplier > 1 ? 'high' : 'normal',
    incentiveLevel:
      region.multiplier >= 2.5
        ? 'maximum'
        : region.multiplier >= 2
          ? 'high'
          : 'standard',
  }));

  res.json({
    regions,
    totalRegions: regions.length,
    highIncentiveRegions: regions.filter(r => r.multiplier > 1).length,
  });
});

// ===============================
// ANALYTICS AND METRICS
// ===============================

/**
 * Get PoP system analytics
 */
app.get('/api/pop/analytics', (req, res) => {
  const nodes = Array.from(environmentalNodes.values());
  const stations = Array.from(weatherStations.values());

  const analytics = {
    consensus: {
      totalNodes: nodes.length,
      activeNodes: nodes.filter(n => n.active).length,
      averageEnvironmentalScore:
        nodes.length > 0
          ? parseFloat(
              (
                nodes.reduce((sum, n) => sum + n.environmentalScore, 0) /
                nodes.length
              ).toFixed(3)
            )
          : 0,
    },
    weatherStations: {
      totalStations: stations.length,
      activeStations: stations.filter(s => s.status === 'active').length,
      totalReadings: stations.reduce((sum, s) => sum + s.totalSubmissions, 0),
      totalEarnings: parseFloat(
        stations.reduce((sum, s) => sum + s.totalEarned, 0).toFixed(4)
      ),
      averageDataQuality:
        stations.length > 0
          ? parseFloat(
              (
                stations.reduce((sum, s) => sum + s.dataQuality, 0) /
                stations.length
              ).toFixed(3)
            )
          : 0,
    },
    forecasts: {
      totalForecasts: environmentalForecasts.size,
      pendingVerification: Array.from(environmentalForecasts.values()).filter(
        f => f.status === 'pending_verification'
      ).length,
    },
    rewards: {
      totalRewards: rewardHistory.length,
      totalValue: parseFloat(
        rewardHistory.reduce((sum, r) => sum + r.enhancedReward, 0).toFixed(4)
      ),
      averageReward:
        rewardHistory.length > 0
          ? parseFloat(
              (
                rewardHistory.reduce((sum, r) => sum + r.enhancedReward, 0) /
                rewardHistory.length
              ).toFixed(4)
            )
          : 0,
    },
  };

  res.json(analytics);
});

// ===============================
// SERVER STARTUP
// ===============================

const PORT = process.env.POP_API_PORT || 8000;

app.listen(PORT, '0.0.0.0', () => {
  appLogger.info('Proof of Publishing API Server running', { module: 'PoP', operation: 'serverStart', port: PORT });
  appLogger.info('Environmental consensus endpoint available', { module: 'PoP', operation: 'serverStart', url: `http://localhost:${PORT}/api/pop/status` });
  appLogger.info('Weather station API available', { module: 'PoP', operation: 'serverStart', url: `http://localhost:${PORT}/api/pop/weather/bryan_acurite_iris_2025` });
  appLogger.info('System analytics available', { module: 'PoP', operation: 'serverStart', url: `http://localhost:${PORT}/api/pop/analytics` });
  appLogger.info('Geographic regions available', { module: 'PoP', operation: 'serverStart', url: `http://localhost:${PORT}/api/pop/regions` });
});

module.exports = app;
