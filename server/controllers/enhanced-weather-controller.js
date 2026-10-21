/**
 * Enhanced Weather Controller
 *
 * This controller integrates real weather APIs (NOAA NWS, NOAA Data Service)
 * with the existing WRFCoin weather infrastructure.
 */

const NOAAWeatherService = require('../services/noaa-nws-api-service');
const NOAADataService = require('../services/noaa-data-service');
const { logger } = require('../../utils/logger');
const { logLocation, redactCoordinateText } = require('../utils/log-coordinates');
const { coarsenCoordinate } = require('../utils/anonymous-projection');
const { TtlCache, NOAA_TTL_MS, toCell, cellKey } = require('../utils/noaa-cell-cache');
const { isAuthorizedForExactCoordinates } = require('../middleware/anonymous-coordinate-guard');

/**
 * NWS { value, unitCode } -> a plain number in the unit the response promises
 * (degC, percent, hPa, km/h). null when NWS reports no value; a real 0 stays 0.
 */
function nwsValue(quantity, kind) {
  const raw = quantity && quantity.value;
  if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) {
    return null;
  }
  const value = Number(raw);
  const unit = String((quantity && quantity.unitCode) || '');
  const round = (n) => Math.round(n * 100) / 100;
  switch (kind) {
    case 'temperature':
      return round(/degF/i.test(unit) ? ((value - 32) * 5) / 9 : /degK|kelvin/i.test(unit) ? value - 273.15 : value);
    case 'pressure':
      return round(/hPa|mbar/i.test(unit) ? value : value / 100); // NWS default is Pa
    case 'speed':
      return round(/m_s-1/i.test(unit) ? value * 3.6 : /mi_h-1/i.test(unit) ? value * 1.609344 : /kn/i.test(unit) ? value * 1.852 : value);
    default:
      return value;
  }
}

// NWS "latest" can be hours old; past 2 h it is not "current".
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;
const NWS_MAX_DAILY_PERIODS = 14; // NWS serves 7 days of 12h periods

// S2c: one cache per process, shared by every controller instance, so the
// anonymous website and the mobile app draw on the same upstream fetches.
const noaaCache = new TtlCache();

class EnhancedWeatherController {
  constructor() {
    this.noaaCache = noaaCache;
    this.noaaWeatherService = new NOAAWeatherService();
    this.noaaDataService = new NOAADataService();
    this.useRealData = process.env.USE_REAL_WEATHER_DATA !== 'false';
    this.fallbackToMock = false;
  }

