// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

#!/usr/bin/env node

/**
 * SUPER EASY WEATHER STATION CONNECTOR for Wrfcoin
 * Makes connecting any weather station to WRF network incredibly simple
 *
 * Task 86: Updated to use Winston loggers instead of console.log
 */

const express = require('express');
const WebSocket = require('ws');
const { createHash } = require('crypto');

// Winston logger setup with fallback for standalone usage
let weatherLogger;
let iotLogger;
const WEATHER_SCHEMA_V1 = 'wrf.weather.observation.v1';

try {
    const logger = require('./utils/logger');
    weatherLogger = logger.weatherLogger;
    iotLogger = logger.iotLogger;
} catch (e) {
    // Fallback to console-based logger for standalone mode
    const createFallbackLogger = (prefix) => ({
        info: (msg, meta) => console.log(`[${prefix}] INFO: ${msg}`, meta ? JSON.stringify(meta) : ''),
        warn: (msg, meta) => console.log(`[${prefix}] WARN: ${msg}`, meta ? JSON.stringify(meta) : ''),
        error: (msg, meta) => console.error(`[${prefix}] ERROR: ${msg}`, meta ? JSON.stringify(meta) : ''),
        debug: (msg, meta) => process.env.DEBUG && console.log(`[${prefix}] DEBUG: ${msg}`, meta ? JSON.stringify(meta) : ''),
    });
    weatherLogger = createFallbackLogger('WEATHER');
    iotLogger = createFallbackLogger('IOT');
}

