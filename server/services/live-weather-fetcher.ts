/**
 * Live Weather Data Fetcher Service
 *
 * Fetches real weather data from community weather stations:
 * - the configured AcuRite Iris station (via local IP or MyAcuRite API)
 * - the configured Ambient Weather WS-5000 (via Ambient Weather Network API)
 *
 * Task 86: Technical Debt Cleanup - Replace hardcoded fake weather data
 */

import { weatherLogger, iotLogger } from '../utils/logger.js';

// Weather data interface
export interface LiveWeatherData {
  temperature: number;       // Celsius
  humidity: number;          // Percentage 0-100
  pressure?: number;         // hPa
  windSpeed?: number;        // m/s
  windDirection?: number;    // degrees
  rainfall?: number;         // mm
  uvIndex?: number;
  dewPoint?: number;         // Celsius
  feelsLike?: number;        // Celsius
  source: 'bryan-acurite' | 'jon-ambient' | 'local-connector' | 'mock';
  stationName: string;
  location: {
    city: string;
    lat: number;
    lon: number;
  };
  timestamp: Date;
  isMockData: boolean;
}

// Cache configuration
interface CacheEntry {
  data: LiveWeatherData;
  expiresAt: number;
}

// Service configuration from environment
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
  // Local weather station connector
  localConnector: {
    url: process.env.WEATHER_CONNECTOR_URL || 'http://localhost:4200',
  },
  // Cache TTL in milliseconds (5 minutes)
  cacheTtl: 5 * 60 * 1000,
  // Request timeout in milliseconds
  requestTimeout: 15000,
};

// In-memory cache for weather data
const weatherCache: Map<string, CacheEntry> = new Map();

/**
 * Fetch weather data from the configured AcuRite station via local IP
 */
