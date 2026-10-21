/**
 * External Data Validation Job
 *
 * Hourly scheduled job that cross-validates user-submitted air quality data
 * against OpenAQ and PurpleAir reference readings. Deviation scores are fed
 * into the reputation scoring engine to reward accurate reporters and flag
 * anomalous submissions.
 *
 * Follows the MeshtasticRewardAggregationJob pattern (class-based, start/stop,
 * hourly alignment, per-record error isolation).
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { weatherLogger } from '../utils/logger.js';
import { routeDurableStore } from '../../shared/route-durable-store.js';
import type { OpenAQService, OpenAQPM25Result } from '../services/external-data/openaq.js';
import type { PurpleAirService, PurpleAirPM25Result } from '../services/external-data/purpleair.js';
import type { ReputationSignal } from '../services/reputation/reputation-scoring-engine.js';

// ============================================================================
// Configuration
// ============================================================================

const VALIDATION_CONFIG = {
  scheduleIntervalMs: 60 * 60 * 1000, // 1 hour
  maxResultsPerStation: 200,
  deviationThresholdPct: parseFloat(process.env.VALIDATION_DEVIATION_THRESHOLD_PCT || '50'),
  /** OpenAQ is regulatory-grade, PurpleAir is consumer — weight accordingly */
  openaqWeight: 0.7,
  purpleairWeight: 0.3,
  /** Reference measurement staleness thresholds */
  maxReferenceAgeMs: 2 * 60 * 60 * 1000, // 2 hours
  maxReferenceDistanceMeters: 50_000, // 50km
};

// ============================================================================
// Types
// ============================================================================

export type ValidationStatus =
  | 'excellent'     // <10% deviation — boost dataQuality
  | 'acceptable'    // 10-25% deviation — no change
  | 'warning'       // 25-50% deviation — flag for review
  | 'anomaly'       // >50% deviation — penalize dataQuality
  | 'no_reference'  // no external data available
  | 'skipped';      // services disabled or record lacks airQuality

export interface ExternalValidationResult {
  id: string;
  weatherRecordId: string;
  stationId: string;
  timestamp: string;
  submittedAirQuality: number;
  openaq: OpenAQPM25Result | null;
  purpleair: PurpleAirPM25Result | null;
  referenceValue: number | null;
  referenceSource: 'openaq' | 'purpleair' | 'average' | null;
  deviationPercent: number | null;
  status: ValidationStatus;
  confidence: number;
  validatedAt: string;
}

export interface ValidationJobResult {
  windowStart: Date;
  windowEnd: Date;
  recordsScanned: number;
  recordsValidated: number;
  recordsSkipped: number;
  recordsFailed: number;
  deviationsDetected: number;
  results: ExternalValidationResult[];
  startTime: Date;
  endTime: Date;
  durationMs: number;
}

// ============================================================================
// Deviation computation (exported for testing)
// ============================================================================

export function computeDeviation(
  submitted: number,
  reference: number,
): { deviationPercent: number; confidence: number } {
  if (reference === 0) {
    return {
      deviationPercent: submitted === 0 ? 0 : 100,
      confidence: 0.5,
    };
  }
  const deviationPercent = (Math.abs(submitted - reference) / reference) * 100;
  return { deviationPercent, confidence: 1.0 };
}

export function computeReferenceValue(
  openaqPm25: number | null,
  purpleairPm25: number | null,
): { value: number | null; source: 'openaq' | 'purpleair' | 'average' | null } {
  if (openaqPm25 != null && purpleairPm25 != null) {
    return {
      value:
        openaqPm25 * VALIDATION_CONFIG.openaqWeight +
        purpleairPm25 * VALIDATION_CONFIG.purpleairWeight,
      source: 'average',
    };
  }
  if (openaqPm25 != null) return { value: openaqPm25, source: 'openaq' };
  if (purpleairPm25 != null) return { value: purpleairPm25, source: 'purpleair' };
  return { value: null, source: null };
}

export function classifyDeviation(deviationPercent: number): ValidationStatus {
  if (deviationPercent < 10) return 'excellent';
  if (deviationPercent < 25) return 'acceptable';
  if (deviationPercent < 50) return 'warning';
  return 'anomaly';
}

export function deviationToDataQualityScore(status: ValidationStatus): number {
  switch (status) {
    case 'excellent': return 95;
    case 'acceptable': return 70;
    case 'warning': return 40;
    case 'anomaly': return 10;
    default: return 50;
  }
}

