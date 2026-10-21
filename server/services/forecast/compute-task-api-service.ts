import crypto from 'crypto';
import axios from 'axios';
import {
  ComputeNodeCapabilities,
  ComputeNodeSession,
  ComputeTask,
  TaskCompletionResult,
} from './compute-task-api-types.js';

export class ComputeTaskApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface ForecastCommitPayload {
  taskId: string;
  nodeId: string;
  walletAddress: string;
  outputCid: string;
  verificationReportCid?: string;
  metrics?: Record<string, unknown>;
}

interface ForecastCommitResult {
  queued: boolean;
  receiptRef?: string;
}

interface ComputeTaskApiServiceOptions {
  now?: () => number;
  heartbeatTimeoutMs?: number;
  maxActiveClaimsPerNode?: number;
  onForecastCommit?: (
    payload: ForecastCommitPayload
  ) => Promise<ForecastCommitResult>;
  seedTasks?: ComputeTask[];
  maxSessionsPerWallet?: number;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_CLAIMS_PER_NODE = 2;

export class ComputeTaskApiService {
  private readonly now: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxActiveClaimsPerNode: number;
  private readonly nodesByToken: Map<string, ComputeNodeSession>;
  private readonly tasks: Map<string, ComputeTask>;
  private readonly onForecastCommit: (
    payload: ForecastCommitPayload
  ) => Promise<ForecastCommitResult>;
  private readonly maxSessionsPerWallet: number;

  constructor(options: ComputeTaskApiServiceOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxActiveClaimsPerNode =
      options.maxActiveClaimsPerNode || DEFAULT_MAX_ACTIVE_CLAIMS_PER_NODE;
    this.nodesByToken = new Map();
    this.tasks = new Map();
    this.onForecastCommit =
      options.onForecastCommit || this.defaultForecastCommitHook;
    this.maxSessionsPerWallet = options.maxSessionsPerWallet || 2;

    const initialTasks = options.seedTasks || createDefaultSeedTasks();
    for (const task of initialTasks) {
      this.tasks.set(task.id, { ...task });
    }
  }

  registerNode(
    walletAddress: string,
    capabilities: Partial<ComputeNodeCapabilities>
  ): ComputeNodeSession {
    if (!walletAddress || typeof walletAddress !== 'string') {
      throw new ComputeTaskApiError('walletAddress is required', 400);
    }

    const normalizedWallet = walletAddress.trim();
    if (!isWalletAddressFormat(normalizedWallet)) {
      throw new ComputeTaskApiError(
        'walletAddress must be WRFCoin (wrf...) or EVM (0x...) format',
        400
      );
    }

    const activeSessionsForWallet = Array.from(this.nodesByToken.values()).filter(
      session => session.walletAddress === normalizedWallet
    ).length;
    if (activeSessionsForWallet >= this.maxSessionsPerWallet) {
      throw new ComputeTaskApiError(
        'Max active sessions reached for wallet',
        429
      );
    }

    const nodeId = `node_${crypto.randomBytes(6).toString('hex')}`;
    const token = `ctn_${crypto.randomBytes(24).toString('hex')}`;
    const session: ComputeNodeSession = {
      nodeId,
      walletAddress: normalizedWallet,
      token,
      capabilities: normalizeCapabilities(capabilities),
      registeredAt: new Date(this.now()).toISOString(),
    };

    this.nodesByToken.set(token, session);
    return { ...session };
  }

  authenticateToken(token: string): ComputeNodeSession {
    const session = this.nodesByToken.get(token);
    if (!session) {
      throw new ComputeTaskApiError('Invalid compute node token', 401);
    }
    return { ...session };
  }

  listAvailableTasks(node: ComputeNodeSession): ComputeTask[] {
    this.requeueStalledTasks();
    return Array.from(this.tasks.values())
      .filter(task => task.status === 'available')
      .filter(task => isTaskCompatible(task, node.capabilities))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(task => ({ ...task }));
  }

