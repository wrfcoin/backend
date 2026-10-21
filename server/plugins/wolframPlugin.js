/**
 * Wolfram Alpha & Language Plugin
 *
 * This plugin integrates with the Wolfram Alpha API and Wolfram Language
 * to provide computational intelligence capabilities to the Wrfcoin Core platform.
 */

const { db } = require('../db');
const { wolframSettings } = require('../../shared/schema');
const { eq } = require('drizzle-orm');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const { aimlLogger } = require('../utils/logger.js');

// Cache for query results
const queryCache = new Map();
// Default TTL for cache entries (24 hours)
const DEFAULT_CACHE_TTL = 24 * 60 * 60 * 1000;

// Default settings
const DEFAULT_SETTINGS = {
  apiKey: '',
  useCaching: true,
  cacheTTL: DEFAULT_CACHE_TTL,
  useAlternativeEndpoint: false,
  alternativeEndpoint: '',
  maxQueriesPerDay: 1000,
  preferShortAnswers: true,
  timeoutMs: 30000,
};

/**
 * Initialize settings from database or create default settings
 */
async function initializeSettings() {
  try {
    const existingSettings = await db.select().from(wolframSettings).limit(1);

    if (existingSettings.length === 0) {
      // Create default settings if none exist
      const [settings] = await db
        .insert(wolframSettings)
        .values(DEFAULT_SETTINGS)
        .returning();
      aimlLogger.info('Created default Wolfram settings', {
        operation: 'wolfram:settings:created',
      });
      return settings;
    }

    return existingSettings[0];
  } catch (error) {
    aimlLogger.error('Error initializing Wolfram settings', {
      operation: 'wolfram:settings:init:error',
      error: error.message,
    });
    // Return default settings if database operation fails
    return DEFAULT_SETTINGS;
  }
}

/**
 * Helper function to check API key
 */
function checkApiKey() {
  return new Promise(async (resolve, reject) => {
    const settings = await getSettings();

    if (!settings.apiKey) {
      reject(new Error('Wolfram Alpha API key is not configured'));
    } else {
      resolve(settings.apiKey);
    }
  });
}

/**
 * Generate cache key for a query
 */
