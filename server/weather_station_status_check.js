// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

#!/usr/bin/env node
/**
 * Weather Station Status Check for community weather stations
 * Quick diagnostic tool to verify active weather data connections
 *
 * Task 86: Technical Debt Cleanup - Implement real API checks and Winston logging
 */

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();

// Import Winston logger (compiled from TypeScript)
let weatherLogger;
let iotLogger;
try {
  const logger = require('./utils/logger');
  weatherLogger = logger.weatherLogger;
  iotLogger = logger.iotLogger;
} catch (e) {
  // Fallback to console-based logger if Winston not available
  weatherLogger = {
    info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ''),
    warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ''),
    error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
    debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta ? JSON.stringify(meta) : ''),
  };
  iotLogger = weatherLogger;
}

// Configuration from environment variables
const CONFIG = {
  // the configured AcuRite Station
  acurite: {
    localIp: process.env.ACURITE_LOCAL_IP,
    deviceId: process.env.ACURITE_DEVICE_ID,
    email: process.env.MYACURITE_EMAIL,
    password: process.env.MYACURITE_PASSWORD,
    apiBaseUrl: 'https://marapi.myacurite.com',
  },
  // the configured Ambient Weather WS-5000
  ambient: {
    apiKey: process.env.AMBIENT_WEATHER_API_KEY,
    appKey: process.env.AMBIENT_WEATHER_APP_KEY,
    apiBaseUrl: 'https://rt.ambientweather.net/v1',
  },
  // Request timeout in milliseconds
  requestTimeout: 15000,
};

// Known weather stations in Duluth, MN area
const DULUTH_STATIONS = [
  {
    id: 'bryan-duluth-station',
    name: "the configured AcuRite Iris Weather Station",
    location: 'Duluth, MN',
    lat: 46.7867,
    lon: -92.1005,
    expectedSources: ['acurite_local', 'myacurite', 'local_api'],
    checkMethod: 'acurite',
  },
  {
    id: 'jon-duluth-station',
    name: "the configured Ambient Weather WS-5000",
    location: 'Duluth, MN',
    lat: 46.7867,
    lon: -92.1005,
    expectedSources: ['ambient_weather', 'local_api'],
    checkMethod: 'ambient',
  },
];

class WeatherStationStatusChecker {
  constructor() {
    this.stationStatus = new Map();
    this.recentData = new Map();
    this.checkInterval = 30000; // 30 seconds
  }

  async checkAllStations() {
    weatherLogger.info('Checking weather stations in Duluth, MN');

    for (const station of DULUTH_STATIONS) {
      weatherLogger.info(`Checking station: ${station.name}`, { stationId: station.id });
      const status = await this.checkStation(station);
      this.stationStatus.set(station.id, status);

      if (status.isActive) {
        weatherLogger.info(`Station active: ${station.name}`, {
          stationId: station.id,
          lastUpdate: status.lastUpdate,
          source: status.source,
        });
      } else {
        weatherLogger.warn(`Station inactive: ${station.name}`, {
          stationId: station.id,
          error: status.error || 'No recent data',
        });
      }
    }

    return this.generateReport();
  }

  async checkStation(station) {
    try {
      // Check based on station type
      const checks = [];

      if (station.checkMethod === 'acurite') {
        checks.push(
          this.checkAcuRiteLocal(station),
          this.checkMyAcuRite(station)
        );
      } else if (station.checkMethod === 'ambient') {
        checks.push(this.checkAmbientWeather(station));
      }

      // Always check local API endpoints
      checks.push(this.checkLocalAPI(station));

      const results = await Promise.allSettled(checks);

      const activeConnections = results
        .filter(result => result.status === 'fulfilled' && result.value.isActive)
        .map(result => result.value);

      if (activeConnections.length > 0) {
        const mostRecent = activeConnections.reduce((latest, current) =>
          current.timestamp > latest.timestamp ? current : latest
        );

        return {
          isActive: true,
          lastUpdate: new Date(mostRecent.timestamp).toISOString(),
          source: mostRecent.source,
          data: mostRecent.data,
        };
      }

      return {
        isActive: false,
        error: 'No active connections found',
        lastUpdate: null,
      };
    } catch (error) {
      weatherLogger.error('Error checking station', {
        stationId: station.id,
        error: { message: error.message },
      });
      return {
        isActive: false,
        error: error.message,
        lastUpdate: null,
      };
    }
  }

  /**
   * Check the configured AcuRite station via local IP
   */
  async checkAcuRiteLocal(station) {
    if (!CONFIG.acurite.localIp) {
      weatherLogger.debug('ACURITE_LOCAL_IP not configured', { stationId: station.id });
      return { isActive: false, source: 'acurite_local' };
    }

    try {
      weatherLogger.debug('Checking AcuRite via local IP', {
        localIp: CONFIG.acurite.localIp,
      });

      const data = await this.makeHttpRequest(
        `http://${CONFIG.acurite.localIp}/weather`,
        CONFIG.requestTimeout
      );

      if (data) {
        const temperature = data.tempf || data.temperature;
        const humidity = data.humidity || data.humidity_outdoor;

        weatherLogger.info('AcuRite local check successful', {
          temperature,
          humidity,
          source: 'acurite_local',
        });

        return {
          isActive: true,
          source: 'acurite_local',
          timestamp: Date.now(),
          data: {
            temperature,
            humidity,
            pressure: data.baromin || data.pressure,
          },
        };
      }

      return { isActive: false, source: 'acurite_local' };
    } catch (error) {
      weatherLogger.debug('AcuRite local check failed', {
        error: { message: error.message },
      });
      return { isActive: false, source: 'acurite_local' };
    }
  }

