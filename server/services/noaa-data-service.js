/**
 * NOAA Data Service API v1 Integration
 *
 * This service provides integration with the NOAA Data Service API v1
 * for historical weather and climate data access.
 *
 * API Documentation: https://www.ncei.noaa.gov/support/access-data-service-api-user-documentation
 * Authentication: API token required (free registration)
 * Rate Limits: 5 requests/second, 10,000 requests/day
 */

const axios = require('axios');
const { logger } = require('../utils/logger');
const {
  logLocation,
  redactCoordinateText,
} = require('../utils/log-coordinates');

class NOAADataService {
  constructor(apiToken = null) {
    this.baseURL = 'https://www.ncei.noaa.gov/access/services/data/v1';
    this.apiToken = apiToken || process.env.NOAA_API_TOKEN;
    this.userAgent = 'WRFCoin Weather Integration (contact@wrfcoin.org)';

    // Rate limiting configuration
    this.rateLimit = {
      requestsPerSecond: 5,
      requestsPerDay: 10000,
      requestCount: 0,
      dailyRequestCount: 0,
      lastRequest: 0,
      dayStartTime: Date.now(),
    };

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000, // Longer timeout for large data requests
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    // Add request interceptor for authentication and rate limiting
    this.client.interceptors.request.use(async config => {
      await this.checkRateLimit();

      // Add API token if available
      if (this.apiToken) {
        config.headers['token'] = this.apiToken;
      }

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
   * NOAA Data Service allows 5 requests/second and 10,000 requests/day
   */
  async checkRateLimit() {
    const now = Date.now();

    // Reset daily counter if day has passed
    if (now - this.rateLimit.dayStartTime > 86400000) {
      this.rateLimit.dailyRequestCount = 0;
      this.rateLimit.dayStartTime = now;
    }

    // Check daily limit
    if (this.rateLimit.dailyRequestCount >= this.rateLimit.requestsPerDay) {
      throw new Error(
        'NOAA Data Service daily rate limit exceeded (10,000 requests/day)'
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
    this.rateLimit.dailyRequestCount++;
  }

  /**
   * Handle API errors with proper logging and error transformation
   */
  handleAPIError(error) {
    const errorInfo = {
      // backend#1290: the URL and NOAA's error body echo the caller's point.
      url: redactCoordinateText(error.config?.url),
      method: error.config?.method,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: redactCoordinateText(error.response?.data),
    };

    logger.error('NOAA Data Service API Error:', errorInfo);

    // Transform API errors to standard format
    if (error.response?.status === 400) {
      throw new Error('Invalid request parameters for NOAA Data Service');
    } else if (error.response?.status === 401) {
      throw new Error('NOAA API token required or invalid');
    } else if (error.response?.status === 404) {
      throw new Error('Requested data not found in NOAA database');
    } else if (error.response?.status === 429) {
      throw new Error('NOAA Data Service rate limit exceeded');
    } else if (error.response?.status === 500) {
      throw new Error('NOAA Data Service server error');
    } else if (error.code === 'ECONNABORTED') {
      throw new Error('NOAA Data Service request timeout');
    } else {
      throw new Error(`NOAA Data Service error: ${error.message}`);
    }
  }

  /**
   * Get available datasets
   */
  async getDatasets() {
    try {
      const response = await this.client.get('', {
        params: {
          format: 'json',
        },
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid response from NOAA datasets API');
      }

      return response.data.map(dataset => ({
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        minDate: dataset.mindate,
        maxDate: dataset.maxdate,
        dataTypes: dataset.datatypes || [],
      }));
    } catch (error) {
      logger.error('Error getting NOAA datasets:', { error: error.message });
      throw error;
    }
  }

  /**
   * Get historical weather data for a location and date range
   * Common datasets: GHCND (Global Historical Climatology Network Daily)
   */
  async getHistoricalData(options) {
    const {
      dataset = 'GHCND', // Global Historical Climatology Network Daily
      stations,
      startDate,
      endDate,
      dataTypes = ['TMAX', 'TMIN', 'PRCP', 'SNOW', 'SNWD'],
      includeStationName = true,
      includeStationLocation = true,
      limit = 1000,
    } = options;

    try {
      // Validate required parameters
      if (
        !stations ||
        (!Array.isArray(stations) && typeof stations !== 'string')
      ) {
        throw new Error('Station ID(s) required');
      }
      if (!startDate || !endDate) {
        throw new Error('Start date and end date required');
      }

      // Format station IDs
      const stationIds = Array.isArray(stations)
        ? stations.join(',')
        : stations;

      // Build request parameters
      const params = {
        dataset,
        stations: stationIds,
        startDate: this.formatDate(startDate),
        endDate: this.formatDate(endDate),
        dataTypes: Array.isArray(dataTypes) ? dataTypes.join(',') : dataTypes,
        format: 'json',
        includeStationName: includeStationName ? 'true' : 'false',
        includeStationLocation: includeStationLocation ? 'true' : 'false',
        limit,
      };

      const response = await this.client.get('', { params });

      if (!response.data) {
        throw new Error('No data returned from NOAA Data Service');
      }

      // Parse and transform the response
      return this.parseHistoricalData(response.data);
    } catch (error) {
      logger.error('Error getting historical data:', {
        options,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get weather stations near a location
   */
  async findStationsNearLocation(latitude, longitude, radius = 50, limit = 25) {
    try {
      // NOAA uses a bounding box approach for location searches
      const extent = this.calculateBoundingBox(latitude, longitude, radius);

      const params = {
        dataset: 'GHCND',
        extent: `${extent.south},${extent.west},${extent.north},${extent.east}`,
        format: 'json',
        limit,
        includeStationLocation: 'true',
        includeStationName: 'true',
      };

      const response = await this.client.get('/stations', { params });

      if (!response.data || !response.data.results) {
        return { stations: [], count: 0 };
      }

      const stations = response.data.results.map(station => {
        const distance = this.calculateDistance(
          latitude,
          longitude,
          station.latitude,
          station.longitude
        );

        return {
          id: station.id,
          name: station.name,
          latitude: station.latitude,
          longitude: station.longitude,
          elevation: station.elevation,
          minDate: station.mindate,
          maxDate: station.maxdate,
          dataTypes: station.datatypes || [],
          distance: Math.round(distance * 100) / 100, // Round to 2 decimal places
          datacoverage: station.datacoverage,
        };
      });

      // Sort by distance
      stations.sort((a, b) => a.distance - b.distance);

      return {
        stations,
        count: stations.length,
        searchParams: {
          latitude,
          longitude,
          radius,
          extent,
        },
      };
    } catch (error) {
      logger.error('Error finding stations near location:', {
        location: logLocation(latitude, longitude),
        radius,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get detailed information about a specific weather station
   */
  async getStationDetails(stationId) {
    try {
      const params = {
        format: 'json',
        includeStationLocation: 'true',
        includeStationName: 'true',
      };

      const response = await this.client.get(`/stations/${stationId}`, {
        params,
      });

      if (!response.data) {
        throw new Error(`Station ${stationId} not found`);
      }

      return {
        id: response.data.id,
        name: response.data.name,
        latitude: response.data.latitude,
        longitude: response.data.longitude,
        elevation: response.data.elevation,
        elevationUnit: response.data.elevationUnit,
        minDate: response.data.mindate,
        maxDate: response.data.maxdate,
        datacoverage: response.data.datacoverage,
        dataTypes: response.data.datatypes || [],
      };
    } catch (error) {
      logger.error('Error getting station details:', {
        stationId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get available data types for a dataset
   */
  async getDataTypes(dataset = 'GHCND') {
    try {
      const params = {
        dataset,
        format: 'json',
        limit: 1000,
      };

      const response = await this.client.get('/datatypes', { params });

      if (!response.data || !response.data.results) {
        return { dataTypes: [], count: 0 };
      }

      const dataTypes = response.data.results.map(dataType => ({
        id: dataType.id,
        name: dataType.name,
        description: dataType.description,
        units: dataType.units,
        minDate: dataType.mindate,
        maxDate: dataType.maxdate,
      }));

      return {
        dataTypes,
        count: dataTypes.length,
        dataset,
      };
    } catch (error) {
      logger.error('Error getting data types:', {
        dataset,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Parse historical data response from NOAA
   */
  parseHistoricalData(rawData) {
    if (!rawData.results || !Array.isArray(rawData.results)) {
      return {
        data: [],
        count: 0,
        metadata: rawData.metadata || {},
      };
    }

    const groupedData = {};

    // Group data by station and date
    rawData.results.forEach(record => {
      const stationId = record.station;
      const date = record.date;

      if (!groupedData[stationId]) {
        groupedData[stationId] = {
          stationId,
          stationName: record.stationName || stationId,
          latitude: record.latitude,
          longitude: record.longitude,
          elevation: record.elevation,
          measurements: {},
        };
      }

      if (!groupedData[stationId].measurements[date]) {
        groupedData[stationId].measurements[date] = {};
      }

      groupedData[stationId].measurements[date][record.datatype] = {
        value: record.value,
        attributes: record.attributes || '',
        flags: record.fl_m || '',
      };
    });

    // Convert to array format
    const transformedData = Object.values(groupedData).map(station => ({
      ...station,
      measurements: Object.entries(station.measurements)
        .map(([date, data]) => ({
          date,
          data,
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date)),
    }));

    return {
      data: transformedData,
      count: transformedData.length,
      metadata: rawData.metadata || {},
      totalRecords: rawData.results.length,
    };
  }

  /**
   * Transform NOAA historical data to WRFCoin standard format
   */
  transformToWRFCoinFormat(noaaData) {
    const timestamp = new Date().toISOString();

    return noaaData.data.map(station => {
      const measurements = station.measurements.map(measurement => ({
        timestamp: measurement.date + 'T12:00:00Z', // Assume noon UTC for daily data
        source: 'NOAA-NCEI',
        dataType: 'historical_observation',
        location: {
          latitude: station.latitude,
          longitude: station.longitude,
          stationId: station.stationId,
          stationName: station.stationName,
          elevation: station.elevation,
        },
        data: this.parseNOAAMeasurements(measurement.data),
        quality: {
          source: 'authoritative',
          confidence: 0.95,
          validationPassed: true,
          flags: this.extractQualityFlags(measurement.data),
        },
        metadata: {
          dataset: 'GHCND',
          originalData: measurement.data,
        },
      }));

      return {
        station,
        measurements,
        count: measurements.length,
      };
    });
  }

  /**
   * Parse NOAA measurement data to standard units
   */
  parseNOAAMeasurements(rawData) {
    const parsed = {};

    Object.entries(rawData).forEach(([dataType, measurement]) => {
      switch (dataType) {
        case 'TMAX':
          parsed.temperatureMax = {
            value: measurement.value / 10, // Convert tenths of degrees C to degrees C
            unit: 'celsius',
          };
          break;
        case 'TMIN':
          parsed.temperatureMin = {
            value: measurement.value / 10,
            unit: 'celsius',
          };
          break;
        case 'PRCP':
          parsed.precipitation = {
            value: measurement.value / 10, // Convert tenths of mm to mm
            unit: 'millimeters',
          };
          break;
        case 'SNOW':
          parsed.snowfall = {
            value: measurement.value,
            unit: 'millimeters',
          };
          break;
        case 'SNWD':
          parsed.snowDepth = {
            value: measurement.value,
            unit: 'millimeters',
          };
          break;
        case 'AWND':
          parsed.windSpeed = {
            value: measurement.value / 10, // Convert tenths of m/s to m/s
            unit: 'metersPerSecond',
          };
          break;
        default:
          parsed[dataType] = measurement;
      }
    });

    return parsed;
  }

  /**
   * Extract quality flags from measurement data
   */
  extractQualityFlags(rawData) {
    const flags = {};

    Object.entries(rawData).forEach(([dataType, measurement]) => {
      if (measurement.flags) {
        flags[dataType] = measurement.flags;
      }
    });

    return flags;
  }

  /**
   * Calculate bounding box for location search
   */
  calculateBoundingBox(latitude, longitude, radiusKm) {
    const latDelta = radiusKm / 111.32; // Approximate km per degree latitude
    const lngDelta = radiusKm / (111.32 * Math.cos((latitude * Math.PI) / 180));

    return {
      north: latitude + latDelta,
      south: latitude - latDelta,
      east: longitude + lngDelta,
      west: longitude - lngDelta,
    };
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Format date for NOAA API (YYYY-MM-DD)
   */
  formatDate(date) {
    if (typeof date === 'string') {
      return date;
    }

    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }

    throw new Error('Invalid date format');
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
      // Test API connectivity
      const response = await this.client.get('', {
        params: { format: 'json', limit: 1 },
      });

      return {
        status: 'healthy',
        apiToken: this.apiToken ? 'configured' : 'not_configured',
        rateLimit: {
          requestsToday: this.rateLimit.dailyRequestCount,
          maxRequestsPerDay: this.rateLimit.requestsPerDay,
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
}

module.exports = NOAADataService;
