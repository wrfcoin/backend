import crypto from 'crypto';
import { abuseRiskService } from './abuse-risk-service.js';
import { sybilDetectionService } from './sybil-detection-service.js';

export type ComplianceStatus = 'pass' | 'warn' | 'fail';
export type RelayStatus = 'healthy' | 'degraded' | 'unavailable';
export type SyntheticIncidentState =
  | 'detected'
  | 'quarantined'
  | 'reviewed'
  | 'sanctioned'
  | 'cleared'
  | 'publicly_disclosed';

export interface ParticipationAuditEvent {
  source: string;
  ruleId: string;
  action: 'allow' | 'throttle' | 'deny';
  reasonCode: string;
  reasonText: string;
  actorFingerprint?: string;
  metadata?: Record<string, unknown>;
  observedAt?: string;
}

export interface RelayObservation {
  routeId: string;
  provider: string;
  region: string;
  reachable: boolean;
  latencyMs?: number;
  censorshipSignal?: 'none' | 'suspected' | 'confirmed';
  observedAt?: string;
}

export interface SyntheticIncident {
  id: string;
  campaignType: 'astroturf' | 'bot-swarm' | 'synthetic-consensus' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  actorClass: 'human' | 'ai-agent' | 'robot' | 'unknown';
  state: SyntheticIncidentState;
  summary: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{ state: SyntheticIncidentState; at: string; note: string }>;
}

export interface ForecastCoverageSnapshot {
  domain: 'soil' | 'ocean' | 'hydrology' | 'atmosphere' | 'biosphere';
  reportCount: number;
  confidenceScore: number;
  observedAt?: string;
}

const GEO_BLOCK_PATTERNS = [
  /\bgeo(block|fence|restrict|deny)\b/i,
  /\bcountry[_ -]?(deny|block|ban)\b/i,
  /\bregion[_ -]?(deny|block|ban)\b/i,
  /\bjurisdiction[_ -]?(deny|block|ban)\b/i,
];

const INMEMORY_LIMIT = 2000;
const VALID_FORECAST_DOMAINS = new Set<ForecastCoverageSnapshot['domain']>([
  'soil',
  'ocean',
  'hydrology',
  'atmosphere',
  'biosphere',
]);