  /**
   * Check the configured station via MyAcuRite API
   */
  async checkMyAcuRite(station) {
    if (!CONFIG.acurite.email || !CONFIG.acurite.password) {
      weatherLogger.debug('MyAcuRite credentials not configured', { stationId: station.id });
      return { isActive: false, source: 'myacurite' };
    }

    try {
      weatherLogger.debug('Checking MyAcuRite API');

      // Step 1: Login
      const loginResponse = await this.makeHttpsRequest(
        'marapi.myacurite.com',
        '/users/login',
        'POST',
        {
          email: CONFIG.acurite.email,
          password: CONFIG.acurite.password,
          remember: 'True',
        }
      );

      if (!loginResponse || !loginResponse.token_id) {
        return { isActive: false, source: 'myacurite', error: 'Login failed' };
      }

      const accountId = loginResponse.user?.account_users?.[0]?.account_id;
      const tokenId = loginResponse.token_id;

      if (!accountId) {
        return { isActive: false, source: 'myacurite', error: 'No account found' };
      }

      // Step 2: Get hubs
      const hubsResponse = await this.makeHttpsRequest(
        'marapi.myacurite.com',
        `/accounts/${accountId}/dashboard/hubs`,
        'GET',
        null,
        { 'x-one-vue-token': tokenId }
      );

      if (!hubsResponse?.account_hubs?.length) {
        return { isActive: false, source: 'myacurite', error: 'No hubs found' };
      }

      const hubId = hubsResponse.account_hubs[0].id;

      // Step 3: Get weather data
      const weatherResponse = await this.makeHttpsRequest(
        'marapi.myacurite.com',
        `/accounts/${accountId}/dashboard/hubs/${hubId}`,
        'GET',
        null,
        { 'x-one-vue-token': tokenId }
      );

      if (weatherResponse && weatherResponse.devices) {
        const latestDevice = weatherResponse.devices[0];
        const sensors = latestDevice?.sensors || [];

        let temperature, humidity;
        for (const sensor of sensors) {
          if (sensor.sensor_code === 'Temperature') {
            temperature = sensor.last_reading_value;
          }
          if (sensor.sensor_code === 'Humidity') {
            humidity = sensor.last_reading_value;
          }
        }

        weatherLogger.info('MyAcuRite check successful', {
          temperature,
          humidity,
          source: 'myacurite',
        });

        return {
          isActive: true,
          source: 'myacurite',
          timestamp: Date.now(),
          data: { temperature, humidity },
        };
      }

      return { isActive: false, source: 'myacurite' };
    } catch (error) {
      weatherLogger.debug('MyAcuRite check failed', {
        error: { message: error.message },
      });
      return { isActive: false, source: 'myacurite' };
    }
  }

  /**
   * Check the configured Ambient Weather WS-5000 via API
   */
  async checkAmbientWeather(station) {
    if (!CONFIG.ambient.apiKey || !CONFIG.ambient.appKey) {
      weatherLogger.debug('Ambient Weather API keys not configured', { stationId: station.id });
      return { isActive: false, source: 'ambient_weather' };
    }

    try {
      weatherLogger.debug('Checking Ambient Weather API');

      const response = await this.makeHttpsRequest(
        'rt.ambientweather.net',
        `/v1/devices?apiKey=${CONFIG.ambient.apiKey}&applicationKey=${CONFIG.ambient.appKey}`,
        'GET'
      );

      // Handle various response formats
      let devices = response;
      if (!Array.isArray(response)) {
        devices = response?.devices || [response];
      }

      if (devices && devices.length > 0) {
        const device = devices[0];
        const lastData = device.lastData;

        if (lastData) {
          const temperature = lastData.tempf;
          const humidity = lastData.humidity || lastData.humidityin;

          weatherLogger.info('Ambient Weather check successful', {
            temperature,
            humidity,
            stationName: device.info?.name,
            source: 'ambient_weather',
          });

          return {
            isActive: true,
            source: 'ambient_weather',
            timestamp: lastData.dateutc || Date.now(),
            data: {
              temperature,
              humidity,
              pressure: lastData.baromrelin,
              windSpeed: lastData.windspeedmph,
              stationName: device.info?.name || "the configured WS-5000",
            },
          };
        }
      }

      return { isActive: false, source: 'ambient_weather' };
    } catch (error) {
      weatherLogger.debug('Ambient Weather check failed', {
        error: { message: error.message },
      });
      return { isActive: false, source: 'ambient_weather' };
    }
  }

