/**
 * Anti-Fraud Data Quality Pipeline
 *
 * Performs deterministic trust-boundary checks for ingested telemetry/oracle/weather
 * payloads and produces auditable penalty decisions with explicit reason codes.
 */

const crypto = require('crypto');

const AntiFraudReasonCodes = Object.freeze({
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  BOUNDS_VIOLATION: 'BOUNDS_VIOLATION',
  DUPLICATE_REPLAY: 'DUPLICATE_REPLAY',
  TEMPORAL_INCONSISTENCY: 'TEMPORAL_INCONSISTENCY',
  CROSS_SOURCE_INCONSISTENCY: 'CROSS_SOURCE_INCONSISTENCY',
  MALFORMED_PAYLOAD_PATTERN: 'MALFORMED_PAYLOAD_PATTERN',
  NON_FINITE_MEASUREMENT: 'NON_FINITE_MEASUREMENT',
  OVERSIZED_PAYLOAD: 'OVERSIZED_PAYLOAD',
  UNTRUSTED_SOURCE: 'UNTRUSTED_SOURCE',
  AMBIGUOUS_STATE: 'AMBIGUOUS_STATE',
});

const PENALTY_POINTS = Object.freeze({
  [AntiFraudReasonCodes.SCHEMA_INVALID]: 50,
  [AntiFraudReasonCodes.BOUNDS_VIOLATION]: 25,
  [AntiFraudReasonCodes.DUPLICATE_REPLAY]: 70,
  [AntiFraudReasonCodes.TEMPORAL_INCONSISTENCY]: 25,
  [AntiFraudReasonCodes.CROSS_SOURCE_INCONSISTENCY]: 20,
  [AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN]: 45,
  [AntiFraudReasonCodes.NON_FINITE_MEASUREMENT]: 45,
  [AntiFraudReasonCodes.OVERSIZED_PAYLOAD]: 40,
  [AntiFraudReasonCodes.UNTRUSTED_SOURCE]: 10,
  [AntiFraudReasonCodes.AMBIGUOUS_STATE]: 60,
});

const DEFAULT_OPTIONS = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  replayWindowMs: 24 * 60 * 60 * 1000,
  historyWindowMs: 6 * 60 * 60 * 1000,
  crossSourceWindowMs: 30 * 60 * 1000,
  maxAuditEvents: 1000,
  maxFingerprintEntries: 20000,
  maxSourceEntries: 5000,
  maxMeasurementCount: 64,
  maxStringLength: 128,
  locationGridPrecision: 2,
  trustedProviders: ['NOAA-NWS', 'NOAA-NCEI', 'OpenWeatherMap', 'LocalStation'],
  temporalThresholds: {
    temperature: 20,
    pressure: 10,
    humidity: 30,
  },
  crossSourceThresholds: {
    temperature: 15,
    pressure: 25,
    humidity: 35,
  },
  rangeChecks: {
    temperature: { min: -89.2, max: 56.7 },
    humidity: { min: 0, max: 100 },
    pressure: { min: 870, max: 1085 },
    windSpeed: { min: 0, max: 113 },
    windDirection: { min: 0, max: 360 },
    precipitation: { min: 0, max: 305 },
    dewpoint: { min: -89.2, max: 35 },
    visibility: { min: 0, max: 50 },
    cloudCoverage: { min: 0, max: 100 },
  },
});

const MALFORMED_STRING_PATTERNS = [
  /<\s*script/i,
  /\b(union\s+select|drop\s+table|insert\s+into|delete\s+from)\b/i,
  /(\.\.\/|\\x00|%00)/i,
  /[\x00-\x08\x0B\x0C\x0E-\x1F]/,
  /;\s*--/,
];

function createSharedState() {
  return {
    fingerprintSeenAt: new Map(),
    sourceHistory: new Map(),
    crossSourceBuckets: new Map(),
    events: [],
    metrics: {
      totalEvaluated: 0,
      accepted: 0,
      rejected: 0,
      penalized: 0,
      reasonCounts: {},
      riskLevelCounts: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      lastEvaluatedAt: null,
    },
  };
}