function adjustConfidence(
  base: number,
  distanceMeters: number | null,
  measurementAgeMs: number | null,
): number {
  let conf = base;
  if (distanceMeters != null) {
    conf *= Math.max(0.5, 1 - distanceMeters / VALIDATION_CONFIG.maxReferenceDistanceMeters);
  }
  if (measurementAgeMs != null) {
    conf *= Math.max(0.5, 1 - measurementAgeMs / VALIDATION_CONFIG.maxReferenceAgeMs);
  }
  return Math.round(conf * 100) / 100;
}

// ============================================================================
// Job
// ============================================================================

export class ExternalDataValidationJob {
  private openaq: OpenAQService;
  private purpleair: PurpleAirService;
  private recordSignal: ((signal: ReputationSignal) => Promise<unknown>) | null;

  private hourlyInterval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;

  /** In-memory audit trail keyed by stationId */
  private results = new Map<string, ExternalValidationResult[]>();

  constructor(
    openaq: OpenAQService,
    purpleair: PurpleAirService,
    recordSignal?: (signal: ReputationSignal) => Promise<unknown>,
  ) {
    this.openaq = openaq;
    this.purpleair = purpleair;
    this.recordSignal = recordSignal ?? null;
  }

  // --------------------------------------------------------------------------
  // Scheduler (same pattern as meshtastic-reward-aggregation.ts)
  // --------------------------------------------------------------------------

  startScheduler(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const delayMs = nextHour.getTime() - now.getTime();

    weatherLogger.info('External data validation scheduler starting', {
      nextRunAt: nextHour.toISOString(),
      delayMs,
    });

    this.initialTimeout = setTimeout(() => {
      this.runHourlyValidation();
      this.hourlyInterval = setInterval(
        () => this.runHourlyValidation(),
        VALIDATION_CONFIG.scheduleIntervalMs,
      );
    }, delayMs);
  }

  stopScheduler(): void {
    if (this.initialTimeout) clearTimeout(this.initialTimeout);
    if (this.hourlyInterval) clearInterval(this.hourlyInterval);
    this.initialTimeout = null;
    this.hourlyInterval = null;
    this.isRunning = false;
    weatherLogger.info('External data validation scheduler stopped');
  }