function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function pickNumber(payload, keys) {
    for (const key of keys) {
        const parsed = toFiniteNumber(payload[key]);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
}

function buildCanonicalPayload(stationId, timestampMs, payload) {
    const source = payload && typeof payload.observation === 'object' && payload.observation !== null
        ? payload.observation
        : payload;
    const observation = {};
    const temperature = pickNumber(source, ['temperature_c', 'temperature', 'temp_c', 'temperature_celsius']);
    const humidity = pickNumber(source, ['humidity', 'relative_humidity']);
    const pressure = pickNumber(source, ['pressure_hpa', 'pressure']);
    const windSpeed = pickNumber(source, ['wind_speed_ms', 'windSpeed', 'wind_speed']);
    const precipitation = pickNumber(source, ['precipitation', 'rainfall', 'precip_mm', 'precipitation_mm']);
    const dewpoint = pickNumber(source, ['dewpoint_c', 'dewpoint', 'dew_point']);

    if (temperature !== undefined) observation.temperature_c = temperature;
    if (humidity !== undefined) observation.humidity = humidity;
    if (pressure !== undefined) observation.pressure_hpa = pressure;
    if (windSpeed !== undefined) observation.wind_speed_ms = windSpeed;
    if (precipitation !== undefined) observation.precipitation = precipitation;
    if (dewpoint !== undefined) observation.dewpoint_c = dewpoint;

    return {
        schema_version: WEATHER_SCHEMA_V1,
        station_id: stationId,
        observed_at_unix: Math.floor(timestampMs / 1000),
        observation,
    };
}

function detectLegacyAliasKeys(payload) {
    const aliasKeys = [
        'stationId',
        'temperature',
        'temp_c',
        'temperature_celsius',
        'pressure',
        'windSpeed',
        'wind_speed',
        'rainfall',
        'precip_mm',
        'precipitation_mm',
        'dewpoint',
        'dew_point',
        'relative_humidity',
    ];
    return aliasKeys.filter(key => payload[key] !== undefined).sort();
}

class WeatherStationConnector {
    constructor(discoveryNodeURL) {
        this.app = express();
        this.port = 4200;
        this.discoveryNodeURL = discoveryNodeURL || 'http://172.31.128.78:4000';
        this.stationId = this.generateStationId();
        this.weatherData = [];
        this.isConnected = false;

        weatherLogger.info('Initializing Weather Station Connector', {
            stationId: this.stationId,
            discoveryNode: this.discoveryNodeURL,
            port: this.port,
        });
    }

    generateStationId() {
        return 'weather-' + Math.random().toString(36).substr(2, 8);
    }

    setupAPI() {
        this.app.use(express.json());

        // Enable CORS with specific origins for security (resolved once at
        // setup so production misconfiguration refuses startup, backend#1236)
        const allowedOrigins = resolveAllowedOrigins({ developmentDefaults: [
            'http://localhost:5000',
            'http://localhost:4200',
            'https://wrfcoin.replit.app',
            'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev'
        ] });
        this.app.use((req, res, next) => {

            const origin = req.headers.origin;
            if (allowedOrigins.includes(origin)) {
                res.header('Access-Control-Allow-Origin', origin);
            }

            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Access-Control-Allow-Credentials', 'false');

            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
                return;
            }
            next();
        });

        // Weather data submission endpoint
        this.app.post('/submit-weather', (req, res) => {
            const requestPayload = req.body || {};
            const timestampMs = Date.now();
            const canonicalPayload = buildCanonicalPayload(
                this.stationId,
                timestampMs,
                requestPayload
            );
            const weatherReading = {
                stationId: this.stationId,
                timestamp: timestampMs,
                temperature: canonicalPayload.observation.temperature_c,
                humidity: canonicalPayload.observation.humidity,
                pressure: canonicalPayload.observation.pressure_hpa,
                windSpeed: canonicalPayload.observation.wind_speed_ms,
                windDirection: pickNumber(requestPayload, ['windDirection', 'wind_direction']),
                rainfall: canonicalPayload.observation.precipitation,
                dewpoint: canonicalPayload.observation.dewpoint_c,
                location: requestPayload.location || 'Unknown',
                canonicalPayload,
                raw: requestPayload
            };

            const legacyAliasKeys = detectLegacyAliasKeys(requestPayload);
            if (legacyAliasKeys.length > 0) {
                weatherLogger.warn('Legacy weather payload aliases ingested', {
                    route: '/submit-weather',
                    stationId: this.stationId,
                    schemaVersion: WEATHER_SCHEMA_V1,
                    legacyKeys: legacyAliasKeys,
                });
            }

            this.weatherData.push(weatherReading);

            // Keep only last 100 readings
            if (this.weatherData.length > 100) {
                this.weatherData = this.weatherData.slice(-100);
            }

            weatherLogger.info('Weather data received', {
                stationId: this.stationId,
                temperature: weatherReading.temperature,
                humidity: weatherReading.humidity,
                location: weatherReading.location,
                timestamp: weatherReading.timestamp,
                schemaVersion: weatherReading.canonicalPayload.schema_version,
            });

            // Send to Wrfcoin network
            this.sendToWrfcoinNetwork(weatherReading);

            res.json({
                success: true,
                stationId: this.stationId,
                timestamp: weatherReading.timestamp,
                canonicalPayload: weatherReading.canonicalPayload,
                message: 'Weather data submitted to Wrfcoin network',
                networkStatus: this.isConnected ? 'Connected' : 'Connecting'
            });
        });

        // Get weather station status
        this.app.get('/status', (req, res) => {
            res.json({
                stationId: this.stationId,
                isConnected: this.isConnected,
                discoveryNode: this.discoveryNodeURL,
                totalReadings: this.weatherData.length,
                lastReading: this.weatherData.length > 0 ? this.weatherData[this.weatherData.length - 1] : null,
                uptime: process.uptime()
            });
        });

        // Get recent weather data
        this.app.get('/weather-data', (req, res) => {
            const limit = parseInt(req.query.limit, 10) || 10;
            res.json({
                stationId: this.stationId,
                readings: this.weatherData.slice(-limit),
                totalCount: this.weatherData.length
            });
        });

        // Easy setup page
        this.app.get('/', (req, res) => {
            res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Weather Station Connector</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f0f8ff; }
                    .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .highlight { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; }
                    .command { background: #f0f0f0; padding: 10px; border-radius: 5px; font-family: monospace; margin: 10px 0; }
                    .status { display: inline-block; padding: 5px 10px; border-radius: 15px; font-size: 12px; }
                    .connected { background: #27ae60; color: white; }
                    .disconnected { background: #e74c3c; color: white; }
                    .form-group { margin: 15px 0; }
                    input, select { padding: 8px; margin: 5px; border: 1px solid #ddd; border-radius: 4px; }
                    button { background: #3498db; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
                    .green { color: #27ae60; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Weather Station Connector</h1>
                    <div class="status ${this.isConnected ? 'connected' : 'disconnected'}" id="status">
                        ${this.isConnected ? 'CONNECTED' : 'CONNECTING'}
                    </div>

                    <div class="highlight">
                        <h2>Station Info:</h2>
                        <p><strong>Station ID:</strong> ${this.stationId}</p>
                        <p><strong>Connected to:</strong> ${this.discoveryNodeURL}</p>
                        <p><strong>Total Readings:</strong> <span id="readingCount">${this.weatherData.length}</span></p>
                    </div>

                    <h3>Submit Weather Reading:</h3>
                    <form id="weatherForm">
                        <div class="form-group">
                            <input type="number" id="temperature_c" placeholder="temperature_c (\u00B0C)" step="0.1" required>
                            <input type="number" id="humidity" placeholder="Humidity (%)" step="0.1" required>
                        </div>
                        <div class="form-group">
                            <input type="number" id="pressure_hpa" placeholder="pressure_hpa (hPa)" step="0.1">
                            <input type="number" id="wind_speed_ms" placeholder="wind_speed_ms (m/s)" step="0.1">
                        </div>
                        <div class="form-group">
                            <input type="number" id="windDirection" placeholder="Wind Direction (degrees)" step="1">
                            <input type="number" id="precipitation" placeholder="precipitation (mm)" step="0.1">
                        </div>
                        <div class="form-group">
                            <input type="text" id="location" placeholder="Location (optional)">
                        </div>
                        <button type="submit">Submit to Wrfcoin Network</button>
                    </form>

                    <div id="result" style="margin-top: 20px;"></div>

                    <h3>Easy Integration Commands:</h3>
                    <p><strong>For automated weather stations:</strong></p>
                    <div class="command">
curl -X POST http://localhost:${this.port}/submit-weather \\\\<br>
  -H "Content-Type: application/json" \\\\<br>
  -d '{"temperature_c": 22.5, "humidity": 65.2, "pressure_hpa": 1013.25, "schema_version": "wrf.weather.observation.v1"}'
                    </div>

                    <h3>Recent Readings:</h3>
                    <div id="recentReadings">Loading...</div>
                </div>

                <script>
                    document.getElementById('weatherForm').addEventListener('submit', async (e) => {
                        e.preventDefault();

                        const data = {
                            temperature_c: parseFloat(document.getElementById('temperature_c').value),
                            humidity: parseFloat(document.getElementById('humidity').value),
                            pressure_hpa: parseFloat(document.getElementById('pressure_hpa').value) || null,
                            wind_speed_ms: parseFloat(document.getElementById('wind_speed_ms').value) || null,
                            windDirection: parseFloat(document.getElementById('windDirection').value) || null,
                            precipitation: parseFloat(document.getElementById('precipitation').value) || null,
                            location: document.getElementById('location').value || null
                        };

                        try {
                            const response = await fetch('/submit-weather', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(data)
                            });

                            const result = await response.json();
                            const resultDiv = document.getElementById('result');
                            resultDiv.innerHTML = '';
                            const successDiv = document.createElement('div');
                            successDiv.style.cssText = 'background: #d4edda; color: #155724; padding: 15px; border-radius: 5px;';
                            successDiv.innerHTML = '<strong>Success!</strong> Data sent to Wrfcoin network<br>Station ID: <span></span><br>Timestamp: <span></span>';
                            successDiv.children[0].textContent = result.stationId || 'Unknown';
                            successDiv.children[1].textContent = new Date(result.timestamp).toLocaleString();
                            resultDiv.appendChild(successDiv);

                            // Clear form
                            document.getElementById('weatherForm').reset();
                            updateReadings();

                        } catch (error) {
                            const resultDiv = document.getElementById('result');
                            resultDiv.innerHTML = '';
                            const errorDiv = document.createElement('div');
                            errorDiv.style.cssText = 'background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px;';
                            errorDiv.innerHTML = 'Error: <span></span>';
                            errorDiv.children[0].textContent = error.message || 'Unknown error occurred';
                            resultDiv.appendChild(errorDiv);
                        }
                    });

                    async function updateReadings() {
                        try {
                            const response = await fetch('/weather-data?limit=5');
                            const data = await response.json();

                            const readingsContainer = document.getElementById('recentReadings');
                            readingsContainer.innerHTML = '';

                            if (data.readings && data.readings.length > 0) {
                                data.readings.forEach(reading => {
                                    const readingDiv = document.createElement('div');
                                    readingDiv.style.cssText = 'background: #f8f9fa; padding: 10px; margin: 5px 0; border-radius: 5px;';

                                    const timestamp = document.createElement('strong');
                                    timestamp.textContent = new Date(reading.timestamp).toLocaleString();
                                    readingDiv.appendChild(timestamp);
                                    readingDiv.appendChild(document.createElement('br'));

                                    const tempText = document.createTextNode('Temp: ' + (reading.temperature || 'N/A') + 'C, Humidity: ' + (reading.humidity || 'N/A') + '%');
                                    readingDiv.appendChild(tempText);

                                    if (reading.pressure) {
                                        const pressureText = document.createTextNode(', Pressure: ' + reading.pressure + ' hPa');
                                        readingDiv.appendChild(pressureText);
                                    }

                                    readingsContainer.appendChild(readingDiv);
                                });
                            } else {
                                readingsContainer.textContent = 'No readings yet';
                            }
                            document.getElementById('readingCount').textContent = data.totalCount;

                        } catch (error) {
                            iotLogger.error('Failed to update readings', { error: { message: error.message } });
                        }
                    }

                    // Auto-refresh readings every 30 seconds
                    setInterval(updateReadings, 30000);
                    updateReadings();
                </script>
            </body>
            </html>
            `);
        });
    }

    async connectToWrfcoinNetwork() {
        try {
            // Register with the discovery node
            const response = await fetch(`${this.discoveryNodeURL}/quick-join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nodeId: this.stationId,
                    type: 'weather_station'
                })
            });

            if (response.ok) {
                this.isConnected = true;
                iotLogger.info('Connected to Wrfcoin network', {
                    stationId: this.stationId,
                    discoveryNode: this.discoveryNodeURL,
                });
            }
        } catch (error) {
            iotLogger.warn('Connection to Wrfcoin network pending', {
                stationId: this.stationId,
                discoveryNode: this.discoveryNodeURL,
                error: { message: error.message },
            });
        }
    }

    sendToWrfcoinNetwork(weatherData) {
        // This would send the weather data to the Wrfcoin blockchain
        // For now, we'll log it and simulate blockchain submission
        iotLogger.info('Sending weather data to Wrfcoin network', {
            type: 'weather_data',
            stationId: weatherData.stationId,
            temperature: weatherData.temperature,
            humidity: weatherData.humidity,
            pressure: weatherData.pressure,
            timestamp: weatherData.timestamp,
            payloadSchemaVersion: weatherData.canonicalPayload?.schema_version || WEATHER_SCHEMA_V1,
            canonicalPayload: weatherData.canonicalPayload,
        });

        // In a real implementation, this would:
        // 1. Create a blockchain transaction
        // 2. Submit to the IoT/Sensor layer (2,479+ TPS capacity)
        // 3. Validate and store on-chain
        // 4. Distribute to network nodes
    }

    start() {
        this.setupAPI();

        this.app.listen(this.port, '0.0.0.0', () => {
            weatherLogger.info('Weather Station Connector started', {
                stationId: this.stationId,
                port: this.port,
                webInterface: `http://localhost:${this.port}`,
                apiEndpoint: `http://localhost:${this.port}/submit-weather`,
            });
        });

        // Try to connect to Wrfcoin network
        this.connectToWrfcoinNetwork();

        this.showInstructions();
    }

    showInstructions() {
        iotLogger.info('Weather Station Connector setup instructions', {
            steps: [
                '1. Download this connector file',
                '2. Run: node weather_station_connector.js',
                `3. Open: http://localhost:${this.port}`,
                '4. Submit weather data through the web form',
            ],
            automatedStations: {
                description: 'Connect your weather station to send HTTP POST requests',
                endpoint: `http://localhost:${this.port}/submit-weather`,
            },
            networkCapacity: '2,479 TPS on the IoT/Sensor layer',
        });
    }
}

// Start the weather station connector
const connector = new WeatherStationConnector();
connector.start();
