/**
 * RTL-433 Data Ingestion Microservice
 *
 * Sidecar service that bridges the IoT edge gateway and the weather API.
 * Receives normalized RTL-433 readings from the gateway MQTT broker
 * and submits them to the backend weather service.
 *
 * Port: 3052 (RTL-433 microservice)
 * Dependencies:
 * - IoT gateway MQTT broker (typically port 1883)
 * - Backend weather API (typically http://localhost:4001)
 */

import express, { Express, Request, Response } from 'express';
import { MqttClient, connect as connectMqtt } from 'mqtt';
import { logger } from '../utils/logger.js';
import { RTL433SubmissionService } from '../services/weather/rtl433-submission-service.js';

interface NormalizedWeatherReading {
  stationId: string;
  timestamp: number;
  temperature_c?: number;
  humidity_percent?: number;
  pressure_hpa?: number;
  wind_speed_ms?: number;
  wind_direction_deg?: number;
  precipitation_mm?: number;
  dewpoint_c?: number;
  source: 'rf-sdr';
  protocol: string;
  messageId?: number;
}

interface ServiceMetrics {
  readingsReceived: number;
  readingsSubmitted: number;
  submissionFailures: number;
  startTime: Date;
  lastReadingTime?: Date;
}

class RTL433IngestionService {
  private app: Express;
  private port: number;
  private mqttClient: MqttClient | null = null;
  private submissionService: RTL433SubmissionService;
  private metrics: ServiceMetrics = {
    readingsReceived: 0,
    readingsSubmitted: 0,
    submissionFailures: 0,
    startTime: new Date(),
  };

  constructor(
    port: number = 3052,
    private mqttBrokerUrl: string = 'mqtt://localhost:1883',
    private weatherApiUrl: string = 'http://localhost:4001'
  ) {
    this.port = port;
    this.app = express();
    this.submissionService = new RTL433SubmissionService(weatherApiUrl);

    this.setupExpress();
  }

  /**
   * Setup Express HTTP server for health checks and metrics.
   */
  private setupExpress(): void {
    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      const isHealthy = this.mqttClient?.connected ?? false;
      res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        service: 'rtl433-ingestion',
        version: '1.0.0',
        uptime: Math.floor((Date.now() - this.metrics.startTime.getTime()) / 1000),
        mqtt: {
          connected: isHealthy,
          broker: this.mqttBrokerUrl,
        },
      });
    });

    // Metrics endpoint
    this.app.get('/metrics', (req: Request, res: Response) => {
      res.json({
        service: 'rtl433-ingestion',
        metrics: {
          ...this.metrics,
          uptime: Math.floor((Date.now() - this.metrics.startTime.getTime()) / 1000),
          successRate:
            this.metrics.readingsReceived > 0
              ? ((this.metrics.readingsSubmitted / this.metrics.readingsReceived) * 100).toFixed(2)
              : 0,
        },
      });
    });

    // Configuration endpoint
    this.app.get('/config', (req: Request, res: Response) => {
      res.json({
        submissionMode: process.env.RTL433_INGESTION_MODE === 'http' ? 'http' : 'internal',
        mqtt: {
          brokerUrl: this.mqttBrokerUrl,
          topic: 'wrfcoin/weather/rtl433-ready',
        },
        weatherApi: {
          baseUrl: this.weatherApiUrl,
          endpoint: '/api/weather/data',
        },
      });
    });

    // Ready check endpoint (K8s readiness probe)
    this.app.get('/ready', (req: Request, res: Response) => {
      const ready = this.mqttClient?.connected ?? false;
      res.status(ready ? 200 : 503).json({ ready });
    });
  }

  /**
   * Connect to MQTT broker and subscribe to RTL-433 readings.
   */
  private async connectMQTT(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.mqttClient = connectMqtt(this.mqttBrokerUrl, {
        clientId: `rtl433-ingestion-${Date.now()}`,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
      });

      this.mqttClient.on('connect', () => {
        logger.info('[RTL433 Service] connected to MQTT broker', {
          broker: this.mqttBrokerUrl,
        });

        // Subscribe to normalized RTL-433 readings
        this.mqttClient!.subscribe('wrfcoin/weather/rtl433-ready', (err) => {
          if (err) {
            logger.error('[RTL433 Service] subscription error', { err });
            reject(err);
          } else {
            logger.info('[RTL433 Service] subscribed to rtl433-ready topic');
            resolve();
          }
        });
      });

      this.mqttClient.on('message', (topic: string, payload: Buffer) => {
        this.handleMessage(topic, payload).catch((err) => {
          logger.error('[RTL433 Service] message handling error', { err, topic });
        });
      });

      this.mqttClient.on('error', (err) => {
        logger.error('[RTL433 Service] MQTT error', { err });
        reject(err);
      });

      this.mqttClient.on('disconnect', () => {
        logger.warn('[RTL433 Service] MQTT disconnected');
      });

      // Timeout if connection takes too long
      setTimeout(() => {
        if (!this.mqttClient?.connected) {
          reject(new Error('MQTT connection timeout'));
        }
      }, 15_000);
    });
  }

  /**
   * Handle incoming RTL-433 reading message.
   */
  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    let reading: NormalizedWeatherReading;
    try {
      reading = JSON.parse(payload.toString()) as NormalizedWeatherReading;
    } catch (err) {
      logger.warn('[RTL433 Service] malformed message', { err, topic });
      return;
    }

    this.metrics.readingsReceived++;
    this.metrics.lastReadingTime = new Date();

    // Submit to weather API
    const success = await this.submissionService.submitReading(reading);
    if (success) {
      this.metrics.readingsSubmitted++;
    } else {
      this.metrics.submissionFailures++;
    }
  }

  /**
   * Start the service.
   */
  async start(): Promise<void> {
    try {
      // Connect to MQTT broker
      logger.info('[RTL433 Service] connecting to MQTT broker...');
      await this.connectMQTT();

      // Check weather API health
      logger.info('[RTL433 Service] checking weather API health...');
      const apiHealthy = await this.submissionService.healthCheck();
      if (!apiHealthy) {
        logger.warn('[RTL433 Service] weather API is not responding');
      }

      // Start HTTP server
      this.app.listen(this.port, () => {
        logger.info('[RTL433 Service] HTTP server started', {
          port: this.port,
          healthCheck: `http://localhost:${this.port}/health`,
          metrics: `http://localhost:${this.port}/metrics`,
        });
      });
    } catch (err) {
      logger.error('[RTL433 Service] startup failed', { err });
      throw err;
    }
  }

  /**
   * Gracefully shut down the service.
   */
  async stop(): Promise<void> {
    logger.info('[RTL433 Service] shutting down...');
    if (this.mqttClient) {
      await new Promise<void>((resolve) => {
        this.mqttClient!.end(() => {
          logger.info('[RTL433 Service] MQTT connection closed');
          resolve();
        });
      });
    }
  }
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.RTL433_PORT || '3052', 10);
  const mqttBroker = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
  const weatherApi = process.env.WEATHER_API_URL || 'http://localhost:4001';

  const service = new RTL433IngestionService(port, mqttBroker, weatherApi);

  service.start().catch((err) => {
    logger.error('[RTL433 Service] fatal error', { err });
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('[RTL433 Service] SIGTERM received');
    await service.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('[RTL433 Service] SIGINT received');
    await service.stop();
    process.exit(0);
  });
}

export { RTL433IngestionService };
