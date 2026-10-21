export interface ComputeNodeCapabilities {
  gpu: boolean;
  memoryGb: number;
  regions: string[];
}

export interface ComputeNodeSession {
  nodeId: string;
  walletAddress: string;
  token: string;
  capabilities: ComputeNodeCapabilities;
  registeredAt: string;
}

export interface ComputeTask {
  id: string;
  kind: string;
  domain: {
    north: number;
    south: number;
    east: number;
    west: number;
    region: string;
  };
  forecastHours: number;
  reward: number;
  leaseSeconds: number;
  requiredCapabilities: {
    gpu: boolean;
    minMemoryGb: number;
    region: string;
  };
  status: 'available' | 'claimed' | 'completed';
  createdAt: string;
  claimedByNodeId?: string;
  leaseId?: string;
  claimedAt?: string;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  nextHeartbeatDueAt?: string;
  progress?: number;
  outputCid?: string;
  verificationReportCid?: string;
  commitStatus?: 'queued' | 'failed';
}

export interface TaskCompletionResult {
  ok: boolean;
  forecastCommitQueued: boolean;
  receiptRef?: string;
}
