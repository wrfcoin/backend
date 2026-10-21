/**
 * NOAA National Weather Service API Integration Service
 *
 * This service provides integration with the NOAA National Weather Service API
 * for real-time weather data, forecasts, and alerts.
 *
 * API Documentation: https://www.weather.gov/documentation/services-web-api
 * Rate Limits: 5 requests/second, 1000 requests/hour (no authentication required)
 */

const axios = require('axios');
const { logger } = require('../utils/logger');
const {
  logLocation,
  redactCoordinateText,
} = require('../utils/log-coordinates');
const { TtlCache, NOAA_TTL_MS } = require('../utils/noaa-cell-cache');

// /points/{lat},{lon} is static (S2c): one process-wide cache, shared by every
// service instance, keyed on the exact point requested. Callers on the
// anonymous path already pass the 0.1 degree cell centre.
const gridPointCache = new TtlCache({ maxEntries: 5000 });

/**
 * NWS hourly `relativeHumidity` is `{ unitCode, value }`; return a whole
 * percent, or null when absent. A real 0 stays 0 (backend#1306).
 */
function humidityPercent(field) {
  const value = field && typeof field === 'object' ? field.value : field;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

// backend#1306: best-effort hourly call; keep a slow endpoint from stalling the daily forecast.
const HOURLY_HUMIDITY_TIMEOUT_MS = 3000;

/**
 * min/max humidity over the hourly periods whose startTime falls in
 * [startTime, endTime); null when none of them carries a value.
 */
function humidityRange(hourlyPeriods, startTime, endTime) {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let min = null;
  let max = null;
  for (const hour of hourlyPeriods) {
    const at = Date.parse(hour.startTime);
    if (!(at >= start && at < end)) continue;
    const value = humidityPercent(hour.relativeHumidity);
    if (value === null) continue;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  }
  return min === null ? null : { min, max };
}

class NOAAWeatherService {
  constructor() {
    this.baseURL = 'https://api.weather.gov';
    this.userAgent = 'WRFCoin Weather Integration (contact@wrfcoin.org)';
    this.rateLimit = {
      requestsPerSecond: 5,
      requestsPerHour: 1000,
      requestCount: 0,
      hourlyRequestCount: 0,
      lastRequest: 0,
      hourStartTime: Date.now(),
    };

    // Initialize HTTP client with proper headers
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 10000,
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    // Add request interceptor for rate limiting
    this.client.interceptors.request.use(async config => {
      await this.checkRateLimit();
      return config;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => this.handleAPIError(error)
    );
  }

  /**
   * Check and enforce rate limiting
   * NOAA allows 5 requests/second and 1000 requests/hour
   */
  async checkRateLimit() {
    const now = Date.now();

    // Reset hourly counter if hour has passed
    if (now - this.rateLimit.hourStartTime > 3600000) {
      this.rateLimit.hourlyRequestCount = 0;
      this.rateLimit.hourStartTime = now;
    }

    // Check hourly limit
    if (this.rateLimit.hourlyRequestCount >= this.rateLimit.requestsPerHour) {
      throw new Error(
        'NOAA API hourly rate limit exceeded (1000 requests/hour)'
      );
    }

    // Check per-second limit
    const timeSinceLastRequest = now - this.rateLimit.lastRequest;
    if (timeSinceLastRequest < 200) {
      // 200ms = 5 requests/second
      await new Promise(resolve =>
        setTimeout(resolve, 200 - timeSinceLastRequest)
      );
    }

    this.rateLimit.lastRequest = Date.now();
    this.rateLimit.requestCount++;
    this.rateLimit.hourlyRequestCount++;
  }

  /**
   * Handle API errors with proper logging and error transformation
   */
  handleAPIError(error) {
    const errorInfo = {
      // backend#1290: the URL and NOAA's error body echo the caller's point.
      // backend#1306: the hourly/daily forecast URLs carry the NWS office and
      // grid cell (/gridpoints/<office>/<x>,<y>), which are never logged.
      url: redactCoordinateText(error.config?.url)?.replace(
        /\/gridpoints\/[^?#]*/g,
        '/gridpoints/[redacted]'
      ),
      method: error.config?.method,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: redactCoordinateText(error.response?.data),
    };
    // Fail closed (backend#1304, #1306): a station or gridpoint request's error
    // body can carry the station / grid cell in any shape, so log only status and the redacted url.
    if (/\/(stations|gridpoints)/.test(String(error.config?.url || ''))) {
      delete errorInfo.data;
    }

    logger.error('NOAA API Error:', errorInfo);

    // Transform NOAA API errors to standard format
    if (error.response?.status === 404) {
      throw new Error('Location not found in NOAA database');
    } else if (error.response?.status === 500) {
      throw new Error('NOAA API server error');
    } else if (error.response?.status === 503) {
      throw new Error('NOAA API temporarily unavailable');
    } else if (error.code === 'ECONNABORTED') {
      throw new Error('NOAA API request timeout');
    } else {
      throw new Error(`NOAA API error: ${error.message}`);
    }
  }

  /**
   * Get grid point information for a given latitude/longitude
   * This is required before making forecast requests
   */
  async getGridPoint(latitude, longitude) {
    if (!this.isValidCoordinate(latitude, longitude)) {
      return this.fetchGridPoint(latitude, longitude); // throws the usual error
    }
    const { value } = await gridPointCache.getOrLoad(
      `gridPoint|${latitude},${longitude}`,
      NOAA_TTL_MS.gridPoint,
      () => this.fetchGridPoint(latitude, longitude)
    );
    return value;
  }

  async fetchGridPoint(latitude, longitude) {
    try {
      // Validate coordinates
      if (!this.isValidCoordinate(latitude, longitude)) {
        throw new Error('Invalid coordinates provided');
      }

      const response = await this.client.get(
        `/points/${latitude},${longitude}`
      );

      if (!response.data || !response.data.properties) {
        throw new Error('Invalid response from NOAA grid point API');
      }

      const properties = response.data.properties;

      return {
        gridId: properties.gridId,
        gridX: properties.gridX,
        gridY: properties.gridY,
        forecastUrl: properties.forecast,
        forecastHourlyUrl: properties.forecastHourly,
        forecastGridDataUrl: properties.forecastGridData,
        observationStationsUrl: properties.observationStations,
        relativeLocation: properties.relativeLocation,
        timeZone: properties.timeZone,
        radarStation: properties.radarStation,
      };
    } catch (error) {
      logger.error('Error getting NOAA grid point:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get current weather observations for a location
   */
  async getCurrentObservations(latitude, longitude, options = {}) {
    try {
      const { maxAgeMs = null, maxStations = 3 } = options;
      const gridPoint = await this.getGridPoint(latitude, longitude);

      // Get observation stations for this grid point
      const stationsResponse = await this.client.get(
        gridPoint.observationStationsUrl
      );

      if (!stationsResponse.data?.features?.length) {
        throw new Error('No observation stations found for this location');
      }

      // Without maxAgeMs only the nearest station is used (legacy behaviour).
      // With it, walk outward (nearest first, at most maxStations) until an
      // observation is fresh enough; station ids are never logged.
      const candidates = stationsResponse.data.features.slice(
        0,
        maxAgeMs === null ? 1 : maxStations
      );
      let lastError = null;
      let newestStale = null;
      let found = null;
      for (const station of candidates) {
        const candidateId = station.properties.stationIdentifier;
        let response;
        try {
          response = await this.client.get(
            `/stations/${candidateId}/observations/latest`
          );
        } catch (err) {
          lastError = err;
          continue;
        }
        if (!response.data?.properties) {
          lastError = new Error('No current observations available');
          continue;
        }
        const props = response.data.properties;
        if (maxAgeMs !== null) {
          const observedMs = Date.parse(props.timestamp);
          if (!Number.isFinite(observedMs) || Date.now() - observedMs > maxAgeMs) {
            if (
              Number.isFinite(observedMs) &&
              (newestStale === null || observedMs > newestStale)
            ) {
              newestStale = observedMs;
            }
            continue;
          }
        }
        found = { stationId: candidateId, response };
        break;
      }
      if (!found) {
        if (maxAgeMs !== null && lastError === null) {
          return {
            stale: true,
            timestamp: newestStale ? new Date(newestStale).toISOString() : null,
          };
        }
        throw lastError || new Error('No current observations available');
      }
      const stationId = found.stationId;
      const observationsResponse = found.response;

      const obs = observationsResponse.data.properties;

      return {
        stationId: stationId,
        timestamp: obs.timestamp,
        temperature: this.convertValue(obs.temperature),
        dewpoint: this.convertValue(obs.dewpoint),
        windDirection: this.convertValue(obs.windDirection),
        windSpeed: this.convertValue(obs.windSpeed),
        windGust: this.convertValue(obs.windGust),
        barometricPressure: this.convertValue(obs.barometricPressure),
        seaLevelPressure: this.convertValue(obs.seaLevelPressure),
        visibility: this.convertValue(obs.visibility),
        maxTemperatureLast24Hours: this.convertValue(
          obs.maxTemperatureLast24Hours
        ),
        minTemperatureLast24Hours: this.convertValue(
          obs.minTemperatureLast24Hours
        ),
        precipitationLastHour: this.convertValue(obs.precipitationLastHour),
        precipitationLast3Hours: this.convertValue(obs.precipitationLast3Hours),
        precipitationLast6Hours: this.convertValue(obs.precipitationLast6Hours),
        relativeHumidity: this.convertValue(obs.relativeHumidity),
        windChill: this.convertValue(obs.windChill),
        heatIndex: this.convertValue(obs.heatIndex),
        cloudLayers: obs.cloudLayers,
        rawMessage: obs.rawMessage,
        textDescription: obs.textDescription,
      };
    } catch (error) {
      logger.error('Error getting current observations:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get weather forecast for a location
   */
  async getForecast(latitude, longitude, periods = 7) {
    try {
      const gridPoint = await this.getGridPoint(latitude, longitude);

      const response = await this.client.get(gridPoint.forecastUrl);

      if (!response.data?.properties?.periods) {
        throw new Error('No forecast data available');
      }

      const forecastPeriods = response.data.properties.periods.slice(
        0,
        periods
      );

      // backend#1306: one extra call, reusing the /points result. A failure
      // here must not fail the daily forecast; humidity is simply null.
      let hourlyPeriods = [];
      try {
        const hourly = await this.client.get(gridPoint.forecastHourlyUrl, {
          timeout: HOURLY_HUMIDITY_TIMEOUT_MS,
        });
        hourlyPeriods = hourly.data?.properties?.periods || [];
      } catch (hourlyError) {
        logger.warn('Hourly humidity unavailable for daily forecast:', {
          location: logLocation(latitude, longitude),
          error: redactCoordinateText(hourlyError.message),
        });
      }

      return {
        location: {
          latitude,
          longitude,
        },
        updated: response.data.properties.updated,
        units: response.data.properties.units,
        forecastGenerator: response.data.properties.forecastGenerator,
        generatedAt: response.data.properties.generatedAt,
        updateTime: response.data.properties.updateTime,
        validTimes: response.data.properties.validTimes,
        elevation: response.data.properties.elevation,
        periods: forecastPeriods.map(period => ({
          number: period.number,
          name: period.name,
          startTime: period.startTime,
          endTime: period.endTime,
          isDaytime: period.isDaytime,
          temperature: period.temperature,
          temperatureUnit: period.temperatureUnit,
          temperatureTrend: period.temperatureTrend,
          windSpeed: period.windSpeed,
          windDirection: period.windDirection,
          icon: period.icon,
          shortForecast: period.shortForecast,
          detailedForecast: period.detailedForecast,
          relativeHumidity: humidityRange(
            hourlyPeriods,
            period.startTime,
            period.endTime
          ),
        })),
      };
    } catch (error) {
      logger.error('Error getting forecast:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get hourly forecast for more detailed predictions
   */
  async getHourlyForecast(latitude, longitude, hours = 48) {
    try {
      const gridPoint = await this.getGridPoint(latitude, longitude);

      const response = await this.client.get(gridPoint.forecastHourlyUrl);

      if (!response.data?.properties?.periods) {
        throw new Error('No hourly forecast data available');
      }

      const hourlyPeriods = response.data.properties.periods.slice(0, hours);

      return {
        location: {
          latitude,
          longitude,
        },
        updated: response.data.properties.updated,
        units: response.data.properties.units,
        forecastGenerator: response.data.properties.forecastGenerator,
        generatedAt: response.data.properties.generatedAt,
        periods: hourlyPeriods.map(period => ({
          number: period.number,
          startTime: period.startTime,
          endTime: period.endTime,
          isDaytime: period.isDaytime,
          temperature: period.temperature,
          temperatureUnit: period.temperatureUnit,
          probabilityOfPrecipitation: period.probabilityOfPrecipitation,
          dewpoint: period.dewpoint,
          relativeHumidity: humidityPercent(period.relativeHumidity),
          windSpeed: period.windSpeed,
          windDirection: period.windDirection,
          icon: period.icon,
          shortForecast: period.shortForecast,
        })),
      };
    } catch (error) {
      logger.error('Error getting hourly forecast:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get active weather alerts for a location
   */
  async getAlerts(latitude, longitude) {
    try {
      // Get alerts by point
      const response = await this.client.get('/alerts/active', {
        params: {
          point: `${latitude},${longitude}`,
        },
      });

      if (!response.data?.features) {
        return { alerts: [], count: 0 };
      }

      const alerts = response.data.features.map(alert => ({
        id: alert.properties.id,
        areaDesc: alert.properties.areaDesc,
        geocode: alert.properties.geocode,
        affectedZones: alert.properties.affectedZones,
        references: alert.properties.references,
        sent: alert.properties.sent,
        effective: alert.properties.effective,
        onset: alert.properties.onset,
        expires: alert.properties.expires,
        ends: alert.properties.ends,
        status: alert.properties.status,
        messageType: alert.properties.messageType,
        category: alert.properties.category,
        severity: alert.properties.severity,
        certainty: alert.properties.certainty,
        urgency: alert.properties.urgency,
        event: alert.properties.event,
        sender: alert.properties.sender,
        senderName: alert.properties.senderName,
        headline: alert.properties.headline,
        description: alert.properties.description,
        instruction: alert.properties.instruction,
        response: alert.properties.response,
        parameters: alert.properties.parameters,
      }));

      return {
        alerts,
        count: alerts.length,
        generated: response.data.updated,
      };
    } catch (error) {
      logger.error('Error getting alerts:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get weather stations near a location
   */
  async getNearbyStations(latitude, longitude, limit = 10) {
    try {
      const gridPoint = await this.getGridPoint(latitude, longitude);

      const response = await this.client.get(gridPoint.observationStationsUrl);

      if (!response.data?.features) {
        return { stations: [], count: 0 };
      }

      const stations = response.data.features.slice(0, limit).map(station => ({
        id: station.properties.stationIdentifier,
        name: station.properties.name,
        timeZone: station.properties.timeZone,
        forecast: station.properties.forecast,
        county: station.properties.county,
        fireWeatherZone: station.properties.fireWeatherZone,
        coordinates: {
          latitude: station.geometry.coordinates[1],
          longitude: station.geometry.coordinates[0],
          elevation: station.geometry.coordinates[2],
        },
      }));

      return {
        stations,
        count: stations.length,
      };
    } catch (error) {
      logger.error('Error getting nearby stations:', {
        location: logLocation(latitude, longitude),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Helper method to convert NOAA API values to standard units
   */
  convertValue(valueObj) {
    if (!valueObj || valueObj.value === null || valueObj.value === undefined) {
      return null;
    }

    return {
      value: valueObj.value,
      unit: valueObj.unitCode,
      qualityControl: valueObj.qualityControl,
    };
  }

  /**
   * Validate latitude and longitude coordinates
   */
  isValidCoordinate(latitude, longitude) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    return (
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  /**
   * Get service health status
   */
  async getHealthStatus() {
    try {
      // Test API connectivity with a simple request
      const response = await this.client.get('/');

      return {
        status: 'healthy',
        responseTime: response.headers['response-time'] || 'unknown',
        rateLimit: {
          requestsThisHour: this.rateLimit.hourlyRequestCount,
          maxRequestsPerHour: this.rateLimit.requestsPerHour,
          requestsPerSecond: this.rateLimit.requestsPerSecond,
        },
        lastCheck: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  /**
   * Transform NOAA data to WRFCoin standard format
   */
  transformToWRFCoinFormat(noaaData, dataType = 'observation') {
    const timestamp = new Date().toISOString();

    if (dataType === 'observation') {
      return {
        source: 'NOAA-NWS',
        dataType: 'current_observation',
        timestamp: noaaData.timestamp || timestamp,
        location: {
          latitude: null, // Set by caller
          longitude: null, // Set by caller
          stationId: noaaData.stationId,
        },
        data: {
          temperature: noaaData.temperature?.value || null,
          temperatureUnit: noaaData.temperature?.unit || null,
          humidity: noaaData.relativeHumidity?.value || null,
          pressure: noaaData.barometricPressure?.value || null,
          pressureUnit: noaaData.barometricPressure?.unit || null,
          windSpeed: noaaData.windSpeed?.value || null,
          windDirection: noaaData.windDirection?.value || null,
          windGust: noaaData.windGust?.value || null,
          visibility: noaaData.visibility?.value || null,
          dewpoint: noaaData.dewpoint?.value || null,
          precipitation: {
            lastHour: noaaData.precipitationLastHour?.value || null,
            last3Hours: noaaData.precipitationLast3Hours?.value || null,
            last6Hours: noaaData.precipitationLast6Hours?.value || null,
          },
          conditions: noaaData.textDescription || null,
        },
        quality: {
          source: 'authoritative',
          confidence: 0.95, // NOAA data is highly reliable
          validationPassed: true,
        },
        metadata: {
          rawMessage: noaaData.rawMessage,
          cloudLayers: noaaData.cloudLayers,
        },
      };
    }

    return noaaData; // Return as-is for other types
  }
}

module.exports = NOAAWeatherService;
module.exports.gridPointCache = gridPointCache;