async function fetchFromAcuRiteLocal(): Promise<LiveWeatherData | null> {
  if (!CONFIG.acurite.localIp) {
    weatherLogger.debug('ACURITE_LOCAL_IP not configured, skipping local AcuRite fetch');
    return null;
  }

  try {
    weatherLogger.info('Fetching weather data from the configured AcuRite station via local IP', {
      localIp: CONFIG.acurite.localIp
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

    const response = await fetch(`http://${CONFIG.acurite.localIp}/weather`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();

    // Map AcuRite local response to our format
    const weatherData: LiveWeatherData = {
      temperature: convertFahrenheitToCelsius(data.tempf ?? data.temperature),
      humidity: data.humidity ?? data.humidity_outdoor,
      pressure: data.baromin ? data.baromin * 33.8639 : data.pressure,
      windSpeed: data.windspeedmph ? data.windspeedmph * 0.44704 : data.windSpeed,
      windDirection: data.winddir ?? data.windDirection,
      rainfall: data.dailyrainin ? data.dailyrainin * 25.4 : data.rainfall,
      dewPoint: data.dewptf ? convertFahrenheitToCelsius(data.dewptf) : undefined,
      source: 'bryan-acurite',
      stationName: "the configured AcuRite Iris® (Local)",
      location: {
        city: 'Duluth, MN',
        lat: 46.7867,
        lon: -92.1005,
      },
      timestamp: new Date(),
      isMockData: false,
    };

    weatherLogger.info('Successfully fetched weather data from the configured AcuRite station', {
      temperature: weatherData.temperature,
      humidity: weatherData.humidity,
      source: weatherData.source,
    });

    return weatherData;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    weatherLogger.warn('Failed to fetch from the configured AcuRite local IP', {
      error: { message: errorMessage },
      localIp: CONFIG.acurite.localIp,
    });
    return null;
  }
}

/**
 * Fetch weather data from the configured Ambient Weather WS-5000 via API
 */
async function fetchFromAmbientWeather(): Promise<LiveWeatherData | null> {
  if (!CONFIG.ambient.apiKey || !CONFIG.ambient.appKey) {
    weatherLogger.debug('Ambient Weather API keys not configured, skipping Ambient fetch');
    return null;
  }

  try {
    weatherLogger.info('Fetching weather data from the configured Ambient Weather WS-5000');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

    const url = `${CONFIG.ambient.apiBaseUrl}/devices?apiKey=${CONFIG.ambient.apiKey}&applicationKey=${CONFIG.ambient.appKey}`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const devices: any = await response.json();

    // Handle various response formats
    let deviceData: any = null;
    if (Array.isArray(devices) && devices.length > 0) {
      deviceData = devices[0];
    } else if (devices && typeof devices === 'object') {
      deviceData = devices;
    }

    if (!deviceData || !deviceData.lastData) {
      throw new Error('No device data available from Ambient Weather API');
    }

    const lastData = deviceData.lastData;

    // Map Ambient Weather response to our format
    const weatherData: LiveWeatherData = {
      temperature: lastData.tempf !== undefined ? convertFahrenheitToCelsius(lastData.tempf) : 0,
      humidity: lastData.humidity ?? lastData.humidityin ?? 0,
      pressure: lastData.baromrelin ? lastData.baromrelin * 33.8639 : undefined,
      windSpeed: lastData.windspeedmph ? lastData.windspeedmph * 0.44704 : undefined,
      windDirection: lastData.winddir,
      rainfall: lastData.dailyrainin ? lastData.dailyrainin * 25.4 : undefined,
      uvIndex: lastData.uv,
      dewPoint: lastData.dewPoint !== undefined ? convertFahrenheitToCelsius(lastData.dewPoint) : undefined,
      feelsLike: lastData.feelsLike !== undefined ? convertFahrenheitToCelsius(lastData.feelsLike) : undefined,
      source: 'jon-ambient',
      stationName: deviceData.info?.name || "the configured Ambient Weather WS-5000",
      location: {
        city: 'Duluth, MN',
        lat: deviceData.info?.coords?.geo?.coordinates?.[1] ?? 46.7867,
        lon: deviceData.info?.coords?.geo?.coordinates?.[0] ?? -92.1005,
      },
      timestamp: new Date(lastData.dateutc ?? Date.now()),
      isMockData: false,
    };

    weatherLogger.info('Successfully fetched weather data from the configured Ambient Weather station', {
      temperature: weatherData.temperature,
      humidity: weatherData.humidity,
      source: weatherData.source,
      stationName: weatherData.stationName,
    });

    return weatherData;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    weatherLogger.warn('Failed to fetch from the configured Ambient Weather API', {
      error: { message: errorMessage },
    });
    return null;
  }
}

/**
 * Fetch weather data from local weather station connector service
 */
async function fetchFromLocalConnector(): Promise<LiveWeatherData | null> {
  try {
    iotLogger.info('Fetching weather data from local connector', {
      url: CONFIG.localConnector.url,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

    const response = await fetch(`${CONFIG.localConnector.url}/weather-data`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: any = await response.json();

    // Map local connector response to our format
    const weatherData: LiveWeatherData = {
      temperature: data.temperature ?? 0,
      humidity: data.humidity ?? 0,
      pressure: data.pressure,
      windSpeed: data.windSpeed,
      windDirection: data.windDirection,
      rainfall: data.rainfall,
      source: 'local-connector',
      stationName: data.stationName || 'Local Weather Station',
      location: {
        city: data.location?.city || 'Duluth, MN',
        lat: data.location?.lat ?? 46.7867,
        lon: data.location?.lon ?? -92.1005,
      },
      timestamp: new Date(data.timestamp ?? Date.now()),
      isMockData: data.isMockData ?? false,
    };

    iotLogger.info('Successfully fetched weather data from local connector', {
      temperature: weatherData.temperature,
      humidity: weatherData.humidity,
      source: weatherData.source,
    });

    return weatherData;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    iotLogger.debug('Local weather connector not available', {
      error: { message: errorMessage },
      url: CONFIG.localConnector.url,
    });
    return null;
  }
}

/**
 * Generate mock weather data as a last resort fallback
 */
function getMockWeatherData(): LiveWeatherData {
  // Generate realistic mock data for Duluth, MN
  const now = new Date();
  const month = now.getMonth();

  // Seasonal temperature adjustments for Duluth, MN
  const seasonalBaseTemp: Record<number, number> = {
    0: -10, 1: -8, 2: -2, 3: 5,    // Winter/early spring
    4: 12, 5: 17, 6: 21, 7: 20,   // Late spring/summer
    8: 15, 9: 8, 10: 1, 11: -6,   // Fall/early winter
  };

  const baseTemp = seasonalBaseTemp[month] ?? 10;
  const tempVariation = (Math.random() - 0.5) * 10;
  const temperature = Math.round((baseTemp + tempVariation) * 10) / 10;
  const humidity = Math.round(50 + Math.random() * 30);

  weatherLogger.warn('Using mock weather data - no live sources available', {
    reason: 'All weather data sources unavailable',
  });

  return {
    temperature,
    humidity,
    pressure: 1013.25 + (Math.random() - 0.5) * 20,
    source: 'mock',
    stationName: 'Mock Weather Data (No Live Sources)',
    location: {
      city: 'Duluth, MN',
      lat: 46.7867,
      lon: -92.1005,
    },
    timestamp: now,
    isMockData: true,
  };
}

/**
 * Convert Fahrenheit to Celsius
 */
function convertFahrenheitToCelsius(fahrenheit: number): number {
  return Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;
}

/**
 * Get cached weather data if available and not expired
 */
function getCachedData(cacheKey: string): LiveWeatherData | null {
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    weatherLogger.debug('Returning cached weather data', {
      source: cached.data.source,
      age: Math.round((Date.now() - cached.data.timestamp.getTime()) / 1000),
    });
    return cached.data;
  }
  return null;
}

/**
 * Cache weather data
 */
function cacheData(cacheKey: string, data: LiveWeatherData): void {
  weatherCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + CONFIG.cacheTtl,
  });
}

/**
 * Main function: Fetch live weather data with fallback chain
 *
 * Priority order:
 * 1. the configured AcuRite station via local IP (fastest, most reliable)
 * 2. the configured Ambient Weather WS-5000 via API
 * 3. Local weather station connector (port 4200)
 * 4. Mock data as last resort
 */
export async function fetchLiveWeatherData(): Promise<LiveWeatherData> {
  const cacheKey = 'duluth-weather';

  // Check cache first
  const cached = getCachedData(cacheKey);
  if (cached) {
    return cached;
  }

  weatherLogger.info('Fetching live weather data from Duluth, MN stations');

  // Try the configured AcuRite station first (local IP is fastest)
  let weatherData = await fetchFromAcuRiteLocal();

  // Fallback to the configured Ambient Weather if AcuRite unavailable
  if (!weatherData) {
    weatherData = await fetchFromAmbientWeather();
  }

  // Fallback to local connector if both stations unavailable
  if (!weatherData) {
    weatherData = await fetchFromLocalConnector();
  }

  // Last resort: mock data
  if (!weatherData) {
    weatherData = getMockWeatherData();
  }

  // Cache the result
  cacheData(cacheKey, weatherData);

  return weatherData;
}

/**
 * Get weather data from a specific source
 */
export async function fetchWeatherDataFromSource(
  source: 'bryan-acurite' | 'jon-ambient' | 'local-connector'
): Promise<LiveWeatherData | null> {
  switch (source) {
    case 'bryan-acurite':
      return fetchFromAcuRiteLocal();
    case 'jon-ambient':
      return fetchFromAmbientWeather();
    case 'local-connector':
      return fetchFromLocalConnector();
    default:
      return null;
  }
}

/**
 * Get all available weather sources status
 */
export async function getWeatherSourcesStatus(): Promise<{
  sources: Array<{
    name: string;
    source: string;
    available: boolean;
    configured: boolean;
    lastData?: LiveWeatherData;
  }>;
  primarySource: string | null;
}> {
  const sources = [
    {
      name: "the configured AcuRite Iris",
      source: 'bryan-acurite' as const,
      configured: !!CONFIG.acurite.localIp,
    },
    {
      name: "the configured Ambient Weather WS-5000",
      source: 'jon-ambient' as const,
      configured: !!(CONFIG.ambient.apiKey && CONFIG.ambient.appKey),
    },
    {
      name: 'Local Weather Connector',
      source: 'local-connector' as const,
      configured: true, // Always configured with default URL
    },
  ];

  const results = await Promise.all(
    sources.map(async (src) => {
      let available = false;
      let lastData: LiveWeatherData | undefined;

      if (src.configured) {
        try {
          lastData = await fetchWeatherDataFromSource(src.source) ?? undefined;
          available = lastData !== null && lastData !== undefined;
        } catch {
          available = false;
        }
      }

      return {
        name: src.name,
        source: src.source,
        available,
        configured: src.configured,
        lastData,
      };
    })
  );

  const primarySource = results.find(s => s.available)?.source ?? null;

  return {
    sources: results,
    primarySource,
  };
}

/**
 * Clear the weather data cache
 */
export function clearWeatherCache(): void {
  weatherCache.clear();
  weatherLogger.info('Weather data cache cleared');
}

export default {
  fetchLiveWeatherData,
  fetchWeatherDataFromSource,
  getWeatherSourcesStatus,
  clearWeatherCache,
};
