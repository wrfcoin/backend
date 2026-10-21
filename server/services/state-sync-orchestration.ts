import type { IncomingHttpHeaders } from 'http';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../auth/jwt-constants.js';
import { hasAdminRole } from '../utils/admin-role.js';

export type SyncRole = 'admin' | 'operator' | 'observer' | 'anonymous';
export type SyncPermission = 'sync:read' | 'sync:operate';

export type SyncReadiness = 'operational' | 'degraded' | 'unavailable';
export type ProofVerificationState = 'verified' | 'pending' | 'failed';
export type ReplayProtectionState = 'enforced' | 'at_risk' | 'rejected';

export type SyncActionType =
  | 'trigger_sync'
  | 'pause_all'
  | 'pause_job'
  | 'resume_job'
  | 'cancel_job'
  | 'clear_blacklist';

export interface SyncActor {
  id: string;
  role: SyncRole;
  permissions: Set<SyncPermission>;
  ip?: string;
}

interface WalletLoginSession extends JwtPayload {
  address?: string;
  role?: string;
  roles?: string[];
  type?: string;
}

export interface SyncFailureCause {
  code: string;
  message: string;
  remediation: string;
  since: string;
  severity: 'warning' | 'critical';
}

export interface SyncOperation {
  id: string;
  height: number;
  stateRootHex: string;
  snapshotRootHex: string;
  signerId: string;
  timestamp: number;
  verified: boolean;
  entryCount: number;
}

export interface SyncPeer {
  peerId: string;
  address: string;
  syncProgress: number;
  latencyMs: number;
  status: 'syncing' | 'idle' | 'stalled' | 'blacklisted';
  lastSeen: string;
  bytesTransferred: number;
}

export interface SyncJob {
  id: string;
  peerId: string;
  startedAt: string;
  blocksRemaining: number;
  estimatedCompletion: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  failureCode?: string;
  failureMessage?: string;
}

export interface AntiAbuseStatus {
  rateLimitedPeers: number;
  blacklistedPeers: string[];
  totalRequestsBlocked: number;
  windowStart: string;
  rateLimitPerMinute: number;
  burstLimitPer10Seconds: number;
}

export interface ProofStatusDetails {
  status: ProofVerificationState;
  requiredProofType: 'operator_attestation';
  lastVerifiedAt: string | null;
  lastFailureCode: string | null;
  lastFailureMessage: string | null;
}

export interface ReplayStatusDetails {
  status: ReplayProtectionState;
  nonceWindowSize: number;
  rejectedCount: number;
  lastRejectedNonce: string | null;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
}

export interface RemediationAction {
  id: string;
  label: string;
  description: string;
  action: SyncActionType;
  requiresPrivilege: SyncPermission | null;
  enabled: boolean;
}

export interface StateSyncStatusView {
  readiness: SyncReadiness;
  healthScore: number;
  healthSummary: string;
  failureCauses: SyncFailureCause[];
  snapshotHeight: number;
  stateRootHex: string;
  snapshotRootHex: string;
  entryCount: number;
  replayNonce: number;
  recentSyncOps: SyncOperation[];
  proof: ProofStatusDetails;
  replay: ReplayStatusDetails;
  remediationActions: RemediationAction[];
  canOperate: boolean;
  lastUpdated: string;
}

export interface P2PSyncStatusView {
  readiness: SyncReadiness;
  healthScore: number;
  healthSummary: string;
  failureCauses: SyncFailureCause[];
  proof: ProofStatusDetails;
  replay: ReplayStatusDetails;
  peers: SyncPeer[];
  syncJobs: SyncJob[];
  antiAbuse: AntiAbuseStatus;
  canOperate: boolean;
  remediationActions: RemediationAction[];
  lastUpdated: string;
}

export interface SyncActionRequest {
  action: SyncActionType;
  operationNonce?: string;
  jobId?: string;
  reason?: string;
  clearLimit?: number;
  proofToken?: string;
}

export interface SyncActionResult {
  ok: boolean;
  code?:
    | 'unauthorized'
    | 'invalid_request'
    | 'rate_limited'
    | 'replay_rejected'
    | 'invalid_proof'
    | 'guardrail_blocked'
    | 'not_found';
  message: string;
  details?: Record<string, unknown>;
  data?: {
    action: SyncActionType;
    changed: number;
    status: P2PSyncStatusView;
  };
}