  claimTask(node: ComputeNodeSession, taskId: string): ComputeTask {
    this.requeueStalledTasks();
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ComputeTaskApiError('Task not found', 404);
    }
    if (task.status !== 'available') {
      throw new ComputeTaskApiError('Task is not available for claim', 409);
    }
    if (!isTaskCompatible(task, node.capabilities)) {
      throw new ComputeTaskApiError(
        'Node capabilities do not satisfy task requirements',
        403
      );
    }

    const activeClaims = Array.from(this.tasks.values()).filter(
      t =>
        t.status === 'claimed' &&
        t.claimedByNodeId &&
        this.getWalletByNodeId(t.claimedByNodeId) === node.walletAddress
    ).length;
    if (activeClaims >= this.maxActiveClaimsPerNode) {
      throw new ComputeTaskApiError(
        'Active claim limit reached for this node',
        429
      );
    }

    const nowIso = new Date(this.now()).toISOString();
    const nextHeartbeatDueAt = new Date(
      this.now() + this.heartbeatTimeoutMs
    ).toISOString();
    const leaseExpiresAt = new Date(
      this.now() + task.leaseSeconds * 1000
    ).toISOString();
    task.status = 'claimed';
    task.claimedByNodeId = node.nodeId;
    task.claimedAt = nowIso;
    task.lastHeartbeatAt = nowIso;
    task.nextHeartbeatDueAt = nextHeartbeatDueAt;
    task.leaseExpiresAt = leaseExpiresAt;
    task.progress = 0;
    task.leaseId = `lease_${crypto.randomBytes(8).toString('hex')}`;
    this.tasks.set(task.id, task);
    return { ...task };
  }

  heartbeatTask(
    node: ComputeNodeSession,
    taskId: string,
    leaseId: string,
    progress: number,
    statusMessage?: string
  ): ComputeTask {
    this.requeueStalledTasks();
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ComputeTaskApiError('Task not found', 404);
    }

    if (
      task.status !== 'claimed' ||
      task.claimedByNodeId !== node.nodeId ||
      task.leaseId !== leaseId
    ) {
      throw new ComputeTaskApiError('Invalid lease for task heartbeat', 409);
    }

    task.lastHeartbeatAt = new Date(this.now()).toISOString();
    task.nextHeartbeatDueAt = new Date(
      this.now() + this.heartbeatTimeoutMs
    ).toISOString();
    task.progress = Math.max(0, Math.min(100, progress));
    if (statusMessage) {
      task.kind = task.kind; // explicit no-op to keep payload-compatible extension point
    }