function normalizeIso(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export class ResilienceCoreService {
  private readonly participationEvents: ParticipationAuditEvent[] = [];
  private readonly relayObservations: RelayObservation[] = [];
  private readonly syntheticIncidents: Map<string, SyntheticIncident> = new Map();
  private readonly forecastCoverageSnapshots: ForecastCoverageSnapshot[] = [];

  addParticipationAuditEvent(event: ParticipationAuditEvent): ParticipationAuditEvent {
    const sanitized: ParticipationAuditEvent = {
      ...event,
      actorFingerprint: event.actorFingerprint
        ? stableHash(event.actorFingerprint)
        : undefined,
      observedAt: normalizeIso(event.observedAt),
    };

    this.participationEvents.push(sanitized);
    if (this.participationEvents.length > INMEMORY_LIMIT) {
      this.participationEvents.splice(0, this.participationEvents.length - INMEMORY_LIMIT);
    }

    return sanitized;
  }

  getParticipationComplianceStatus(): {
    status: ComplianceStatus;
    geoblockingViolations: number;
    totalEvents: number;
    throttleEvents: number;
    denyEvents: number;
    actorNeutrality: 'verified' | 'review-required';
    privacySafeTelemetry: true;
    notes: string[];
    checkedAt: string;
  } {
    let geoblockingViolations = 0;
    let throttleEvents = 0;
    let denyEvents = 0;

    for (const evt of this.participationEvents) {
      if (evt.action === 'throttle') throttleEvents += 1;
      if (evt.action === 'deny') denyEvents += 1;
      const reasonBlob = `${evt.reasonCode} ${evt.reasonText}`;
      if (GEO_BLOCK_PATTERNS.some(pattern => pattern.test(reasonBlob))) {
        geoblockingViolations += 1;
      }
    }

    const status: ComplianceStatus =
      geoblockingViolations > 0
        ? 'fail'
        : denyEvents > Math.max(10, this.participationEvents.length * 0.3)
          ? 'warn'
          : 'pass';

    return {
      status,
      geoblockingViolations,
      totalEvents: this.participationEvents.length,
      throttleEvents,
      denyEvents,
      actorNeutrality: geoblockingViolations === 0 ? 'verified' : 'review-required',
      privacySafeTelemetry: true,
      notes: [
        'No jurisdictional exclusion signals are permitted in permissionless lane decisions.',
        'Telemetry is actor-fingerprint hashed and aggregate-only.',
      ],
      checkedAt: nowIso(),
    };
  }

  addRelayObservation(observation: RelayObservation): RelayObservation {
    const sanitized: RelayObservation = {
      ...observation,
      observedAt: normalizeIso(observation.observedAt),
    };

    this.relayObservations.push(sanitized);
    if (this.relayObservations.length > INMEMORY_LIMIT) {
      this.relayObservations.splice(0, this.relayObservations.length - INMEMORY_LIMIT);
    }

    return sanitized;
  }

  getRelayHealth(): {
    status: RelayStatus;
    routes: Array<{
      routeId: string;
      providers: number;
      healthyProviders: number;
      unreachableProviders: number;
      censorshipSignals: number;
      availabilityPercent: number;
    }>;
    globalAvailabilityPercent: number;
    censorshipSignalCount: number;
    checkedAt: string;
  } {
    const grouped = new Map<string, RelayObservation[]>();
    for (const obs of this.relayObservations) {
      const key = obs.routeId.trim() || 'default';
      const arr = grouped.get(key) || [];
      arr.push(obs);
      grouped.set(key, arr);
    }

    const routes = Array.from(grouped.entries()).map(([routeId, entries]) => {
      const providers = entries.length;
      const healthyProviders = entries.filter(x => x.reachable).length;
      const unreachableProviders = providers - healthyProviders;
      const censorshipSignals = entries.filter(
        x => x.censorshipSignal && x.censorshipSignal !== 'none'
      ).length;
      const availabilityPercent = providers > 0 ? (healthyProviders / providers) * 100 : 0;
      return {
        routeId,
        providers,
        healthyProviders,
        unreachableProviders,
        censorshipSignals,
        availabilityPercent: Number(availabilityPercent.toFixed(2)),
      };
    });

    const totals = routes.reduce(
      (acc, r) => {
        acc.providers += r.providers;
        acc.healthy += r.healthyProviders;
        acc.censorship += r.censorshipSignals;
        return acc;
      },
      { providers: 0, healthy: 0, censorship: 0 }
    );

    const globalAvailabilityPercent =
      totals.providers > 0 ? Number(((totals.healthy / totals.providers) * 100).toFixed(2)) : 100;

    let status: RelayStatus = 'healthy';
    if (globalAvailabilityPercent < 95 || totals.censorship > 0) status = 'degraded';
    if (globalAvailabilityPercent < 70) status = 'unavailable';

    return {
      status,
      routes,
      globalAvailabilityPercent,
      censorshipSignalCount: totals.censorship,
      checkedAt: nowIso(),
    };
  }

  addForecastCoverageSnapshot(
    snapshot: ForecastCoverageSnapshot
  ): ForecastCoverageSnapshot {
    if (!VALID_FORECAST_DOMAINS.has(snapshot.domain)) {
      throw new Error(
        `Invalid domain "${snapshot.domain}". Must be one of: soil, ocean, hydrology, atmosphere, biosphere`
      );
    }

    const sanitized: ForecastCoverageSnapshot = {
      domain: snapshot.domain,
      reportCount: Math.max(0, Math.floor(snapshot.reportCount ?? 0)),
      confidenceScore: Math.max(0, Math.min(1, Number(snapshot.confidenceScore ?? 0))),
      observedAt: normalizeIso(snapshot.observedAt),
    };

    this.forecastCoverageSnapshots.push(sanitized);
    if (this.forecastCoverageSnapshots.length > INMEMORY_LIMIT) {
      this.forecastCoverageSnapshots.splice(
        0,
        this.forecastCoverageSnapshots.length - INMEMORY_LIMIT
      );
    }

    return sanitized;
  }

  getForecastCoverageKpi(): {
    status: ComplianceStatus;
    requiredDomains: Array<'soil' | 'ocean' | 'hydrology' | 'atmosphere'>;
    coveredDomains: string[];
    coveragePercent: number;
    totalReports: number;
    averageConfidenceScore: number;
    sampleSize: number;
    privacySafeTelemetry: true;
    checkedAt: string;
  } {
    const requiredDomains: Array<'soil' | 'ocean' | 'hydrology' | 'atmosphere'> = [
      'soil',
      'ocean',
      'hydrology',
      'atmosphere',
    ];

    const covered = new Set<string>();
    let totalReports = 0;
    let confidenceWeightedSum = 0;
    let confidenceWeight = 0;

    for (const snapshot of this.forecastCoverageSnapshots) {
      if (snapshot.reportCount > 0) {
        covered.add(snapshot.domain);
      }
      totalReports += snapshot.reportCount;
      confidenceWeightedSum += snapshot.confidenceScore * Math.max(1, snapshot.reportCount);
      confidenceWeight += Math.max(1, snapshot.reportCount);
    }

    const requiredCovered = requiredDomains.filter(domain => covered.has(domain)).length;
    const coveragePercent = Number(
      ((requiredCovered / requiredDomains.length) * 100).toFixed(2)
    );
    const averageConfidenceScore =
      confidenceWeight > 0 ? Number((confidenceWeightedSum / confidenceWeight).toFixed(4)) : 0;

    let status: ComplianceStatus = 'pass';
    if (coveragePercent < 75 || averageConfidenceScore < 0.55) status = 'fail';
    else if (coveragePercent < 100 || averageConfidenceScore < 0.7) status = 'warn';

    return {
      status,
      requiredDomains,
      coveredDomains: Array.from(covered).sort(),
      coveragePercent,
      totalReports,
      averageConfidenceScore,
      sampleSize: this.forecastCoverageSnapshots.length,
      privacySafeTelemetry: true,
      checkedAt: nowIso(),
    };
  }

  createSyntheticIncident(input: {
    campaignType: SyntheticIncident['campaignType'];
    severity: SyntheticIncident['severity'];
    actorClass: SyntheticIncident['actorClass'];
    summary: string;
  }): SyntheticIncident {
    const id = `syn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const at = nowIso();
    const incident: SyntheticIncident = {
      id,
      campaignType: input.campaignType,
      severity: input.severity,
      actorClass: input.actorClass,
      summary: input.summary,
      state: 'detected',
      createdAt: at,
      updatedAt: at,
      history: [{ state: 'detected', at, note: 'Detection recorded' }],
    };
    this.syntheticIncidents.set(id, incident);
    return incident;
  }

  transitionSyntheticIncident(
    id: string,
    nextState: SyntheticIncidentState,
    note: string
  ): SyntheticIncident {
    const incident = this.syntheticIncidents.get(id);
    if (!incident) {
      throw new Error(`Incident ${id} not found`);
    }

    const allowed: Record<SyntheticIncidentState, SyntheticIncidentState[]> = {
      detected: ['quarantined', 'reviewed'],
      quarantined: ['reviewed', 'cleared'],
      reviewed: ['sanctioned', 'cleared'],
      sanctioned: ['publicly_disclosed'],
      cleared: ['publicly_disclosed'],
      publicly_disclosed: [],
    };

    if (!allowed[incident.state].includes(nextState)) {
      throw new Error(
        `Invalid transition from ${incident.state} to ${nextState}`
      );
    }

    const at = nowIso();
    incident.state = nextState;
    incident.updatedAt = at;
    incident.history.push({ state: nextState, at, note: note.trim() || 'state transition' });
    return incident;
  }

  listSyntheticIncidents(): SyntheticIncident[] {
    return Array.from(this.syntheticIncidents.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  getTransparencyLedger(): {
    generatedAt: string;
    privacySafe: true;
    sanctions: { total: number; disclosed: number };
    appeals: { total: number; cleared: number };
    parity: { human: number; aiAgent: number; robot: number; unknown: number };
    dataFreshnessSeconds: number;
  } {
    const incidents = this.listSyntheticIncidents();
    const sanctions = incidents.filter(i => i.state === 'sanctioned' || i.state === 'publicly_disclosed');
    const disclosed = incidents.filter(i => i.state === 'publicly_disclosed');
    const cleared = incidents.filter(i => i.state === 'cleared');

    const parity = incidents.reduce(
      (acc, i) => {
        if (i.actorClass === 'human') acc.human += 1;
        else if (i.actorClass === 'ai-agent') acc.aiAgent += 1;
        else if (i.actorClass === 'robot') acc.robot += 1;
        else acc.unknown += 1;
        return acc;
      },
      { human: 0, aiAgent: 0, robot: 0, unknown: 0 }
    );

    return {
      generatedAt: nowIso(),
      privacySafe: true,
      sanctions: { total: sanctions.length, disclosed: disclosed.length },
      appeals: { total: incidents.length, cleared: cleared.length },
      parity,
      dataFreshnessSeconds: 30,
    };
  }

  getActorIntegrityKpi(): {
    status: ComplianceStatus;
    abuseRiskAssessments: number;
    highOrCriticalAbuseRisk: number;
    abusePrecision: number | null;
    abuseRecallProxy: number | null;
    sybilReports: {
      total: number;
      suspicious: number;
      probableSybil: number;
      confirmedCluster: number;
    };
    privacySafeTelemetry: true;
    checkedAt: string;
  } {
    const abuseAssessments = abuseRiskService.listAssessments();
    const abuseMetrics = abuseRiskService.getMetrics();
    const sybilReports = sybilDetectionService.listReports();

    const suspicious = sybilReports.filter(r => r.riskLevel === 'suspicious').length;
    const probableSybil = sybilReports.filter(r => r.riskLevel === 'probable_sybil').length;
    const confirmedCluster = sybilReports.filter(r => r.riskLevel === 'confirmed_cluster').length;
    const highOrCriticalAbuseRisk = abuseAssessments.filter(
      a => a.riskBand === 'high' || a.riskBand === 'critical'
    ).length;

    let status: ComplianceStatus = 'pass';
    if (confirmedCluster > 0 || abuseMetrics.falsePositiveRate > 0.25) status = 'warn';
    if (confirmedCluster > 3 || abuseMetrics.falsePositiveRate > 0.4) status = 'fail';

    return {
      status,
      abuseRiskAssessments: abuseAssessments.length,
      highOrCriticalAbuseRisk,
      abusePrecision: abuseMetrics.precision,
      abuseRecallProxy: abuseMetrics.recallProxy,
      sybilReports: {
        total: sybilReports.length,
        suspicious,
        probableSybil,
        confirmedCluster,
      },
      privacySafeTelemetry: true,
      checkedAt: nowIso(),
    };
  }

  getSanctionsParityKpi(): {
    status: ComplianceStatus;
    sanctionsTotal: number;
    disclosedTotal: number;
    paritySpread: number;
    actorDistribution: { human: number; aiAgent: number; robot: number };
    actorNeutrality: 'verified' | 'review-required';
    privacySafeTelemetry: true;
    checkedAt: string;
  } {
    const ledger = this.getTransparencyLedger();
    const parityCounts = [ledger.parity.human, ledger.parity.aiAgent, ledger.parity.robot];
    const paritySpread = Math.max(...parityCounts) - Math.min(...parityCounts);
    const actorNeutrality =
      ledger.sanctions.total === 0 || paritySpread <= Math.max(1, Math.floor(ledger.sanctions.total * 0.35))
        ? 'verified'
        : 'review-required';

    let status: ComplianceStatus = 'pass';
    if (actorNeutrality === 'review-required') status = 'warn';
    if (paritySpread > Math.max(2, Math.floor(ledger.sanctions.total * 0.5))) status = 'fail';

    return {
      status,
      sanctionsTotal: ledger.sanctions.total,
      disclosedTotal: ledger.sanctions.disclosed,
      paritySpread,
      actorDistribution: {
        human: ledger.parity.human,
        aiAgent: ledger.parity.aiAgent,
        robot: ledger.parity.robot,
      },
      actorNeutrality,
      privacySafeTelemetry: true,
      checkedAt: nowIso(),
    };
  }

  getParticipationAccessibilityKpi(): {
    status: ComplianceStatus;
    participationStatus: ComplianceStatus;
    relayStatus: RelayStatus;
    geoblockingViolations: number;
    denialRate: number;
    relayAvailabilityPercent: number;
    privacySafeTelemetry: true;
    checkedAt: string;
  } {
    const participation = this.getParticipationComplianceStatus();
    const relay = this.getRelayHealth();
    const denialRate =
      participation.totalEvents > 0
        ? Number((participation.denyEvents / participation.totalEvents).toFixed(4))
        : 0;

    let status: ComplianceStatus = 'pass';
    if (
      participation.geoblockingViolations > 0 ||
      relay.status === 'unavailable' ||
      denialRate > 0.4
    ) {
      status = 'fail';
    } else if (
      participation.status !== 'pass' ||
      relay.status === 'degraded' ||
      denialRate > 0.2
    ) {
      status = 'warn';
    }

    return {
      status,
      participationStatus: participation.status,
      relayStatus: relay.status,
      geoblockingViolations: participation.geoblockingViolations,
      denialRate,
      relayAvailabilityPercent: relay.globalAvailabilityPercent,
      privacySafeTelemetry: true,
      checkedAt: nowIso(),
    };
  }

  getAlignmentKpiSummary(): {
    generatedAt: string;
    privacySafeTelemetry: true;
    kpis: {
      forecastCoverage: ReturnType<ResilienceCoreService['getForecastCoverageKpi']>;
      actorIntegrity: ReturnType<ResilienceCoreService['getActorIntegrityKpi']>;
      sanctionsParity: ReturnType<ResilienceCoreService['getSanctionsParityKpi']>;
      participationAccessibility: ReturnType<ResilienceCoreService['getParticipationAccessibilityKpi']>;
    };
    rubricMapping: string[];
  } {
    return {
      generatedAt: nowIso(),
      privacySafeTelemetry: true,
      kpis: {
        forecastCoverage: this.getForecastCoverageKpi(),
        actorIntegrity: this.getActorIntegrityKpi(),
        sanctionsParity: this.getSanctionsParityKpi(),
        participationAccessibility: this.getParticipationAccessibilityKpi(),
      },
      rubricMapping: [
        'forecastCoverage -> environmental forecast breadth',
        'actorIntegrity -> human-legible integrity + bot governance',
        'sanctionsParity -> actor-class-neutral enforcement parity',
        'participationAccessibility -> permissionless/borderless participation',
      ],
    };
  }

  getPermissionlessHealth(): {
    generatedAt: string;
    participation: ReturnType<ResilienceCoreService['getParticipationComplianceStatus']>;
    relay: ReturnType<ResilienceCoreService['getRelayHealth']>;
    guidance: string[];
  } {
    return {
      generatedAt: nowIso(),
      participation: this.getParticipationComplianceStatus(),
      relay: this.getRelayHealth(),
      guidance: [
        'If relay status is degraded, retry submission through alternate provider path.',
        'If compliance status warns/fails, review policy reason codes and incident disclosures.',
      ],
    };
  }
}

export const resilienceCoreService = new ResilienceCoreService();