  /**
   * Get current weather data for a location
   */
  async getCurrentWeather(req, res) {
    try {
      const { location } = req.params;
      const { lat, lng, source } = req.query;

      // Parse location coordinates
      const coordinates = this.parseLocationCoordinates(location, lat, lng);

      if (!coordinates) {
        return res.status(400).json({
          error: true,
          message:
            'Valid coordinates required (latitude,longitude or lat/lng query parameters)',
        });
      }

      if (!this.useRealData) {
        throw new Error('Real weather integration is disabled');
      }

      const noaaObservations =
        await this.noaaWeatherService.getCurrentObservations(
          coordinates.latitude,
          coordinates.longitude
        );

      const weatherData =
        this.noaaWeatherService.transformToWRFCoinFormat(noaaObservations);
      weatherData.location.latitude = coordinates.latitude;
      weatherData.location.longitude = coordinates.longitude;

      const dataSource = 'NOAA-NWS';

      logger.info('Retrieved real weather data', {
        source: dataSource,
        location: logLocation(coordinates.latitude, coordinates.longitude),
      });

      res.json({
        location: this.locationEcho(req, location, coordinates),
        current: weatherData,
        source: dataSource,
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    } catch (error) {
      logger.error('Error getting current weather:', {
        error: error.message,
        location: this.logLocationOf(req),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve current weather data',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Latest NWS observation for a location (backend#1303).
   *
   * Flat, unit-normalised numbers; a value NWS does not report is null, never
   * 0. The observing station and gridpoint are deliberately NOT returned or
   * logged: in a dense area the nearest station places the caller finer than
   * the 0.1 degree the #1290 ruling allows.
   */
  async getCurrentObservations(req, res) {
    try {
      const { location } = req.params;
      const { lat, lng } = req.query;
      const coordinates = this.parseLocationCoordinates(location, lat, lng);

      if (!coordinates) {
        return res.status(400).json({
          error: true,
          message:
            'Valid coordinates required (latitude,longitude or lat/lng query parameters)',
        });
      }

      if (!this.useRealData) {
        throw new Error('Real weather integration is disabled');
      }

      const cell = toCell(coordinates.latitude, coordinates.longitude);
      const { value: obs, status: cacheStatus } = await this.noaaCache.getOrLoad(
        cellKey('current', cell.latitude, cell.longitude),
        NOAA_TTL_MS.current,
        () =>
          this.noaaWeatherService.getCurrentObservations(
            cell.latitude,
            cell.longitude,
            { maxAgeMs: MAX_OBSERVATION_AGE_MS }
          )
      );
      res.set('X-Cache', cacheStatus === 'MISS' ? 'MISS' : 'HIT');

      if (obs.stale) {
        // Never present a stale observation as current (backend#1304 P2).
        logger.info('No fresh current observation', {
          source: 'NOAA-NWS',
          location: logLocation(coordinates.latitude, coordinates.longitude),
        });
        return res.json({
          location: this.locationEcho(req, location, coordinates),
          current: null,
          reason: 'stale_observation',
          maxAgeMinutes: MAX_OBSERVATION_AGE_MS / 60000,
          source: 'NOAA-NWS',
          timestamp: new Date().toISOString(),
          status: 'unavailable',
        });
      }

      logger.info('Retrieved current observations', {
        source: 'NOAA-NWS',
        location: logLocation(coordinates.latitude, coordinates.longitude),
      });

      res.json({
        location: this.locationEcho(req, location, coordinates),
        current: {
          temperatureC: nwsValue(obs.temperature, 'temperature'),
          relativeHumidityPercent: nwsValue(obs.relativeHumidity, 'percent'),
          barometricPressureHpa: nwsValue(obs.barometricPressure, 'pressure'),
          seaLevelPressureHpa: nwsValue(obs.seaLevelPressure, 'pressure'),
          windSpeedKmh: nwsValue(obs.windSpeed, 'speed'),
          observedAt: obs.timestamp || null,
        },
        source: 'NOAA-NWS',
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    } catch (error) {
      logger.error('Error getting current observations:', {
        error: redactCoordinateText(error.message),
        location: this.logLocationOf(req),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve current observations',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Get weather forecast for a location
   */
  async getWeatherForecast(req, res) {
    try {
      const { location } = req.params;
      const { lat, lng, days = 7, type = 'daily', unit = 'periods' } = req.query;

      const coordinates = this.parseLocationCoordinates(location, lat, lng);

      if (!coordinates) {
        return res.status(400).json({
          error: true,
          message: 'Valid coordinates required',
        });
      }

      if (unit === 'days' && !/^\d+$/.test(String(days))) {
        return res.status(400).json({
          error: true,
          message: 'days must be a positive integer',
        });
      }

      // backend#1303: in daily mode `days` has always counted NOAA 12h
      // periods (7 = 3.5 days) and the deployed mobile app relies on that
      // (?days=14 for a week). Calendar days are opt-in via unit=days.
      if (unit !== 'periods' && unit !== 'days') {
        return res.status(400).json({
          error: true,
          message: "unit must be 'periods' (default) or 'days'",
        });
      }

      if (!this.useRealData) {
        throw new Error('Real weather integration is disabled');
      }

      const cell = toCell(coordinates.latitude, coordinates.longitude);
      const hourly = type === 'hourly';
      const count = hourly
        ? parseInt(days, 10) * 24
        : unit === 'days'
          ? Math.min(parseInt(days, 10) * 2, NWS_MAX_DAILY_PERIODS)
          : parseInt(days, 10);
      const { value: forecastData, status: cacheStatus } =
        await this.noaaCache.getOrLoad(
          cellKey(hourly ? 'hourly' : 'daily', cell.latitude, cell.longitude, count),
          hourly ? NOAA_TTL_MS.hourlyForecast : NOAA_TTL_MS.dailyForecast,
          () =>
            hourly
              ? this.noaaWeatherService.getHourlyForecast(cell.latitude, cell.longitude, count)
              : this.noaaWeatherService.getForecast(cell.latitude, cell.longitude, count)
        );
      res.set('X-Cache', cacheStatus === 'MISS' ? 'MISS' : 'HIT');

      const dataSource = 'NOAA-NWS';

      logger.info('Retrieved real forecast data', {
        source: dataSource,
        location: logLocation(coordinates.latitude, coordinates.longitude),
        type,
        periods: forecastData.periods?.length,
      });

      res.json({
        location: this.locationEcho(req, location, coordinates),
        forecast: forecastData,
        source: dataSource,
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    } catch (error) {
      logger.error('Error getting weather forecast:', {
        error: error.message,
        location: this.logLocationOf(req),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve weather forecast',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Get historical weather data
   */
  async getHistoricalWeather(req, res) {
    try {
      const { location } = req.params;
      const { lat, lng, startDate, endDate, dataTypes } = req.query;

      const coordinates = this.parseLocationCoordinates(location, lat, lng);

      if (!coordinates) {
        return res.status(400).json({
          error: true,
          message: 'Valid coordinates required',
        });
      }

      if (!startDate || !endDate) {
        return res.status(400).json({
          error: true,
          message: 'Start date and end date are required for historical data',
        });
      }

      if (!this.useRealData) {
        throw new Error('Real weather integration is disabled');
      }

      const stationsResult =
        await this.noaaDataService.findStationsNearLocation(
          coordinates.latitude,
          coordinates.longitude,
          50,
          5
        );

      if (stationsResult.stations.length === 0) {
        throw new Error('No weather stations found near location');
      }

      const nearestStation = stationsResult.stations[0];
      const options = {
        dataset: 'GHCND',
        stations: nearestStation.id,
        startDate,
        endDate,
        dataTypes: dataTypes ? dataTypes.split(',') : ['TMAX', 'TMIN', 'PRCP'],
      };
      const rawHistoricalData =
        await this.noaaDataService.getHistoricalData(options);
      const historicalData =
        this.noaaDataService.transformToWRFCoinFormat(rawHistoricalData);
      const dataSource = 'NOAA-NCEI';

      logger.info('Retrieved historical weather data', {
        source: dataSource,
        location: logLocation(coordinates.latitude, coordinates.longitude),
        station: nearestStation.id,
        dateRange: `${startDate} to ${endDate}`,
        recordCount: rawHistoricalData.totalRecords,
      });

      res.json({
        location: this.locationEcho(req, location, coordinates),
        historical: historicalData,
        source: dataSource,
        dateRange: {
          startDate,
          endDate,
        },
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    } catch (error) {
      logger.error('Error getting historical weather:', {
        error: error.message,
        location: this.logLocationOf(req),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve historical weather data',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Get weather alerts for a location
   */
  async getWeatherAlerts(req, res) {
    try {
      const { location } = req.params;
      const { lat, lng } = req.query;

      const coordinates = this.parseLocationCoordinates(location, lat, lng);

      if (!coordinates) {
        return res.status(400).json({
          error: true,
          message: 'Valid coordinates required',
        });
      }

      if (!this.useRealData) {
        throw new Error('Real weather integration is disabled');
      }

      const cell = toCell(coordinates.latitude, coordinates.longitude);
      const { value: alertsData, status: cacheStatus } =
        await this.noaaCache.getOrLoad(
          cellKey('alerts', cell.latitude, cell.longitude),
          NOAA_TTL_MS.alerts,
          () => this.noaaWeatherService.getAlerts(cell.latitude, cell.longitude)
        );
      res.set('X-Cache', cacheStatus === 'MISS' ? 'MISS' : 'HIT');
      const dataSource = 'NOAA-NWS';

      logger.info('Retrieved weather alerts', {
        source: dataSource,
        location: logLocation(coordinates.latitude, coordinates.longitude),
        alertCount: alertsData.count,
      });

      res.json({
        location: this.locationEcho(req, location, coordinates),
        alerts: alertsData.alerts,
        count: alertsData.count,
        source: dataSource,
        timestamp: new Date().toISOString(),
        status: 'success',
      });
    } catch (error) {
      logger.error('Error getting weather alerts:', {
        error: error.message,
        location: this.logLocationOf(req),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve weather alerts',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Get nearby weather stations
   */
  async getNearbyStations(req, res) {
    try {
      const { lat, lng, radius = 50, limit = 10, source = 'all' } = req.query;

      if (!lat || !lng) {
        return res.status(400).json({
          error: true,
          message: 'Latitude and longitude are required',
        });
      }

      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (!this.isValidCoordinate(latitude, longitude)) {
        return res.status(400).json({
          error: true,
          message: 'Invalid coordinates provided',
        });
      }

      if (!this.useRealData || (source !== 'all' && source !== 'noaa')) {
        throw new Error('Real weather station integration is disabled');
      }

      const [nwsStations, dataServiceStations] = await Promise.allSettled([
        this.noaaWeatherService.getNearbyStations(
          latitude,
          longitude,
          parseInt(limit, 10)
        ),
        this.noaaDataService.findStationsNearLocation(
          latitude,
          longitude,
          parseInt(radius, 10),
          parseInt(limit, 10)
        ),
      ]);

      const allStations = [];

      if (nwsStations.status === 'fulfilled') {
        allStations.push(
          ...nwsStations.value.stations.map(station => ({
            ...station,
            source: 'NOAA-NWS',
            type: 'observation',
          }))
        );
      }

      if (dataServiceStations.status === 'fulfilled') {
        allStations.push(
          ...dataServiceStations.value.stations.map(station => ({
            ...station,
            source: 'NOAA-NCEI',
            type: 'historical',
          }))
        );
      }

      const uniqueStations = this.removeDuplicateStations(allStations);
      uniqueStations.sort((a, b) => (a.distance || 0) - (b.distance || 0));

      const stations = uniqueStations.slice(0, parseInt(limit, 10));
      const stationsData = {
        stations,
        count: uniqueStations.length,
      };
      const dataSource = 'NOAA';

      logger.info('Retrieved nearby weather stations', {
        source: dataSource,
        location: logLocation(latitude, longitude),
        radius: parseInt(radius, 10),
        stationCount: stationsData.count,
      });

      // Preserve metadata in headers while returning the array shape expected by
      // current frontend consumers of getStations().
      res.set('X-WRFCoin-Station-Count', String(stationsData.count));
      res.set('X-WRFCoin-Station-Source', dataSource);
      res.set('X-WRFCoin-Station-Radius', String(parseInt(radius, 10)));

      res.json(stations);
    } catch (error) {
      logger.error('Error getting nearby stations:', {
        error: error.message,
        location: logLocation(req.query.lat, req.query.lng),
      });

      res.status(500).json({
        error: true,
        message: 'Failed to retrieve nearby weather stations',
        details: this.errorDetails(req, error),
      });
    }
  }

  /**
   * Get health status of weather services
   */
  async getServicesHealth(req, res) {
    try {
      const healthChecks = await Promise.allSettled([
        this.noaaWeatherService.getHealthStatus(),
        this.noaaDataService.getHealthStatus(),
      ]);

      const health = {
        overall: 'healthy',
        services: {
          noaaWeather:
            healthChecks[0].status === 'fulfilled'
              ? healthChecks[0].value
              : { status: 'unhealthy', error: healthChecks[0].reason?.message },
          noaaData:
            healthChecks[1].status === 'fulfilled'
              ? healthChecks[1].value
              : { status: 'unhealthy', error: healthChecks[1].reason?.message },
        },
        configuration: {
          useRealData: this.useRealData,
          fallbackToMock: this.fallbackToMock,
        },
        timestamp: new Date().toISOString(),
      };

      // Determine overall health
      const unhealthyServices = Object.values(health.services).filter(
        service => service.status === 'unhealthy'
      );

      if (unhealthyServices.length > 0) {
        health.overall =
          unhealthyServices.length === Object.keys(health.services).length
            ? 'unhealthy'
            : 'degraded';
      }

      const statusCode =
        health.overall === 'healthy'
          ? 200
          : health.overall === 'degraded'
            ? 207
            : 503;

      res.status(statusCode).json(health);
    } catch (error) {
      logger.error('Error checking services health:', { error: error.message });

      res.status(500).json({
        overall: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Helper methods

  /**
   * The caller's position for a log line: 0.1 degree, never the raw path
   * segment or query (backend#1290).
   */
  logLocationOf(req) {
    const coordinates = this.parseLocationCoordinates(
      req.params?.location,
      req.query?.lat,
      req.query?.lng,
    );
    return coordinates
      ? logLocation(coordinates.latitude, coordinates.longitude)
      : null;
  }

  /**
   * The location echo (backend#1222, owner ruling 2026-10-01). Anonymous
   * callers get the parsed coordinates at one decimal and a canonical
   * "lat,lon" name built from them, never the raw input string, which can
   * carry the exact position in any form the parser accepts (one fine axis,
   * exponent or plus notation). Authorized callers keep the exact echo.
   */
  locationEcho(req, location, coordinates) {
    if (isAuthorizedForExactCoordinates(req)) {
      return { latitude: coordinates.latitude, longitude: coordinates.longitude, name: location };
    }
    const latitude = coarsenCoordinate(coordinates.latitude);
    const longitude = coarsenCoordinate(coordinates.longitude);
    return { latitude, longitude, name: `${latitude.toFixed(1)},${longitude.toFixed(1)}` };
  }

  /** An error's message for the response; anonymous callers get it with coordinates coarsened. */
  errorDetails(req, error) {
    const message = error && error.message;
    return isAuthorizedForExactCoordinates(req) ? message : redactCoordinateText(message);
  }

  parseLocationCoordinates(location, lat, lng) {
    // If lat/lng provided as query parameters
    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (this.isValidCoordinate(latitude, longitude)) {
        return { latitude, longitude };
      }
    }

    // Try to parse location as "latitude,longitude"
    if (location && location.includes(',')) {
      const [latStr, lngStr] = location.split(',');
      const latitude = parseFloat(latStr.trim());
      const longitude = parseFloat(lngStr.trim());

      if (this.isValidCoordinate(latitude, longitude)) {
        return { latitude, longitude };
      }
    }

    return null;
  }

  isValidCoordinate(latitude, longitude) {
    return (
      !isNaN(latitude) &&
      !isNaN(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  removeDuplicateStations(stations) {
    const seen = new Set();
    return stations.filter(station => {
      const key = `${station.id || station.name}_${station.latitude}_${station.longitude}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

}

module.exports = EnhancedWeatherController;
module.exports.noaaCache = noaaCache;