    this.tasks.set(task.id, task);
    return { ...task };
  }

  async completeTask(
    node: ComputeNodeSession,
    taskId: string,
    leaseId: string,
    outputCid: string,
    verificationReportCid?: string,
    metrics?: Record<string, unknown>
  ): Promise<TaskCompletionResult> {
    this.requeueStalledTasks();
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new ComputeTaskApiError('Task not found', 404);
    }

    if (
      task.status !== 'claimed' ||
      task.claimedByNodeId !== node.nodeId ||
      task.leaseId !== leaseId
    ) {
      throw new ComputeTaskApiError('Invalid lease for task completion', 409);
    }

    if (!outputCid || typeof outputCid !== 'string') {
      throw new ComputeTaskApiError('outputCid is required', 400);
    }

    task.status = 'completed';
    task.progress = 100;
    task.outputCid = outputCid;
    task.verificationReportCid = verificationReportCid;
    task.lastHeartbeatAt = new Date(this.now()).toISOString();
    this.tasks.set(task.id, task);

    let forecastCommit: ForecastCommitResult;
    try {
      forecastCommit = await this.onForecastCommit({
        taskId: task.id,
        nodeId: node.nodeId,
        walletAddress: node.walletAddress,
        outputCid,
        verificationReportCid,
        metrics,
      });
      task.commitStatus = forecastCommit.queued ? 'queued' : 'failed';
    } catch {
      forecastCommit = { queued: false };
      task.commitStatus = 'failed';
    }
    this.tasks.set(task.id, task);

    return {
      ok: true,
      forecastCommitQueued: forecastCommit.queued,
      receiptRef: forecastCommit.receiptRef,
    };
  }

  requeueStalledTasks(): void {
    const nowTs = this.now();
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== 'claimed') {
        continue;
      }

      const heartbeatExpired =
        task.nextHeartbeatDueAt &&
        nowTs > new Date(task.nextHeartbeatDueAt).getTime();
      const leaseExpired =
        task.leaseExpiresAt &&
        nowTs > new Date(task.leaseExpiresAt).getTime();

      if (heartbeatExpired || leaseExpired) {
        this.tasks.set(taskId, {
          ...task,
          status: 'available',
          claimedByNodeId: undefined,
          leaseId: undefined,
          claimedAt: undefined,
          lastHeartbeatAt: undefined,
          nextHeartbeatDueAt: undefined,
          leaseExpiresAt: undefined,
          progress: 0,
        });
      }
    }
  }

  getHeartbeatTimeoutMs(): number {
    return this.heartbeatTimeoutMs;
  }

  private getWalletByNodeId(nodeId: string): string | null {
    const session = Array.from(this.nodesByToken.values()).find(
      item => item.nodeId === nodeId
    );
    return session?.walletAddress || null;
  }

  private async defaultForecastCommitHook(
    payload: ForecastCommitPayload
  ): Promise<ForecastCommitResult> {
    const endpoint =
      process.env.CORE4_FORECAST_COMMIT_URL ||
      'http://localhost:8556/api/pop/forecast-commit';
    try {
      const response = await axios.post(endpoint, payload, {
        timeout: 5000,
      });
      const receiptRef =
        response.data?.receiptRef ||
        response.data?.txId ||
        `commit_${crypto.randomBytes(4).toString('hex')}`;
      return {
        queued: true,
        receiptRef,
      };
    } catch {
      // Non-blocking: task completion succeeds even if commit hook is temporarily unavailable.
      return {
        queued: false,
      };
    }
  }
}

function normalizeCapabilities(
  capabilities: Partial<ComputeNodeCapabilities>
): ComputeNodeCapabilities {
  const regions = Array.isArray(capabilities.regions)
    ? capabilities.regions.filter(region => typeof region === 'string')
    : [];

  return {
    gpu: Boolean(capabilities.gpu),
    memoryGb: Number.isFinite(capabilities.memoryGb)
      ? Number(capabilities.memoryGb)
      : 0,
    regions,
  };
}

function isTaskCompatible(
  task: ComputeTask,
  capabilities: ComputeNodeCapabilities
): boolean {
  if (task.requiredCapabilities.gpu && !capabilities.gpu) {
    return false;
  }

  if (capabilities.memoryGb < task.requiredCapabilities.minMemoryGb) {
    return false;
  }

  if (
    task.requiredCapabilities.region &&
    !capabilities.regions.includes(task.requiredCapabilities.region)
  ) {
    return false;
  }

  return true;
}

function isWalletAddressFormat(value: string): boolean {
  return /^wrf[a-fA-F0-9]{40}$/.test(value) || /^0x[a-fA-F0-9]{40}$/.test(value);
}

function createDefaultSeedTasks(): ComputeTask[] {
  const nowIso = new Date().toISOString();
  return [
    {
      id: 'task_forecast_us_central',
      kind: 'forecast.wrf',
      domain: { north: 45, south: 30, west: -105, east: -88, region: 'us-central' },
      forecastHours: 12,
      reward: 2.5,
      leaseSeconds: 600,
      requiredCapabilities: {
        gpu: false,
        minMemoryGb: 8,
        region: 'us-central',
      },
      status: 'available',
      createdAt: nowIso,
    },
    {
      id: 'task_forecast_us_west_gpu',
      kind: 'forecast.wrf.highres',
      domain: { north: 49, south: 31, west: -125, east: -110, region: 'us-west' },
      forecastHours: 24,
      reward: 5,
      leaseSeconds: 900,
      requiredCapabilities: {
        gpu: true,
        minMemoryGb: 16,
        region: 'us-west',
      },
      status: 'available',
      createdAt: nowIso,
    },
  ];
}
