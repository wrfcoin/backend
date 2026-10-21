/**
 * RTL-433 Weather Data Submission Service
 *
 * Receives normalized RTL-433 readings from the IoT edge gateway
 * and submits them to the weather API with rf-sdr source tagging.
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger.js';

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

type SubmissionMode = 'internal' | 'http';

interface WeatherSubmissionPayload {
  stationId: string;
  timestamp: string;
  temperature_c?: number;
  humidity_percent?: number;
  pressure_hpa?: number;
  wind_speed_ms?: number;
  wind_direction_deg?: number;
  precipitation_mm?: number;
  dewpoint_c?: number;
  source: 'rf-sdr';
  protocol: string;
}

const DEFAULT_SUBMISSION_MODE: SubmissionMode =
  process.env.RTL433_SUBMISSION_MODE === 'http' ? 'http' : 'internal';

export class RTL433SubmissionService {
  private httpClient: AxiosInstance;
  private weatherApiUrl: string;
  private authToken: string | null = null;
  private retryCount = 3;
  private retryDelayMs = 1000;
  private submissionMode: SubmissionMode;

  constructor(
    weatherApiBaseUrl: string = 'http://localhost:4001',
    submissionMode: SubmissionMode = process.env.RTL433_INGESTION_MODE === 'http'
      ? 'http'
      : 'internal'
  ) {
    this.weatherApiUrl = weatherApiBaseUrl;
    this.submissionMode = submissionMode;
    this.httpClient = axios.create({
      baseURL: weatherApiBaseUrl,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'rtl-433-ingestion',
      },
    });
  }

  /**
   * Set authentication token for API requests.
   */
  setAuthToken(token: string): void {
    this.authToken = token;
    this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  /**
   * Submit a normalized RTL-433 reading to the weather API.
   */
  async submitReading(reading: NormalizedWeatherReading): Promise<boolean> {
    const payload = this.buildPayload(reading);

    for (let attempt = 0; attempt < this.retryCount; attempt++) {
      try {
        const success =
          this.submissionMode === 'internal'
            ? await this.submitInternal(payload, reading)
            : await this.submitHttp(payload, reading);

        if (success) {
          logger.info('[RTL433 Submission] reading submitted successfully', {
            stationId: reading.stationId,
            protocol: reading.protocol,
            timestamp: reading.timestamp,
            mode: this.submissionMode,
          });
          return true;
        }

        return false;
      } catch (error) {
        const isLastAttempt = attempt === this.retryCount - 1;
        const delay = Math.pow(2, attempt) * this.retryDelayMs;

        if (isLastAttempt) {
          logger.error('[RTL433 Submission] failed after retries', {
            stationId: reading.stationId,
            error: error instanceof Error ? error.message : 'Unknown error',
            attempts: this.retryCount,
            mode: this.submissionMode,
          });
          return false;
        }

        logger.warn('[RTL433 Submission] submission failed, retrying', {
          stationId: reading.stationId,
          attempt: attempt + 1,
          nextRetryMs: delay,
          mode: this.submissionMode,
        });

        await this.sleep(delay);
      }
    }

    return false;
  }

  private async submitInternal(
    payload: WeatherSubmissionPayload,
    reading: NormalizedWeatherReading
  ): Promise<boolean> {
    const { ingestWeatherPayload } = require('../../server/services/weather-ingestion-service.js') as typeof import('../../server/services/weather-ingestion-service.js');
    const result = await ingestWeatherPayload({
      route: '/api/weather/data',
      payload,
      idempotencyKey: `${reading.stationId}:${reading.timestamp}:${reading.messageId || 0}`,
      transportMeta: {
        source: 'rtl433-ingestion',
        userId: null,
        walletAddress: null,
        location: null,
      },
    });

    if (result.status === 200 || result.status === 201) {
      return true;
    }

    logger.warn('[RTL433 Submission] internal ingestion rejected', {
      stationId: reading.stationId,
      status: result.status,
      mode: this.submissionMode,
    });
    return false;
  }

  private async submitHttp(
    payload: WeatherSubmissionPayload,
    reading: NormalizedWeatherReading
  ): Promise<boolean> {
    const response = await this.httpClient.post('/api/weather/data', payload);

    if (response.status === 200 || response.status === 201) {
      return true;
    }

    logger.warn('[RTL433 Submission] unexpected status code', {
      stationId: reading.stationId,
      status: response.status,
      mode: this.submissionMode,
    });
    return false;
  }

  /**
   * Submit multiple readings in batch (more efficient).
   */
  async submitBatch(readings: NormalizedWeatherReading[]): Promise<number> {
    let successCount = 0;

    // Submit in parallel with a concurrency limit
    const batchSize = 10;
    for (let i = 0; i < readings.length; i += batchSize) {
      const batch = readings.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((r) => this.submitReading(r))
      );
      successCount += results.filter((r) => r).length;
    }

    logger.info('[RTL433 Submission] batch complete', {
      total: readings.length,
      successful: successCount,
      failed: readings.length - successCount,
    });

    return successCount;
  }

  /**
   * Build the payload for the weather API endpoint.
   */
  private buildPayload(reading: NormalizedWeatherReading): WeatherSubmissionPayload {
    return {
      stationId: reading.stationId,
      timestamp: new Date(reading.timestamp).toISOString(),
      temperature_c: reading.temperature_c,
      humidity_percent: reading.humidity_percent,
      pressure_hpa: reading.pressure_hpa,
      wind_speed_ms: reading.wind_speed_ms,
      wind_direction_deg: reading.wind_direction_deg,
      precipitation_mm: reading.precipitation_mm,
      dewpoint_c: reading.dewpoint_c,
      source: 'rf-sdr',
      protocol: reading.protocol,
    };
  }

  /**
   * Health check — verify API endpoint is accessible.
   */
  async healthCheck(): Promise<boolean> {
    if (this.submissionMode === 'internal') {
      return true;
    }

    try {
      const response = await this.httpClient.get('/health');
      return response.status === 200;
    } catch (error) {
      logger.warn('[RTL433 Submission] health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
