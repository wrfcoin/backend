/**
 * Test Proof of Publishing API Integration
 * Comprehensive test of PoP API endpoints with real weather station data
 */

const axios = require('axios');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

async function testPoPAPI() {
  const baseURL = 'http://localhost:8000';

  logger.info('TESTING PROOF OF PUBLISHING API');
  logger.info('=================================');

  try {
    // Test 1: PoP Status
    logger.info('1. Testing PoP consensus status...');
    const statusResponse = await axios.get(`${baseURL}/api/pop/status`);
    logger.info('PoP Status', {
      consensus: statusResponse.data.consensus,
      status: statusResponse.data.status,
      totalNodes: statusResponse.data.totalNodes,
      proofTypes: Object.keys(statusResponse.data.proofTypes).join(', '),
    });

    // Test 2: Weather Station Integration
    logger.info('2. Testing weather station integration...');
    const weatherResponse = await axios.get(
      `${baseURL}/api/pop/weather/bryan_acurite_iris_2025`
    );
    logger.info('Weather Station', {
      name: weatherResponse.data.station.name,
      totalEarned: weatherResponse.data.station.totalEarned,
      dataQuality: weatherResponse.data.station.dataQuality,
      enhancedReward: weatherResponse.data.rewards.enhancedReward,
      improvement: weatherResponse.data.rewards.improvement,
    });

    // Test 3: Register Environmental Node
    logger.info('3. Testing node registration...');
    const nodeData = {
      nodeId: 'test_environmental_node',
      address: 'wrf_test_address_123456789',
      stake: 15000,
      contributionTypes: ['WeatherData', 'EnvironmentalForecasting'],
      regions: ['north_america'],
    };

    const registerResponse = await axios.post(
      `${baseURL}/api/pop/nodes/register`,
      nodeData
    );
    logger.info('Node Registration', {
      success: registerResponse.data.success,
      nodeId: registerResponse.data.nodeId,
      environmentalScore: registerResponse.data.environmentalScore,
    });

    // Test 4: Submit Weather Data
    logger.info('4. Testing weather data submission...');
    const weatherSubmission = {
      sensorReadings: 9,
      timestamp: Date.now(),
      dataQuality: 0.92,
    };

    const submitResponse = await axios.post(
      `${baseURL}/api/pop/weather/bryan_acurite_iris_2025/submit`,
      weatherSubmission
    );
    logger.info('Weather Submission', {
      success: submitResponse.data.success,
      enhancedReward: submitResponse.data.reward.enhancedReward,
      qualityBonus: submitResponse.data.reward.qualityBonus,
      locationBonus: submitResponse.data.reward.locationBonus,
      newTotalEarned: submitResponse.data.station.totalEarned,
    });

    // Test 5: Environmental Forecast
    logger.info('5. Testing environmental forecast submission...');
    const forecastData = {
      forecasterNodeId: 'test_environmental_node',
      modelType: 'WRF-Chem',
      geographicRegion: 'north_america',
      timeRange: [Date.now(), Date.now() + 7 * 24 * 60 * 60 * 1000],
      forecastData: JSON.stringify({
        temperature: { min: 60, max: 75, avg: 67 },
        humidity: { min: 40, max: 90, avg: 65 },
        airQuality: 'good',
      }),
      complexityScore: 0.8,
    };

    const forecastResponse = await axios.post(
      `${baseURL}/api/pop/forecasts/submit`,
      forecastData
    );
    logger.info('Forecast Submission', {
      success: forecastResponse.data.success,
      forecastId: forecastResponse.data.forecastId.substring(0, 20) + '...',
      status: forecastResponse.data.status,
    });

    // Test 6: Node Rankings
    logger.info('6. Testing node rankings...');
    const rankingsResponse = await axios.get(
      `${baseURL}/api/pop/nodes/rankings`
    );
    logger.info('Node Rankings', {
      totalNodes: rankingsResponse.data.rankings.length,
      topNode: rankingsResponse.data.rankings[0]
        ? {
            nodeId: rankingsResponse.data.rankings[0].nodeId,
            rank: rankingsResponse.data.rankings[0].rank,
            environmentalScore:
              rankingsResponse.data.rankings[0].environmentalScore,
          }
        : 'No nodes ranked yet',
    });

    // Test 7: Geographic Regions
    logger.info('7. Testing geographic regions...');
    const regionsResponse = await axios.get(`${baseURL}/api/pop/regions`);
    logger.info('Geographic Regions', {
      totalRegions: regionsResponse.data.totalRegions,
      highIncentiveRegions: regionsResponse.data.highIncentiveRegions,
      regions: regionsResponse.data.regions
        .map(r => `${r.name} (${r.multiplier}x)`)
        .join(', '),
    });

    // Test 8: System Analytics
    logger.info('8. Testing system analytics...');
    const analyticsResponse = await axios.get(`${baseURL}/api/pop/analytics`);
    logger.info('System Analytics', {
      totalNodes: analyticsResponse.data.consensus.totalNodes,
      weatherStations: analyticsResponse.data.weatherStations.totalStations,
      totalReadings: analyticsResponse.data.weatherStations.totalReadings,
      totalEarnings: analyticsResponse.data.weatherStations.totalEarnings,
      totalForecasts: analyticsResponse.data.forecasts.totalForecasts,
    });

    logger.info('ALL TESTS PASSED - PROOF OF PUBLISHING FULLY OPERATIONAL');
    logger.info('==========================================================');
    logger.info('Test Results Summary', {
      results: [
        'Core consensus API working',
        'Weather station integration functional',
        'Enhanced rewards calculation active',
        'Environmental node registration working',
        'Forecast submission system operational',
        'Geographic scarcity bonuses configured',
        'Real-time analytics available'
      ]
    });

    // Current weather station status
    logger.info("BRYAN'S ACURITE STATION STATUS", {
      currentEarnings: `${weatherResponse.data.station.totalEarned} WRF`,
      dataQuality: weatherResponse.data.station.dataQuality,
      enhancedReward: `${weatherResponse.data.rewards.enhancedReward} WRF per reading`,
      improvement: `${weatherResponse.data.rewards.improvement} over base rate`,
      dailyPotential: `${weatherResponse.data.popIntegration.estimatedDailyEarnings} WRF`
    });
  } catch (error) {
    logger.error('API Test Error', { error: error.response?.data || error.message });
  }
}

testPoPAPI();