  /**
   * Check local API endpoints
   */
  async checkLocalAPI(station) {
    const possiblePorts = [4200, 8080, 3000, 5000];

    for (const port of possiblePorts) {
      try {
        const data = await this.makeHttpRequest(
          `http://${process.env.SERVICE_HOST || 'localhost'}:${port}/weather-data`,
          2000
        );

        if (data) {
          const latestReading = Array.isArray(data) ? data[data.length - 1] : data;

          iotLogger.info('Local API check successful', {
            port,
            stationId: station.id,
          });

          return {
            isActive: true,
            source: `local_api_${port}`,
            timestamp: latestReading.timestamp || Date.now(),
            data: latestReading,
          };
        }
      } catch (error) {
        // Continue checking other ports
      }
    }

    return { isActive: false, source: 'local_api' };
  }

  /**
   * Make HTTP request helper
   */
  makeHttpRequest(url, timeout) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const requestFn = urlObj.protocol === 'https:' ? https : http;

      const req = requestFn.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Make HTTPS request helper with JSON body
   */
  makeHttpsRequest(host, path, method, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: host,
        path: path,
        method: method,
        timeout: CONFIG.requestTimeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
      };

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      totalStations: DULUTH_STATIONS.length,
      activeStations: 0,
      inactiveStations: 0,
      stationDetails: [],
    };

    for (const [stationId, status] of this.stationStatus) {
      const station = DULUTH_STATIONS.find(s => s.id === stationId);

      if (status.isActive) {
        report.activeStations++;
      } else {
        report.inactiveStations++;
      }

      report.stationDetails.push({
        id: stationId,
        name: station.name,
        location: station.location,
        isActive: status.isActive,
        lastUpdate: status.lastUpdate,
        source: status.source,
        error: status.error,
        data: status.data,
      });
    }

    return report;
  }

  startMonitoring() {
    weatherLogger.info('Starting weather station monitoring');

    // Initial check
    this.checkAllStations().then(report => {
      weatherLogger.info('Initial status report generated', {
        totalStations: report.totalStations,
        activeStations: report.activeStations,
        inactiveStations: report.inactiveStations,
      });
    });

    // Set up periodic checks
    setInterval(async () => {
      const report = await this.checkAllStations();
      weatherLogger.info('Periodic status update', {
        activeStations: report.activeStations,
        totalStations: report.totalStations,
      });
    }, this.checkInterval);
  }
}

// API endpoints for manual checking
app.get('/weather-stations/status', async (req, res) => {
  const checker = new WeatherStationStatusChecker();
  const report = await checker.checkAllStations();
  res.json(report);
});

app.get('/weather-stations/duluth', async (req, res) => {
  const checker = new WeatherStationStatusChecker();
  const report = await checker.checkAllStations();

  const duluthStations = report.stationDetails.filter(station =>
    station.location.includes('Duluth')
  );

  res.json({
    location: 'Duluth, MN',
    stations: duluthStations,
    summary: {
      total: duluthStations.length,
      active: duluthStations.filter(s => s.isActive).length,
      inactive: duluthStations.filter(s => !s.isActive).length,
    },
  });
});

// Start the checker
if (require.main === module) {
  const checker = new WeatherStationStatusChecker();

  // Run initial check
  checker.checkAllStations().then(report => {
    weatherLogger.info('Weather station status report generated', {
      location: 'Duluth, MN',
      totalStations: report.totalStations,
      activeStations: report.activeStations,
      inactiveStations: report.inactiveStations,
    });

    // Log detailed status for each station
    report.stationDetails.forEach(station => {
      if (station.isActive) {
        weatherLogger.info(`Station ${station.name} is active`, {
          stationId: station.id,
          source: station.source,
          lastUpdate: station.lastUpdate,
        });
      } else {
        weatherLogger.warn(`Station ${station.name} is inactive`, {
          stationId: station.id,
          error: station.error,
        });
      }
    });

    // Structured logging output for CLI usage
    weatherLogger.info('WEATHER STATION STATUS REPORT - DULUTH, MN', {
      module: 'WeatherStationStatusCheck',
      totalStations: report.totalStations,
      activeStations: report.activeStations,
      inactiveStations: report.inactiveStations,
    });

    report.stationDetails.forEach(station => {
      if (station.isActive) {
        weatherLogger.info('Station status', {
          module: 'WeatherStationStatusCheck',
          stationName: station.name,
          status: 'ACTIVE',
          lastUpdate: station.lastUpdate || 'Never',
          source: station.source || 'None',
          temperature: station.data?.temperature,
          humidity: station.data?.humidity,
        });
      } else {
        weatherLogger.warn('Station status', {
          module: 'WeatherStationStatusCheck',
          stationName: station.name,
          status: 'INACTIVE',
          lastUpdate: station.lastUpdate || 'Never',
          source: station.source || 'None',
          error: station.error,
        });
      }
    });

    weatherLogger.info('To monitor continuously, use: node weather_station_status_check.js --monitor', {
      module: 'WeatherStationStatusCheck',
    });

    if (process.argv.includes('--monitor')) {
      checker.startMonitoring();
    }
  });
}

module.exports = WeatherStationStatusChecker;