function generateCacheKey(query, options = {}) {
  const data = JSON.stringify({ query, options });
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * General query to Wolfram Alpha
 */
async function queryWolframAlpha(query, options = {}) {
  try {
    const settings = await getSettings();
    const apiKey = await checkApiKey();

    // Check cache if enabled
    if (settings.useCaching) {
      const cacheKey = generateCacheKey(query, options);
      const cachedResult = queryCache.get(cacheKey);

      if (
        cachedResult &&
        Date.now() - cachedResult.timestamp < settings.cacheTTL
      ) {
        return cachedResult.data;
      }
    }

    // Prepare API request parameters
    const params = {
      input: query,
      appid: apiKey,
      output: 'json',
      ...options,
    };

    // Determine API endpoint
    const endpoint =
      settings.useAlternativeEndpoint && settings.alternativeEndpoint
        ? settings.alternativeEndpoint
        : 'https://api.wolframalpha.com/v2/query';

    // Make request to Wolfram Alpha API
    const response = await makeHttpRequest(
      `${endpoint}?${querystring.stringify(params)}`
    );
    const data = JSON.parse(response);
    const result = processWolframResponse(data);

    // Cache the result if caching is enabled
    if (settings.useCaching) {
      const cacheKey = generateCacheKey(query, options);
      queryCache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
      });
    }

    return result;
  } catch (error) {
    aimlLogger.error('Error querying Wolfram Alpha', {
      operation: 'wolfram:query:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Process the Wolfram Alpha API response
 */
function processWolframResponse(data) {
  // Check if the query was successful
  if (data.queryresult && data.queryresult.success === false) {
    if (data.queryresult.error) {
      throw new Error(`Wolfram Alpha error: ${data.queryresult.error.msg}`);
    }

    throw new Error('Wolfram Alpha query was not successful');
  }

  return data.queryresult;
}

/**
 * Execute a computation using Wolfram Language
 */
async function executeWolframLanguage(code) {
  try {
    const settings = await getSettings();
    const apiKey = await checkApiKey();

    // Prepare API request parameters
    const params = {
      input: code,
      appid: apiKey,
      output: 'json',
      format: 'wolfram',
    };

    // Use the cloud API for Wolfram Language
    const endpoint = 'https://api.wolframalpha.com/v2/cloud';

    // Make request to Wolfram Cloud API
    const response = await makeHttpRequest(
      `${endpoint}?${querystring.stringify(params)}`
    );
    const data = JSON.parse(response);

    return data;
  } catch (error) {
    aimlLogger.error('Error executing Wolfram Language code', {
      operation: 'wolfram:language:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get a short answer from Wolfram Alpha
 */
async function getShortAnswer(query) {
  try {
    const apiKey = await checkApiKey();

    // Use the short answers API
    const params = {
      input: query,
      appid: apiKey,
      output: 'json',
      units: 'metric',
    };

    const endpoint = 'https://api.wolframalpha.com/v1/result';

    // Make request to Wolfram Alpha short answers API
    const response = await makeHttpRequest(
      `${endpoint}?${querystring.stringify(params)}`
    );

    return response;
  } catch (error) {
    aimlLogger.error('Error getting short answer from Wolfram Alpha', {
      operation: 'wolfram:shortanswer:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get full results from Wolfram Alpha
 */
async function getFullResults(query) {
  try {
    // Use the full results API with all pods
    return await queryWolframAlpha(query, {
      includepodid: '*',
      format: 'plaintext,image',
      podstate: 'Show all',
      magnification: '1.5',
    });
  } catch (error) {
    aimlLogger.error('Error getting full results from Wolfram Alpha', {
      operation: 'wolfram:fullresults:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Analyze weather data using Wolfram computational intelligence
 */
async function analyzeWeatherData(data) {
  try {
    // Format the weather data into a Wolfram query
    const query = formatWeatherDataQuery(data);

    // Use the full results API with specific pods for weather analysis
    const result = await queryWolframAlpha(query, {
      includepodid:
        'WeatherForecast,WeatherPods,HourlyForecast,Statistics,DataAnalysis',
      format: 'plaintext,image',
    });

    return result;
  } catch (error) {
    aimlLogger.error('Error analyzing weather data with Wolfram', {
      operation: 'wolfram:weather:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Format weather data into a Wolfram query
 */
function formatWeatherDataQuery(data) {
  // Extract key data points and format as a natural language query
  const dataPoints = [];

  if (data.temperature) {
    dataPoints.push(`temperature ${data.temperature}°C`);
  }

  if (data.precipitation) {
    dataPoints.push(`precipitation ${data.precipitation}mm`);
  }

  if (data.humidity) {
    dataPoints.push(`humidity ${data.humidity}%`);
  }

  if (data.windSpeed) {
    dataPoints.push(`wind speed ${data.windSpeed}km/h`);
  }

  if (data.pressure) {
    dataPoints.push(`pressure ${data.pressure}hPa`);
  }

  if (data.location) {
    return `weather analysis for ${data.location} with ${dataPoints.join(', ')}`;
  } else {
    return `weather analysis with ${dataPoints.join(', ')}`;
  }
}

/**
 * Run a climate model using Wolfram
 */
async function runClimateModel(parameters) {
  try {
    // Prepare a Wolfram Language code snippet for climate modeling
    const code = `
      climatePrediction = WeatherForecastData[
        ${parameters.location ? `"${parameters.location}"` : 'GeoPosition[{' + parameters.latitude + ',' + parameters.longitude + '}]'},
        ${parameters.elements ? `{"${parameters.elements.join('", "')}"}` : '{"Temperature", "Pressure", "Precipitation", "Humidity"}'},
        {${parameters.startDate ? `"${parameters.startDate}"` : 'Now'}, 
         ${parameters.duration ? `Quantity[${parameters.duration}, "${parameters.durationUnit || 'Days'}"]` : 'Quantity[10, "Days"]'}}
      ];
      
      {
        "prediction" -> Normal[climatePrediction],
        "statistics" -> {
          "mean" -> Map[Mean, Normal[climatePrediction]],
          "max" -> Map[Max, Normal[climatePrediction]],
          "min" -> Map[Min, Normal[climatePrediction]]
        },
        "plots" -> Map[DateListPlot[#, PlotTheme -> "Detailed", ImageSize -> 500] &, Normal[climatePrediction]]
      }
    `;

    return await executeWolframLanguage(code);
  } catch (error) {
    aimlLogger.error('Error running climate model with Wolfram', {
      operation: 'wolfram:climate:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Process natural language with Wolfram
 */
async function processNaturalLanguage(text) {
  try {
    // Use the conversational API for natural language processing
    const apiKey = await checkApiKey();

    const params = {
      input: text,
      appid: apiKey,
      output: 'json',
      conversationid: crypto.randomBytes(16).toString('hex'),
    };

    const endpoint = 'https://api.wolframalpha.com/v1/conversation.jsp';

    const response = await makeHttpRequest(
      `${endpoint}?${querystring.stringify(params)}`
    );
    const data = JSON.parse(response);

    return data;
  } catch (error) {
    aimlLogger.error('Error processing natural language with Wolfram', {
      operation: 'wolfram:nlp:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get integration status
 */
async function getStatus() {
  try {
    const settings = await getSettings();

    return {
      isConfigured: !!settings.apiKey,
      cacheEnabled: settings.useCaching,
      cacheEntries: settings.useCaching ? queryCache.size : 0,
      alternativeEndpointEnabled: settings.useAlternativeEndpoint,
    };
  } catch (error) {
    aimlLogger.error('Error getting Wolfram integration status', {
      operation: 'wolfram:status:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get current settings
 */
async function getSettings() {
  try {
    const settings = await db.select().from(wolframSettings).limit(1);

    if (settings.length === 0) {
      return initializeSettings();
    }

    return settings[0];
  } catch (error) {
    aimlLogger.error('Error getting Wolfram settings', {
      operation: 'wolfram:settings:get:error',
      error: error.message,
    });
    // Return default settings if database operation fails
    return DEFAULT_SETTINGS;
  }
}

/**
 * Update settings
 */
async function updateSettings(newSettings) {
  try {
    const settings = await getSettings();

    // Update settings in the database
    const [updatedSettings] = await db
      .update(wolframSettings)
      .set({
        ...settings,
        ...newSettings,
        updatedAt: new Date(),
      })
      .where(eq(wolframSettings.id, settings.id))
      .returning();

    aimlLogger.info('Updated Wolfram settings', {
      operation: 'wolfram:settings:updated',
    });

    // If cache TTL changed, clear the cache
    if (newSettings.cacheTTL !== settings.cacheTTL) {
      queryCache.clear();
    }

    return updatedSettings;
  } catch (error) {
    aimlLogger.error('Error updating Wolfram settings', {
      operation: 'wolfram:settings:update:error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Helper function to make HTTP requests
 */
function makeHttpRequest(url) {
  return new Promise(async (resolve, reject) => {
    const settings = await getSettings();

    const request = https.get(
      url,
      { timeout: settings.timeoutMs },
      response => {
        let data = '';

        response.on('data', chunk => {
          data += chunk;
        });

        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP error: ${response.statusCode} - ${data}`));
          }
        });
      }
    );

    request.on('error', error => {
      reject(error);
    });

    request.on('timeout', () => {
      request.abort();
      reject(new Error(`Request timed out after ${settings.timeoutMs}ms`));
    });
  });
}

/**
 * Initialize the Wolfram plugin
 * @param {Object} config - Configuration object
 * @returns {Promise<boolean>} - Success status
 */
async function initialize(config = {}) {
  try {
    aimlLogger.debug('Initializing Wolfram plugin', {
      operation: 'wolfram:init:start',
      hasAppId: !!config.appId,
    });
    // If an appId is provided in the config, use it
    if (config.appId) {
      try {
        await updateSettings({ apiKey: config.appId });
        aimlLogger.info('Updated Wolfram API key from config', {
          operation: 'wolfram:init:apikey:updated',
        });
      } catch (error) {
        // If database update fails, we'll just continue with existing settings
        aimlLogger.warn('Could not update Wolfram API key in database', {
          operation: 'wolfram:init:apikey:warning',
          error: error.message,
        });
      }
    }

    // Initialize settings
    const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
    aimlLogger.info('Wolfram plugin initialized successfully', {
      operation: 'wolfram:init:success',
    });
    return true;
  } catch (error) {
    aimlLogger.error('Failed to initialize Wolfram plugin', {
      operation: 'wolfram:init:error',
      error: error.message,
    });
    return false;
  }
}

module.exports = {
  initialize,
  queryWolframAlpha,
  executeWolframLanguage,
  getShortAnswer,
  getFullResults,
  analyzeWeatherData,
  runClimateModel,
  processNaturalLanguage,
  getStatus,
  getSettings,
  updateSettings,
};