  private async runHourlyValidation(): Promise<void> {
    const windowEnd = new Date();
    windowEnd.setMinutes(0, 0, 0);
    const windowStart = new Date(windowEnd.getTime() - VALIDATION_CONFIG.scheduleIntervalMs);

    try {
      const result = await this.runValidation(windowStart, windowEnd);
      weatherLogger.info('External data validation completed', {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        recordsScanned: result.recordsScanned,
        recordsValidated: result.recordsValidated,
        deviationsDetected: result.deviationsDetected,
        durationMs: result.durationMs,
      });
    } catch (error) {
      weatherLogger.error('External data validation job failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Core validation
  // --------------------------------------------------------------------------

  async runValidation(windowStart: Date, windowEnd: Date): Promise<ValidationJobResult> {
    const startTime = new Date();
    const jobResult: ValidationJobResult = {
      windowStart,
      windowEnd,
      recordsScanned: 0,
      recordsValidated: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      deviationsDetected: 0,
      results: [],
      startTime,
      endTime: startTime,
      durationMs: 0,
    };

    // Both services disabled → skip everything
    if (!this.openaq.enabled && !this.purpleair.enabled) {
      jobResult.endTime = new Date();
      jobResult.durationMs = jobResult.endTime.getTime() - startTime.getTime();
      return jobResult;
    }

    // Fetch weather records from the time window
    let records: any[];
    try {
      records = await routeDurableStore.read(state =>
        Object.entries(state.weather.records)
          .filter(([, rec]: [string, any]) => {
            const ts = rec.timestamp;
            return ts >= windowStart.toISOString() && ts <= windowEnd.toISOString();
          })
          .map(([id, rec]: [string, any]) => ({ id, ...rec })),
      );
    } catch {
      records = [];
    }

    jobResult.recordsScanned = records.length;

    for (const record of records) {
      try {
        // Skip records without airQuality
        if (record.airQuality == null || typeof record.airQuality !== 'number') {
          jobResult.recordsSkipped++;
          continue;
        }

        // Need lat/lon to query external APIs. Try record fields, station metadata.
        const lat = record.latitude ?? record.lat;
        const lon = record.longitude ?? record.lon ?? record.lng;
        if (lat == null || lon == null) {
          jobResult.recordsSkipped++;
          continue;
        }

        // Fetch external data
        const [openaqResult, purpleairResult] = await Promise.allSettled([
          this.openaq.enabled ? this.openaq.getPM25ForArea(lat, lon) : Promise.resolve(null),
          this.purpleair.enabled ? this.purpleair.getPM25ForArea(lat, lon) : Promise.resolve(null),
        ]);

        const openaqData = openaqResult.status === 'fulfilled' ? openaqResult.value : null;
        const purpleairData = purpleairResult.status === 'fulfilled' ? purpleairResult.value : null;

        // Compute reference value
        const ref = computeReferenceValue(
          openaqData?.pm25 ?? null,
          purpleairData?.pm25 ?? null,
        );

        let status: ValidationStatus;
        let deviationPercent: number | null = null;
        let confidence = 0;

        if (ref.value == null) {
          status = 'no_reference';
        } else {
          const deviation = computeDeviation(record.airQuality, ref.value);
          deviationPercent = Math.round(deviation.deviationPercent * 100) / 100;
          status = classifyDeviation(deviationPercent);

          // Adjust confidence based on distance and freshness
          const refDistance = openaqData?.distanceMeters ?? purpleairData?.avgDistanceMeters ?? null;
          const refTime = openaqData?.measuredAt ?? purpleairData?.measuredAt ?? null;
          const refAgeMs = refTime ? Date.now() - new Date(refTime).getTime() : null;
          confidence = adjustConfidence(deviation.confidence, refDistance, refAgeMs);
        }

        const validationResult: ExternalValidationResult = {
          id: `evr-${record.id || record.stationId}-${Date.now()}`,
          weatherRecordId: record.id || '',
          stationId: record.stationId,
          timestamp: record.timestamp,
          submittedAirQuality: record.airQuality,
          openaq: openaqData,
          purpleair: purpleairData,
          referenceValue: ref.value,
          referenceSource: ref.source,
          deviationPercent,
          status,
          confidence,
          validatedAt: new Date().toISOString(),
        };

        // Store result
        this.storeResult(validationResult);
        jobResult.results.push(validationResult);
        jobResult.recordsValidated++;

        if (status === 'warning' || status === 'anomaly') {
          jobResult.deviationsDetected++;
        }

        // Emit reputation signal
        if (this.recordSignal && status !== 'no_reference' && status !== 'skipped') {
          try {
            await this.recordSignal({
              address: record.stationId,
              role: 'collector',
              eventType: 'ExternalDataValidation',
              dataQuality: deviationToDataQualityScore(status),
              verificationAccuracy: Math.round(confidence * 100),
              details: {
                weatherRecordId: validationResult.weatherRecordId,
                deviationPercent,
                referenceSource: ref.source,
                referenceValue: ref.value,
                validationStatus: status,
              },
            });
          } catch (repError) {
            weatherLogger.warn('Failed to emit reputation signal', {
              stationId: record.stationId,
              error: repError instanceof Error ? repError.message : String(repError),
            });
          }
        }
      } catch (error) {
        // Per-record failure — continue processing other records
        jobResult.recordsFailed++;
        weatherLogger.warn('External validation failed for record', {
          recordId: record.id,
          stationId: record.stationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    jobResult.endTime = new Date();
    jobResult.durationMs = jobResult.endTime.getTime() - startTime.getTime();
    return jobResult;
  }

  // --------------------------------------------------------------------------
  // Manual trigger
  // --------------------------------------------------------------------------

  async triggerManualValidation(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ValidationJobResult> {
    return this.runValidation(windowStart, windowEnd);
  }

  // --------------------------------------------------------------------------
  // Result storage & query
  // --------------------------------------------------------------------------

  private storeResult(result: ExternalValidationResult): void {
    const existing = this.results.get(result.stationId) || [];
    existing.push(result);
    // Cap at maxResultsPerStation to bound memory
    if (existing.length > VALIDATION_CONFIG.maxResultsPerStation) {
      existing.splice(0, existing.length - VALIDATION_CONFIG.maxResultsPerStation);
    }
    this.results.set(result.stationId, existing);
  }

  getValidationResults(
    stationId?: string,
    statusFilter?: ValidationStatus,
    limit = 50,
  ): ExternalValidationResult[] {
    let all: ExternalValidationResult[];

    if (stationId) {
      all = this.results.get(stationId) || [];
    } else {
      all = [];
      for (const entries of this.results.values()) {
        all.push(...entries);
      }
    }

    if (statusFilter) {
      all = all.filter(r => r.status === statusFilter);
    }

    // Most recent first
    return all
      .sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))
      .slice(0, limit);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let singleton: ExternalDataValidationJob | null = null;

export function getExternalDataValidationJob(): ExternalDataValidationJob | null {
  return singleton;
}

export function setExternalDataValidationJob(job: ExternalDataValidationJob): void {
  singleton = job;
}