interface RateLimitEntry {
  minuteWindow: number[];
  burstWindow: number[];
  blockedCount: number;
}

const OPERATION_RATE_LIMIT_PER_MINUTE = 8;
const OPERATION_BURST_LIMIT_PER_10_SECONDS = 3;
const OPERATION_NONCE_TTL_MS = 15 * 60_000;
const NONCE_WINDOW_SIZE = 256;

function trimToHexSeed(seed: string, length: number): string {
  const clean = seed.replace(/[^a-fA-F0-9]/g, '');
  const padded = clean.padEnd(length, '0');
  return padded.slice(0, length);
}

function mapRoleToPermissions(role: SyncRole): Set<SyncPermission> {
  if (role === 'admin' || role === 'operator') {
    return new Set(['sync:read', 'sync:operate']);
  }
  if (role === 'observer') {
    return new Set(['sync:read']);
  }
  return new Set(['sync:read']);
}

function sanitizeIdentity(raw: string | undefined, fallback: string): string {
  const value = (raw || '').trim();
  if (!value) return fallback;
  return value.replace(/[^a-zA-Z0-9:_\-\.]/g, '_').slice(0, 64);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getBearerToken(headers: IncomingHttpHeaders): string | undefined {
  const authHeader = firstHeaderValue(headers.authorization);
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return undefined;
}

function verifyWalletLoginSession(headers: IncomingHttpHeaders): WalletLoginSession | null {
  const token = getBearerToken(headers);
  if (!token) {
    return null;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      maxAge: '15m',
    }) as WalletLoginSession;

    if (decoded.type && decoded.type !== 'access') {
      return null;
    }

    if (!decoded.address && typeof decoded.sub !== 'string') {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function roleFromSession(session: WalletLoginSession | null): SyncRole {
  if (!session) {
    return 'anonymous';
  }

  if (hasAdminRole(session)) {
    return 'admin';
  }

  const roles = [
    ...(Array.isArray(session.roles) ? session.roles : []),
    typeof session.role === 'string' ? session.role : '',
  ].filter((role): role is string => typeof role === 'string').map(role => role.toLowerCase());
  if (roles.includes('operator') || roles.includes('wallet')) {
    return 'operator';
  }
  if (roles.includes('observer')) {
    return 'observer';
  }

  return 'observer';
}

export function resolveSyncActor(
  headers: IncomingHttpHeaders,
  remoteAddress?: string
): SyncActor {
  const fallback = sanitizeIdentity(remoteAddress, 'anonymous');
  const session = verifyWalletLoginSession(headers);
  const role = roleFromSession(session);
  const actorId = sanitizeIdentity(session?.address ?? session?.sub, fallback);

  return {
    id: actorId,
    role,
    permissions: mapRoleToPermissions(role),
    ip: remoteAddress,
  };
}

export class StateSyncOrchestrationService {
  private readonly now: () => number;
  private readonly requiredProofToken: string;

  private snapshotHeight = 148_600;
  private stateRootHex = `0x${trimToHexSeed('a3b9f5c7d1e2', 64)}`;
  private snapshotRootHex = `0x${trimToHexSeed('c8f21d7a4b99', 64)}`;
  private entryCount = 12_480;
  private replayNonce = 83_421;

  private proof: ProofStatusDetails = {
    status: 'pending',
    requiredProofType: 'operator_attestation',
    lastVerifiedAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
  };

  private replay: ReplayStatusDetails = {
    status: 'enforced',
    nonceWindowSize: NONCE_WINDOW_SIZE,
    rejectedCount: 0,
    lastRejectedNonce: null,
    lastRejectedAt: null,
    lastRejectedReason: null,
  };

  private recentSyncOps: SyncOperation[] = [];

  private peers: SyncPeer[] = [
    {
      peerId: 'peer-a1b2c3d4',
      address: '192.168.1.10:30303',
      syncProgress: 96.2,
      latencyMs: 24,
      status: 'syncing',
      lastSeen: new Date(Date.now() - 4_000).toISOString(),
      bytesTransferred: 151_000_000,
    },
    {
      peerId: 'peer-e5f6g7h8',
      address: '10.0.0.45:30303',
      syncProgress: 100,
      latencyMs: 11,
      status: 'idle',
      lastSeen: new Date(Date.now() - 2_000).toISOString(),
      bytesTransferred: 317_000_000,
    },
    {
      peerId: 'peer-i9j0k1l2',
      address: '172.16.0.88:30303',
      syncProgress: 41.5,
      latencyMs: 188,
      status: 'stalled',
      lastSeen: new Date(Date.now() - 140_000).toISOString(),
      bytesTransferred: 63_000_000,
    },
    {
      peerId: 'peer-m3n4o5p6',
      address: '192.168.2.201:30303',
      syncProgress: 0,
      latencyMs: 0,
      status: 'blacklisted',
      lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
      bytesTransferred: 1_300_000,
    },
  ];

  private syncJobs: SyncJob[] = [
    {
      id: 'job-001',
      peerId: 'peer-a1b2c3d4',
      startedAt: new Date(Date.now() - 480_000).toISOString(),
      blocksRemaining: 940,
      estimatedCompletion: new Date(Date.now() + 240_000).toISOString(),
      status: 'active',
    },
    {
      id: 'job-002',
      peerId: 'peer-i9j0k1l2',
      startedAt: new Date(Date.now() - 1_200_000).toISOString(),
      blocksRemaining: 8_300,
      estimatedCompletion: new Date(Date.now() + 1_500_000).toISOString(),
      status: 'failed',
      failureCode: 'peer_stalled',
      failureMessage: 'Peer stalled beyond sync timeout guardrail',
    },
  ];

  private antiAbuse: AntiAbuseStatus = {
    rateLimitedPeers: 0,
    blacklistedPeers: ['peer-m3n4o5p6'],
    totalRequestsBlocked: 0,
    windowStart: new Date(Date.now() - 3_600_000).toISOString(),
    rateLimitPerMinute: OPERATION_RATE_LIMIT_PER_MINUTE,
    burstLimitPer10Seconds: OPERATION_BURST_LIMIT_PER_10_SECONDS,
  };

  private readonly rateByActor: Map<string, RateLimitEntry> = new Map();
  private readonly usedOperationNonces: Map<string, number> = new Map();

  constructor(nowFn: () => number = () => Date.now()) {
    this.now = nowFn;
    this.requiredProofToken = process.env.STATE_SYNC_PROOF_TOKEN || 'wrf-operator-proof-v1';
    this.appendSyncOp(true, 'bootstrap', 148_590);
  }

  public getStateSyncStatus(actor: SyncActor): StateSyncStatusView {
    this.reconcileOrchestration();

    const failureCauses = this.collectFailureCauses();
    const readiness = this.computeReadiness(failureCauses);

    return {
      readiness,
      healthScore: this.computeHealthScore(readiness, failureCauses),
      healthSummary: this.buildHealthSummary(readiness, failureCauses),
      failureCauses,
      snapshotHeight: this.snapshotHeight,
      stateRootHex: this.stateRootHex,
      snapshotRootHex: this.snapshotRootHex,
      entryCount: this.entryCount,
      replayNonce: this.replayNonce,
      recentSyncOps: [...this.recentSyncOps],
      proof: { ...this.proof },
      replay: { ...this.replay },
      remediationActions: this.buildRemediationActions(actor),
      canOperate: actor.permissions.has('sync:operate'),
      lastUpdated: new Date(this.now()).toISOString(),
    };
  }

  public getP2PSyncStatus(actor: SyncActor): P2PSyncStatusView {
    this.reconcileOrchestration();

    const failureCauses = this.collectFailureCauses();
    const readiness = this.computeReadiness(failureCauses);

    return {
      readiness,
      healthScore: this.computeHealthScore(readiness, failureCauses),
      healthSummary: this.buildHealthSummary(readiness, failureCauses),
      failureCauses,
      proof: { ...this.proof },
      replay: { ...this.replay },
      peers: [...this.peers],
      syncJobs: [...this.syncJobs],
      antiAbuse: { ...this.antiAbuse, blacklistedPeers: [...this.antiAbuse.blacklistedPeers] },
      canOperate: actor.permissions.has('sync:operate'),
      remediationActions: this.buildRemediationActions(actor),
      lastUpdated: new Date(this.now()).toISOString(),
    };
  }

  public runAction(actor: SyncActor, request: SyncActionRequest): SyncActionResult {
    this.reconcileOrchestration();

    if (!actor.permissions.has('sync:operate')) {
      return {
        ok: false,
        code: 'unauthorized',
        message: 'Sync operation denied: sync:operate permission is required',
      };
    }

    if (!request?.action) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Sync operation denied: action is required',
      };
    }

    const nonce = `${actor.id}:${request.operationNonce || ''}`;
    if (!request.operationNonce || request.operationNonce.length < 8) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'Sync operation denied: operationNonce must be at least 8 characters',
      };
    }

    this.pruneOperationNonces();
    if (this.usedOperationNonces.has(nonce)) {
      this.recordReplayRejection(request.operationNonce, 'Duplicate operation nonce rejected');
      return {
        ok: false,
        code: 'replay_rejected',
        message: 'Replay protection rejected duplicated operation nonce',
      };
    }

    const rateCheck = this.checkAndRecordRateLimit(actor.id);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'Sync operation rate-limited by anti-abuse controls',
      };
    }

    if (
      request.action === 'trigger_sync' ||
      request.action === 'resume_job'
    ) {
      const proofToken = request.proofToken || '';
      if (proofToken !== this.requiredProofToken) {
        this.proof.status = 'failed';
        this.proof.lastFailureCode = 'invalid_operator_proof';
        this.proof.lastFailureMessage = 'Operator proof token verification failed';
        return {
          ok: false,
          code: 'invalid_proof',
          message: 'Proof verification failed for sync operation',
        };
      }

      this.proof.status = 'verified';
      this.proof.lastVerifiedAt = new Date(this.now()).toISOString();
      this.proof.lastFailureCode = null;
      this.proof.lastFailureMessage = null;
    }

    this.usedOperationNonces.set(nonce, this.now() + OPERATION_NONCE_TTL_MS);

    let changed = 0;
    switch (request.action) {
      case 'trigger_sync': {
        changed = this.triggerSyncGuarded();
        if (changed === 0) {
          return {
            ok: false,
            code: 'guardrail_blocked',
            message: 'Guardrail blocked trigger_sync: no eligible peers or concurrency limit reached',
          };
        }
        break;
      }
      case 'pause_all': {
        changed = this.pauseAllActiveJobs();
        break;
      }
      case 'pause_job': {
        if (!request.jobId) {
          return {
            ok: false,
            code: 'invalid_request',
            message: 'pause_job requires jobId',
          };
        }
        const paused = this.pauseJob(request.jobId);
        if (paused === -1) {
          return {
            ok: false,
            code: 'not_found',
            message: `Sync job ${request.jobId} was not found`,
          };
        }
        changed = paused;
        break;
      }
      case 'resume_job': {
        if (!request.jobId) {
          return {
            ok: false,
            code: 'invalid_request',
            message: 'resume_job requires jobId',
          };
        }
        const resumed = this.resumeJob(request.jobId);
        if (resumed === -1) {
          return {
            ok: false,
            code: 'not_found',
            message: `Sync job ${request.jobId} was not found`,
          };
        }
        if (resumed === 0) {
          return {
            ok: false,
            code: 'guardrail_blocked',
            message: `Guardrail blocked resume for job ${request.jobId}`,
          };
        }
        changed = resumed;
        break;
      }
      case 'cancel_job': {
        if (!request.jobId) {
          return {
            ok: false,
            code: 'invalid_request',
            message: 'cancel_job requires jobId',
          };
        }
        const cancelled = this.cancelJob(request.jobId, request.reason);
        if (cancelled === -1) {
          return {
            ok: false,
            code: 'not_found',
            message: `Sync job ${request.jobId} was not found`,
          };
        }
        changed = cancelled;
        break;
      }
      case 'clear_blacklist': {
        const reason = (request.reason || '').trim();
        if (reason.length < 12) {
          return {
            ok: false,
            code: 'guardrail_blocked',
            message: 'Guardrail blocked clear_blacklist: reason must be at least 12 characters',
          };
        }
        const clearLimit = request.clearLimit ?? 3;
        if (!Number.isInteger(clearLimit) || clearLimit <= 0 || clearLimit > 5) {
          return {
            ok: false,
            code: 'guardrail_blocked',
            message: 'Guardrail blocked clear_blacklist: clearLimit must be between 1 and 5',
          };
        }
        changed = this.clearBlacklist(clearLimit);
        break;
      }
      default:
        return {
          ok: false,
          code: 'invalid_request',
          message: `Unsupported action ${(request as { action: string }).action}`,
        };
    }

    this.reconcileOrchestration();

    return {
      ok: true,
      message: `Sync action ${request.action} applied`,
      data: {
        action: request.action,
        changed,
        status: this.getP2PSyncStatus(actor),
      },
    };
  }

  private checkAndRecordRateLimit(actorId: string): { allowed: boolean } {
    const now = this.now();
    const existing =
      this.rateByActor.get(actorId) ||
      ({ minuteWindow: [], burstWindow: [], blockedCount: 0 } as RateLimitEntry);

    existing.minuteWindow = existing.minuteWindow.filter(ts => now - ts < 60_000);
    existing.burstWindow = existing.burstWindow.filter(ts => now - ts < 10_000);

    if (
      existing.minuteWindow.length >= OPERATION_RATE_LIMIT_PER_MINUTE ||
      existing.burstWindow.length >= OPERATION_BURST_LIMIT_PER_10_SECONDS
    ) {
      existing.blockedCount += 1;
      this.antiAbuse.totalRequestsBlocked += 1;
      this.antiAbuse.rateLimitedPeers =
        this.antiAbuse.rateLimitedPeers + (existing.blockedCount === 1 ? 1 : 0);

      if (existing.blockedCount >= 3 && !this.antiAbuse.blacklistedPeers.includes(actorId)) {
        this.antiAbuse.blacklistedPeers = [...this.antiAbuse.blacklistedPeers, actorId];
      }

      this.rateByActor.set(actorId, existing);
      return { allowed: false };
    }

    existing.minuteWindow.push(now);
    existing.burstWindow.push(now);
    this.rateByActor.set(actorId, existing);
    return { allowed: true };
  }

  private recordReplayRejection(nonce: string, reason: string): void {
    this.replay.status = 'rejected';
    this.replay.rejectedCount += 1;
    this.replay.lastRejectedNonce = nonce;
    this.replay.lastRejectedAt = new Date(this.now()).toISOString();
    this.replay.lastRejectedReason = reason;
  }

  private pruneOperationNonces(): void {
    const now = this.now();
    for (const [nonce, expiry] of this.usedOperationNonces.entries()) {
      if (expiry <= now) {
        this.usedOperationNonces.delete(nonce);
      }
    }
  }

  private triggerSyncGuarded(): number {
    const activeJobs = this.syncJobs.filter(job => job.status === 'active').length;
    if (activeJobs >= 6) {
      return 0;
    }

    const candidates = this.peers.filter(
      peer => peer.status !== 'blacklisted' && peer.status !== 'syncing'
    );

    if (candidates.length === 0) {
      return 0;
    }

    let changed = 0;
    for (const peer of candidates.slice(0, 2)) {
      const existing = this.syncJobs.find(job => job.peerId === peer.peerId && job.status !== 'completed');
      if (existing) {
        existing.status = 'active';
        existing.failureCode = undefined;
        existing.failureMessage = undefined;
        existing.estimatedCompletion = new Date(this.now() + 300_000).toISOString();
        changed += 1;
      } else {
        this.syncJobs.push({
          id: `job-${Math.floor(this.now() / 1000)}-${changed}`,
          peerId: peer.peerId,
          startedAt: new Date(this.now()).toISOString(),
          blocksRemaining: 2_000 + changed * 500,
          estimatedCompletion: new Date(this.now() + 420_000).toISOString(),
          status: 'active',
        });
        changed += 1;
      }
      peer.status = 'syncing';
      peer.lastSeen = new Date(this.now()).toISOString();
    }

    this.appendSyncOp(true, 'operator-triggered', this.snapshotHeight + changed);
    return changed;
  }

  private pauseAllActiveJobs(): number {
    let changed = 0;
    for (const job of this.syncJobs) {
      if (job.status === 'active') {
        job.status = 'paused';
        changed += 1;
      }
    }
    return changed;
  }

  private pauseJob(jobId: string): number {
    const job = this.syncJobs.find(entry => entry.id === jobId);
    if (!job) return -1;

    if (job.status !== 'active') return 0;

    job.status = 'paused';
    return 1;
  }

  private resumeJob(jobId: string): number {
    const job = this.syncJobs.find(entry => entry.id === jobId);
    if (!job) return -1;

    if (job.status === 'completed') return 0;

    job.status = 'active';
    job.failureCode = undefined;
    job.failureMessage = undefined;
    job.estimatedCompletion = new Date(this.now() + 300_000).toISOString();

    const peer = this.peers.find(entry => entry.peerId === job.peerId);
    if (peer && peer.status !== 'blacklisted') {
      peer.status = 'syncing';
    }

    return 1;
  }

  private cancelJob(jobId: string, reason?: string): number {
    const job = this.syncJobs.find(entry => entry.id === jobId);
    if (!job) return -1;

    if (job.status === 'completed') return 0;

    job.status = 'failed';
    job.failureCode = 'cancelled_by_operator';
    job.failureMessage = (reason || 'Cancelled by operator').slice(0, 120);
    return 1;
  }

  private clearBlacklist(limit: number): number {
    const before = this.antiAbuse.blacklistedPeers.length;
    const removed = this.antiAbuse.blacklistedPeers.slice(0, limit);
    this.antiAbuse.blacklistedPeers = this.antiAbuse.blacklistedPeers.slice(limit);

    for (const peer of this.peers) {
      if (removed.includes(peer.peerId)) {
        peer.status = 'idle';
        peer.lastSeen = new Date(this.now()).toISOString();
      }
    }

    return before - this.antiAbuse.blacklistedPeers.length;
  }

  private reconcileOrchestration(): void {
    const now = this.now();

    for (const peer of this.peers) {
      if (this.antiAbuse.blacklistedPeers.includes(peer.peerId)) {
        peer.status = 'blacklisted';
      }
    }

    for (const job of this.syncJobs) {
      const peer = this.peers.find(entry => entry.peerId === job.peerId);
      if (!peer) {
        job.status = 'failed';
        job.failureCode = 'peer_missing';
        job.failureMessage = 'Associated peer no longer exists';
        continue;
      }

      if (peer.status === 'blacklisted' && job.status === 'active') {
        job.status = 'failed';
        job.failureCode = 'peer_blacklisted';
        job.failureMessage = 'Sync job aborted because peer is blacklisted';
        continue;
      }

      if (job.status === 'active') {
        if (peer.status === 'stalled') {
          job.status = 'failed';
          job.failureCode = 'peer_stalled';
          job.failureMessage = 'Peer stalled beyond sync timeout guardrail';
          continue;
        }

        const elapsedMs = Math.max(0, now - new Date(job.startedAt).getTime());
        if (elapsedMs > 25 * 60_000 && job.blocksRemaining > 0) {
          job.status = 'failed';
          job.failureCode = 'sync_timeout';
          job.failureMessage = 'Sync exceeded max orchestration timeout';
          continue;
        }

        const progressed = Math.min(300, job.blocksRemaining);
        if (progressed > 0) {
          job.blocksRemaining -= progressed;
          peer.syncProgress = Math.min(100, peer.syncProgress + 4.5);
          peer.bytesTransferred += progressed * 120;
          peer.lastSeen = new Date(now).toISOString();
        }

        if (job.blocksRemaining <= 0) {
          job.status = 'completed';
          job.blocksRemaining = 0;
          job.estimatedCompletion = new Date(now).toISOString();
          peer.status = 'idle';
          peer.syncProgress = 100;
          this.snapshotHeight += 1;
          this.replayNonce += 1;
          this.stateRootHex = `0x${trimToHexSeed(`${this.snapshotHeight}b7`, 64)}`;
          this.snapshotRootHex = `0x${trimToHexSeed(`${this.snapshotHeight}f2`, 64)}`;
          this.appendSyncOp(true, peer.peerId, this.snapshotHeight);
        }
      }
    }

    if (this.replay.status === 'rejected') {
      const lastRejected = this.replay.lastRejectedAt
        ? new Date(this.replay.lastRejectedAt).getTime()
        : 0;
      if (now - lastRejected > 120_000) {
        this.replay.status = 'enforced';
      }
    }

    if (this.proof.status === 'pending' && this.syncJobs.some(job => job.status === 'completed')) {
      this.proof.status = 'verified';
      this.proof.lastVerifiedAt = new Date(now).toISOString();
    }

    this.recentSyncOps = this.recentSyncOps.slice(0, 20);
  }

  private appendSyncOp(verified: boolean, signerId: string, height: number): void {
    this.recentSyncOps.unshift({
      id: `sync-${height}-${Math.floor(this.now() / 1000)}`,
      height,
      stateRootHex: this.stateRootHex,
      snapshotRootHex: this.snapshotRootHex,
      signerId,
      timestamp: this.now(),
      verified,
      entryCount: this.entryCount,
    });
  }

  private collectFailureCauses(): SyncFailureCause[] {
    const causes: SyncFailureCause[] = [];
    const nowIso = new Date(this.now()).toISOString();

    if (this.proof.status === 'failed') {
      causes.push({
        code: this.proof.lastFailureCode || 'proof_failed',
        message: this.proof.lastFailureMessage || 'Proof verification failed',
        remediation: 'Retry with valid operator proof attestation',
        since: nowIso,
        severity: 'critical',
      });
    }

    if (this.replay.status === 'rejected' && this.replay.lastRejectedReason) {
      causes.push({
        code: 'replay_rejection',
        message: this.replay.lastRejectedReason,
        remediation: 'Issue a fresh operation nonce and retry',
        since: this.replay.lastRejectedAt || nowIso,
        severity: 'critical',
      });
    }

    const failedJobs = this.syncJobs.filter(job => job.status === 'failed');
    for (const job of failedJobs.slice(0, 3)) {
      causes.push({
        code: job.failureCode || 'job_failed',
        message: `Job ${job.id} failed: ${job.failureMessage || 'Unknown failure'}`,
        remediation: 'Resume job after validating peer health and proof state',
        since: nowIso,
        severity: 'warning',
      });
    }

    const activePeers = this.peers.filter(peer => peer.status !== 'blacklisted');
    if (activePeers.length === 0) {
      causes.push({
        code: 'no_active_peers',
        message: 'No eligible peers are available for synchronization',
        remediation: 'Clear abusive peers only after manual trust review',
        since: nowIso,
        severity: 'critical',
      });
    }

    return causes;
  }

  private computeReadiness(failures: SyncFailureCause[]): SyncReadiness {
    const criticalCount = failures.filter(f => f.severity === 'critical').length;
    if (criticalCount >= 2) return 'unavailable';
    if (failures.length > 0) return 'degraded';
    return 'operational';
  }

  private computeHealthScore(
    readiness: SyncReadiness,
    failures: SyncFailureCause[]
  ): number {
    if (readiness === 'operational') return 96;
    if (readiness === 'degraded') return Math.max(55, 85 - failures.length * 8);
    return Math.max(25, 45 - failures.length * 4);
  }

  private buildHealthSummary(
    readiness: SyncReadiness,
    failures: SyncFailureCause[]
  ): string {
    if (readiness === 'operational') {
      return 'State-sync orchestration is healthy with replay and proof checks enforced.';
    }

    if (readiness === 'degraded') {
      return `State-sync is degraded: ${failures.length} failure cause${failures.length === 1 ? '' : 's'} require operator review.`;
    }

    return 'State-sync unavailable: critical guardrails are blocking orchestration until remediated.';
  }

  private buildRemediationActions(actor: SyncActor): RemediationAction[] {
    const canOperate = actor.permissions.has('sync:operate');
    const failedJobExists = this.syncJobs.some(job => job.status === 'failed');
    const activeJobExists = this.syncJobs.some(job => job.status === 'active');

    return [
      {
        id: 'trigger-sync',
        label: 'Trigger Sync Round',
        description: 'Start a guarded sync round across eligible peers.',
        action: 'trigger_sync',
        requiresPrivilege: 'sync:operate',
        enabled: canOperate,
      },
      {
        id: 'pause-all',
        label: 'Pause All Jobs',
        description: 'Pause all active sync jobs for incident containment.',
        action: 'pause_all',
        requiresPrivilege: 'sync:operate',
        enabled: canOperate && activeJobExists,
      },
      {
        id: 'resume-failed',
        label: 'Resume Failed Job',
        description: 'Resume a failed sync job after validating peer trust and proof state.',
        action: 'resume_job',
        requiresPrivilege: 'sync:operate',
        enabled: canOperate && failedJobExists,
      },
      {
        id: 'clear-blacklist',
        label: 'Clear Small Blacklist Batch',
        description: 'Safely clear up to five peers after manual trust verification.',
        action: 'clear_blacklist',
        requiresPrivilege: 'sync:operate',
        enabled: canOperate && this.antiAbuse.blacklistedPeers.length > 0,
      },
    ];
  }
}

export function createStateSyncOrchestrationService(): StateSyncOrchestrationService {
  return new StateSyncOrchestrationService();
}
