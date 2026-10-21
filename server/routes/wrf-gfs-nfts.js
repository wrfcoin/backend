const express = require('express');
const router = express.Router();
const { randomBytes } = require('crypto');
const { requireAuth } = require('../middleware/authMiddleware');

// All NFT operations require authentication (#231)
router.use(requireAuth);

// WRF/GFS Computational NFT endpoints
router.get('/forecast-models', (req, res) => {
  const models = [
    {
      id: 'wrf-chem',
      name: 'WRF-Chem',
      description: 'Atmospheric chemistry and air quality forecasting',
      complexity: 'High',
      baseReward: 250,
      specialties: ['Air Quality', 'Pollution Transport', 'Chemical Reactions'],
      accuracy: '94.2%',
      lastRun: new Date().toISOString(),
    },
    {
      id: 'wrf-fire',
      name: 'WRF-Fire',
      description: 'Wildfire behavior prediction and smoke modeling',
      complexity: 'Very High',
      baseReward: 350,
      specialties: ['Fire Weather', 'Smoke Dispersion', 'Fire Behavior'],
      accuracy: '91.8%',
      lastRun: new Date().toISOString(),
    },
    {
      id: 'gfs',
      name: 'GFS (Global Forecast System)',
      description: 'Global weather prediction model',
      complexity: 'Medium',
      baseReward: 180,
      specialties: [
        'Global Weather',
        'Medium-range Forecasts',
        'Synoptic Patterns',
      ],
      accuracy: '96.1%',
      lastRun: new Date().toISOString(),
    },
  ];

  res.json({
    success: true,
    models,
    totalModels: models.length,
    timestamp: new Date().toISOString(),
  });
});

router.get('/data-sources', (req, res) => {
  const dataSources = [
    {
      id: 'noaa-stations',
      name: 'NOAA Weather Stations',
      multiplier: 1.5,
      quality: 'Very High',
      coverage: 'Global',
      cost: 45,
      activeStations: 89562,
      countries: 167,
    },
    {
      id: 'openaq',
      name: 'OpenAQ Sensor Network',
      multiplier: 1.3,
      quality: 'High',
      coverage: 'Urban Areas',
      cost: 25,
      activeStations: 12847,
      countries: 98,
    },
    {
      id: 'iot-mesh',
      name: 'IoT Weather Mesh',
      multiplier: 1.6,
      quality: 'High',
      coverage: 'Real-time',
      cost: 35,
      activeStations: 25603,
      countries: 45,
    },
  ];

  res.json({
    success: true,
    dataSources,
    totalSources: dataSources.length,
    totalStations: dataSources.reduce(
      (sum, source) => sum + source.activeStations,
      0
    ),
  });
});

router.post('/create-recipe', (req, res) => {
  const { model, datasets, computeEnvironment, validation, configuration } =
    req.body;

  // Calculate cost estimate
  const baseReward =
    model === 'wrf-fire' ? 350 : model === 'wrf-chem' ? 250 : 180;
  const datasetMultiplier = datasets.length * 1.2;
  const computeMultiplier = computeEnvironment === 'local-wrf' ? 2.0 : 1.5;
  const totalCost = baseReward * datasetMultiplier * computeMultiplier;

  const recipe = {
    id: `WRF-${Date.now()}`,
    model,
    datasets,
    computeEnvironment,
    validation,
    configuration,
    estimatedCost: totalCost.toFixed(2),
    status: 'pending',
    createdAt: new Date().toISOString(),
    estimatedCompletion: new Date(
      Date.now() + 4 * 60 * 60 * 1000
    ).toISOString(),
    ipfsHash: 'QmX' + randomBytes(5).toString('hex'),
  };

  res.json({
    success: true,
    recipe,
    message: 'Computational NFT recipe created successfully',
  });
});

router.get('/active-forecasts', (req, res) => {
  const forecasts = [
    {
      id: 'WRF-HURRICANE-001',
      model: 'WRF-ARW',
      type: 'Hurricane Track',
      region: 'Atlantic Basin',
      accuracy: 94.2,
      status: 'processing',
      completion: 75,
      estimatedValue: 420,
    },
    {
      id: 'GFS-TEMP-002',
      model: 'GFS',
      type: 'Temperature Forecast',
      region: 'North America',
      accuracy: 96.1,
      status: 'validating',
      completion: 95,
      estimatedValue: 280,
    },
    {
      id: 'WRF-FIRE-003',
      model: 'WRF-Fire',
      type: 'Wildfire Risk',
      region: 'California',
      accuracy: 91.8,
      status: 'completed',
      completion: 100,
      estimatedValue: 510,
    },
  ];

  res.json({
    success: true,
    forecasts,
    totalForecasts: forecasts.length,
    totalValue: forecasts.reduce((sum, f) => sum + f.estimatedValue, 0),
  });
});

router.get('/contributor-stats', (req, res) => {
  const stats = {
    totalContributors: 1247,
    activeForecasts: 89,
    completedNFTs: 2847,
    totalRewardsDistributed: 125680,
    accuracy: {
      average: 94.7,
      expertTier: 96.2,
      proficientTier: 93.1,
    },
    breakdown: {
      dataContributors: 374,
      computeProviders: 156,
      dataKeepers: 298,
      validators: 419,
    },
  };

  res.json({
    success: true,
    stats,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