const sharedState = createSharedState();
let sharedPipeline = null;

class AntiFraudQualityPipeline {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      temporalThresholds: {
        ...DEFAULT_OPTIONS.temporalThresholds,
        ...(options.temporalThresholds || {}),
      },
      crossSourceThresholds: {
        ...DEFAULT_OPTIONS.crossSourceThresholds,
        ...(options.crossSourceThresholds || {}),
      },
      rangeChecks: {
        ...DEFAULT_OPTIONS.rangeChecks,
        ...(options.rangeChecks || {}),
      },
    };
    this.state = options.state || sharedState;
  }

  evaluateSubmission(submission, context = {}) {
    const nowMs = this.getSafeNow(context.nowMs);
    const reasons = new Set();

    const metadata = this.getObject(submission && submission.metadata);
    const location = this.getObject(submission && submission.location);
    const measurements = this.getObject(submission && submission.measurements);

    const payloadSize = this.estimatePayloadSize(submission);
    if (payloadSize === null) {
      reasons.add(AntiFraudReasonCodes.AMBIGUOUS_STATE);
    } else if (payloadSize > this.options.maxPayloadBytes) {
      reasons.add(AntiFraudReasonCodes.OVERSIZED_PAYLOAD);
    }

    this.checkSchemaAndBounds(submission, metadata, location, measurements, reasons);
    this.checkMalformedPatterns(metadata, reasons);
    this.checkMeasurementRanges(measurements, reasons);

    const sourceKey = this.getSourceKey(metadata);
    const parsedTimestampMs = this.parseTimestampMs(metadata.timestamp);
    if (parsedTimestampMs === null) {
      reasons.add(AntiFraudReasonCodes.AMBIGUOUS_STATE);
    }

    const fingerprint = this.computeFingerprint({
      metadata,
      location,
      measurements,
      parsedTimestampMs,
    });

    if (!fingerprint) {
      reasons.add(AntiFraudReasonCodes.AMBIGUOUS_STATE);
    } else {
      this.checkReplayAndRecord(fingerprint, nowMs, reasons);
    }

    this.checkTemporalConsistency(sourceKey, parsedTimestampMs, measurements, reasons);
    this.checkCrossSourceConsistency(
      sourceKey,
      metadata.provider,
      parsedTimestampMs,
      location,
      measurements,
      reasons
    );

    if (this.isUntrustedSource(metadata)) {
      reasons.add(AntiFraudReasonCodes.UNTRUSTED_SOURCE);
    }

    const reasonCodes = Array.from(reasons).sort();
    const penaltyPoints = this.calculatePenaltyPoints(reasonCodes);
    const riskScore = Math.min(100, penaltyPoints);
    const riskLevel = this.getRiskLevel(riskScore);
    const shouldReject = this.shouldReject(reasonCodes, riskLevel);
    const decision = shouldReject
      ? 'rejected'
      : penaltyPoints > 0
        ? 'review_required'
        : 'accepted';

    const auditEvent = this.buildAuditEvent({
      nowMs,
      metadata,
      location,
      measurements,
      parsedTimestampMs,
      reasonCodes,
      penaltyPoints,
      riskScore,
      riskLevel,
      decision,
    });

    this.recordEvent(auditEvent, reasonCodes, riskLevel, decision);

    return {
      reasonCodes,
      penaltyPoints,
      riskScore,
      riskLevel,
      decision,
      shouldReject,
      eventId: auditEvent.eventId,
      auditedAt: auditEvent.recordedAt,
    };
  }

  getPublicRiskStatus() {
    const reasonEntries = Object.entries(this.state.metrics.reasonCounts).sort(
      (a, b) => b[1] - a[1]
    );
    return {
      totalEvaluated: this.state.metrics.totalEvaluated,
      accepted: this.state.metrics.accepted,
      rejected: this.state.metrics.rejected,
      penalized: this.state.metrics.penalized,
      riskLevels: { ...this.state.metrics.riskLevelCounts },
      topReasonCodes: reasonEntries.slice(0, 10).map(([reasonCode, count]) => ({
        reasonCode,
        count,
      })),
      recentEventCount: this.state.events.length,
      lastEvaluatedAt: this.state.metrics.lastEvaluatedAt,
    };
  }

  getPublicAuditEvents(limit = 20) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return this.state.events.slice(-safeLimit).reverse();
  }

  resetStateForTests() {
    this.state.fingerprintSeenAt.clear();
    this.state.sourceHistory.clear();
    this.state.crossSourceBuckets.clear();
    this.state.events.length = 0;
    this.state.metrics.totalEvaluated = 0;
    this.state.metrics.accepted = 0;
    this.state.metrics.rejected = 0;
    this.state.metrics.penalized = 0;
    this.state.metrics.reasonCounts = {};
    this.state.metrics.riskLevelCounts = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    this.state.metrics.lastEvaluatedAt = null;
  }

  getObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  getSafeNow(nowMs) {
    const value = Number(nowMs);
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  estimatePayloadSize(payload) {
    try {
      return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch (_error) {
      return null;
    }
  }

  checkSchemaAndBounds(submission, metadata, location, measurements, reasons) {
    if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
      reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      return;
    }

    if (!submission.metadata || !submission.location || !submission.measurements) {
      reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
    }

    const requiredMetadataFields = ['sourceId', 'sourceType', 'provider', 'timestamp'];
    requiredMetadataFields.forEach(field => {
      const value = metadata[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      } else if (value.length > this.options.maxStringLength) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      }
    });

    if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
    } else if (
      location.latitude < -90 ||
      location.latitude > 90 ||
      location.longitude < -180 ||
      location.longitude > 180
    ) {
      reasons.add(AntiFraudReasonCodes.BOUNDS_VIOLATION);
    }

    const measurementKeys = Object.keys(measurements);
    if (measurementKeys.length === 0 || measurementKeys.length > this.options.maxMeasurementCount) {
      reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
    }

    for (const key of measurementKeys) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) {
        reasons.add(AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN);
      }

      const measurement = measurements[key];
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
        continue;
      }

      if (!('value' in measurement) || !('unit' in measurement)) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      }

      if (typeof measurement.unit !== 'string' || measurement.unit.trim().length === 0) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      } else if (measurement.unit.length > 24) {
        reasons.add(AntiFraudReasonCodes.SCHEMA_INVALID);
      }
    }
  }

  checkMalformedPatterns(metadata, reasons) {
    const fields = [
      metadata.sourceId || '',
      metadata.provider || '',
      metadata.sourceType || '',
    ];

    for (const value of fields) {
      if (typeof value !== 'string') {
        continue;
      }
      if (MALFORMED_STRING_PATTERNS.some(pattern => pattern.test(value))) {
        reasons.add(AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN);
        break;
      }
    }
  }

  checkMeasurementRanges(measurements, reasons) {
    const keys = Object.keys(measurements);
    for (const key of keys) {
      const value = this.extractNumericValue(measurements[key]);
      if (value === null) {
        reasons.add(AntiFraudReasonCodes.NON_FINITE_MEASUREMENT);
        continue;
      }

      const bounds = this.options.rangeChecks[key];
      if (bounds && (value < bounds.min || value > bounds.max)) {
        reasons.add(AntiFraudReasonCodes.BOUNDS_VIOLATION);
      }
    }
  }

  computeFingerprint({ metadata, location, measurements, parsedTimestampMs }) {
    if (!Number.isFinite(parsedTimestampMs)) {
      return null;
    }

    try {
      const canonicalMeasurements = Object.keys(measurements)
        .sort()
        .map(key => {
          const value = this.extractNumericValue(measurements[key]);
          return [key, value];
        });

      const payload = JSON.stringify({
        provider: metadata.provider || '',
        sourceId: metadata.sourceId || '',
        sourceType: metadata.sourceType || '',
        timestampMs: parsedTimestampMs,
        latitude: this.roundNumber(location.latitude, 4),
        longitude: this.roundNumber(location.longitude, 4),
        measurements: canonicalMeasurements,
      });

      return this.sha256(payload);
    } catch (_error) {
      return null;
    }
  }

  checkReplayAndRecord(fingerprint, nowMs, reasons) {
    const cutoff = nowMs - this.options.replayWindowMs;
    this.pruneMapByTime(this.state.fingerprintSeenAt, cutoff);

    const previousSeenAt = this.state.fingerprintSeenAt.get(fingerprint);
    if (Number.isFinite(previousSeenAt) && previousSeenAt >= cutoff) {
      reasons.add(AntiFraudReasonCodes.DUPLICATE_REPLAY);
      return;
    }

    this.state.fingerprintSeenAt.set(fingerprint, nowMs);
    this.truncateMap(this.state.fingerprintSeenAt, this.options.maxFingerprintEntries);
  }

  checkTemporalConsistency(sourceKey, parsedTimestampMs, measurements, reasons) {
    if (!sourceKey || !Number.isFinite(parsedTimestampMs)) {
      reasons.add(AntiFraudReasonCodes.AMBIGUOUS_STATE);
      return;
    }

    const previous = this.state.sourceHistory.get(sourceKey);
    const currentSnapshot = this.extractSnapshot(measurements);

    if (previous && Number.isFinite(previous.timestampMs)) {
      const elapsedMs = parsedTimestampMs - previous.timestampMs;
      if (elapsedMs <= 0) {
        reasons.add(AntiFraudReasonCodes.DUPLICATE_REPLAY);
      } else {
        const elapsedHours = elapsedMs / (60 * 60 * 1000);
        if (
          this.exceedsTemporalDelta(
            currentSnapshot.temperature,
            previous.temperature,
            this.options.temporalThresholds.temperature,
            elapsedHours
          ) ||
          this.exceedsTemporalDelta(
            currentSnapshot.pressure,
            previous.pressure,
            this.options.temporalThresholds.pressure,
            elapsedHours
          ) ||
          this.exceedsTemporalDelta(
            currentSnapshot.humidity,
            previous.humidity,
            this.options.temporalThresholds.humidity,
            elapsedHours
          )
        ) {
          reasons.add(AntiFraudReasonCodes.TEMPORAL_INCONSISTENCY);
        }
      }
    }

    this.state.sourceHistory.set(sourceKey, {
      ...currentSnapshot,
      timestampMs: parsedTimestampMs,
      updatedAtMs: Date.now(),
    });
    this.pruneSourceHistory();
  }

  checkCrossSourceConsistency(
    sourceKey,
    provider,
    parsedTimestampMs,
    location,
    measurements,
    reasons
  ) {
    if (
      !sourceKey ||
      !provider ||
      !Number.isFinite(parsedTimestampMs) ||
      !Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude)
    ) {
      return;
    }

    const bucketStartMs =
      Math.floor(parsedTimestampMs / this.options.crossSourceWindowMs) *
      this.options.crossSourceWindowMs;
    const gridKey = this.getLocationGrid(location);
    const bucketKey = `${bucketStartMs}:${gridKey}`;
    const bucket = this.state.crossSourceBuckets.get(bucketKey) || [];

    const snapshot = this.extractSnapshot(measurements);

    for (const peer of bucket) {
      if (peer.sourceKey === sourceKey) {
        continue;
      }
      if (
        this.exceedsAbsoluteDelta(
          snapshot.temperature,
          peer.temperature,
          this.options.crossSourceThresholds.temperature
        ) ||
        this.exceedsAbsoluteDelta(
          snapshot.pressure,
          peer.pressure,
          this.options.crossSourceThresholds.pressure
        ) ||
        this.exceedsAbsoluteDelta(
          snapshot.humidity,
          peer.humidity,
          this.options.crossSourceThresholds.humidity
        )
      ) {
        reasons.add(AntiFraudReasonCodes.CROSS_SOURCE_INCONSISTENCY);
        break;
      }
    }

    bucket.push({
      sourceKey,
      provider,
      timestampMs: parsedTimestampMs,
      ...snapshot,
    });
    this.state.crossSourceBuckets.set(bucketKey, bucket);
    this.pruneCrossSourceBuckets(parsedTimestampMs - this.options.crossSourceWindowMs * 2);
  }

  isUntrustedSource(metadata) {
    const provider = typeof metadata.provider === 'string' ? metadata.provider : '';
    const sourceId = typeof metadata.sourceId === 'string' ? metadata.sourceId : '';
    const providerTrusted = this.options.trustedProviders.includes(provider);
    const sourceKnown = sourceId.trim().length > 0 && sourceId.toLowerCase() !== 'unknown';
    return !providerTrusted || !sourceKnown;
  }

  calculatePenaltyPoints(reasonCodes) {
    return reasonCodes.reduce(
      (sum, reasonCode) => sum + (PENALTY_POINTS[reasonCode] || 0),
      0
    );
  }

  getRiskLevel(riskScore) {
    if (riskScore >= 75) return 'critical';
    if (riskScore >= 50) return 'high';
    if (riskScore >= 25) return 'medium';
    return 'low';
  }

  shouldReject(reasonCodes, riskLevel) {
    const failClosedReasons = new Set([
      AntiFraudReasonCodes.AMBIGUOUS_STATE,
      AntiFraudReasonCodes.DUPLICATE_REPLAY,
      AntiFraudReasonCodes.SCHEMA_INVALID,
      AntiFraudReasonCodes.MALFORMED_PAYLOAD_PATTERN,
      AntiFraudReasonCodes.NON_FINITE_MEASUREMENT,
    ]);

    return (
      riskLevel === 'high' ||
      riskLevel === 'critical' ||
      reasonCodes.some(code => failClosedReasons.has(code))
    );
  }

  buildAuditEvent({
    nowMs,
    metadata,
    location,
    measurements,
    parsedTimestampMs,
    reasonCodes,
    penaltyPoints,
    riskScore,
    riskLevel,
    decision,
  }) {
    const measurementCount = Object.keys(measurements).length;
    const sourceIdHash = this.hashSourceId(metadata.sourceId);
    const eventSeed = `${nowMs}:${sourceIdHash}:${reasonCodes.join('|')}:${riskScore}`;
    const eventId = `af-${this.sha256(eventSeed).slice(0, 12)}`;

    return {
      eventId,
      recordedAt: new Date(nowMs).toISOString(),
      source: {
        provider: this.safeString(metadata.provider, this.options.maxStringLength),
        sourceType: this.safeString(metadata.sourceType, this.options.maxStringLength),
        sourceIdHash,
      },
      submission: {
        timestamp: Number.isFinite(parsedTimestampMs)
          ? new Date(parsedTimestampMs).toISOString()
          : null,
        locationGrid: this.getLocationGrid(location),
        measurementCount,
      },
      decision: {
        status: decision,
        riskLevel,
        riskScore,
        penaltyPoints,
        reasonCodes,
      },
    };
  }

  recordEvent(event, reasonCodes, riskLevel, decision) {
    this.state.events.push(event);
    if (this.state.events.length > this.options.maxAuditEvents) {
      this.state.events.splice(0, this.state.events.length - this.options.maxAuditEvents);
    }

    this.state.metrics.totalEvaluated += 1;
    this.state.metrics.lastEvaluatedAt = event.recordedAt;
    this.state.metrics.riskLevelCounts[riskLevel] =
      (this.state.metrics.riskLevelCounts[riskLevel] || 0) + 1;

    if (decision === 'rejected') {
      this.state.metrics.rejected += 1;
    } else if (decision === 'review_required') {
      this.state.metrics.penalized += 1;
      this.state.metrics.accepted += 1;
    } else {
      this.state.metrics.accepted += 1;
    }

    for (const reasonCode of reasonCodes) {
      this.state.metrics.reasonCounts[reasonCode] =
        (this.state.metrics.reasonCounts[reasonCode] || 0) + 1;
    }
  }

  parseTimestampMs(timestampValue) {
    if (typeof timestampValue !== 'string' || timestampValue.trim().length === 0) {
      return null;
    }
    const parsed = Date.parse(timestampValue);
    return Number.isFinite(parsed) ? parsed : null;
  }

  getSourceKey(metadata) {
    const provider = this.safeString(metadata.provider, this.options.maxStringLength);
    const sourceId = this.safeString(metadata.sourceId, this.options.maxStringLength);
    if (!provider || !sourceId) {
      return null;
    }
    return `${provider}:${sourceId}`;
  }

  extractNumericValue(measurement) {
    if (!measurement || typeof measurement !== 'object') {
      return null;
    }
    const value = measurement.value;
    return Number.isFinite(value) ? value : null;
  }

  extractSnapshot(measurements) {
    return {
      temperature: this.extractNumericValue(measurements.temperature),
      pressure: this.extractNumericValue(measurements.pressure),
      humidity: this.extractNumericValue(measurements.humidity),
    };
  }

  exceedsTemporalDelta(current, previous, thresholdPerHour, elapsedHours) {
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(previous) ||
      !Number.isFinite(thresholdPerHour) ||
      !Number.isFinite(elapsedHours) ||
      elapsedHours <= 0
    ) {
      return false;
    }
    const maxAllowed = thresholdPerHour * elapsedHours;
    return Math.abs(current - previous) > maxAllowed;
  }

  exceedsAbsoluteDelta(current, previous, threshold) {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(threshold)) {
      return false;
    }
    return Math.abs(current - previous) > threshold;
  }

  getLocationGrid(location) {
    if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      return 'unknown';
    }
    const precision = this.options.locationGridPrecision;
    const lat = this.roundNumber(location.latitude, precision).toFixed(precision);
    const lon = this.roundNumber(location.longitude, precision).toFixed(precision);
    return `${lat},${lon}`;
  }

  roundNumber(value, digits) {
    if (!Number.isFinite(value)) {
      return NaN;
    }
    const multiplier = Math.pow(10, digits);
    return Math.round(value * multiplier) / multiplier;
  }

  safeString(value, maxLength) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim().slice(0, maxLength);
  }

  hashSourceId(sourceId) {
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
      return 'unknown';
    }
    return this.sha256(sourceId).slice(0, 12);
  }

  sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  pruneMapByTime(map, cutoffTimeMs) {
    for (const [key, seenAt] of map.entries()) {
      if (!Number.isFinite(seenAt) || seenAt < cutoffTimeMs) {
        map.delete(key);
      }
    }
  }

  truncateMap(map, maxEntries) {
    if (map.size <= maxEntries) {
      return;
    }
    const overflow = map.size - maxEntries;
    const keysToDelete = [];
    let index = 0;
    for (const key of map.keys()) {
      if (index >= overflow) {
        break;
      }
      keysToDelete.push(key);
      index += 1;
    }
    keysToDelete.forEach(key => map.delete(key));
  }

  pruneSourceHistory() {
    const cutoff = Date.now() - this.options.historyWindowMs;
    for (const [key, entry] of this.state.sourceHistory.entries()) {
      if (!entry || !Number.isFinite(entry.updatedAtMs) || entry.updatedAtMs < cutoff) {
        this.state.sourceHistory.delete(key);
      }
    }
    this.truncateMap(this.state.sourceHistory, this.options.maxSourceEntries);
  }

  pruneCrossSourceBuckets(cutoffTimestampMs) {
    for (const [bucketKey, entries] of this.state.crossSourceBuckets.entries()) {
      const filtered = entries.filter(
        entry => Number.isFinite(entry.timestampMs) && entry.timestampMs >= cutoffTimestampMs
      );
      if (filtered.length === 0) {
        this.state.crossSourceBuckets.delete(bucketKey);
      } else if (filtered.length !== entries.length) {
        this.state.crossSourceBuckets.set(bucketKey, filtered);
      }
    }
  }
}

function getSharedAntiFraudQualityPipeline(options = {}) {
  if (!sharedPipeline) {
    sharedPipeline = new AntiFraudQualityPipeline(options);
  }
  return sharedPipeline;
}

module.exports = {
  AntiFraudQualityPipeline,
  AntiFraudReasonCodes,
  PENALTY_POINTS,
  getSharedAntiFraudQualityPipeline,
};
