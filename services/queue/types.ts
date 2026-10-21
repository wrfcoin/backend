/**
 * Type definitions for BullMQ-backed cross-chain job queues.
 */

export interface CrossChainJobData {
  protocol: string;
  sourceChain: string;
  destinationChain: string;
  messageType: string;
  payload: string;
  recipient?: string;
  senderAddress?: string;
}

export interface CrossChainJobResult {
  confirmationHash: string;
  gasFee: string;
  completedAt: string;
}

export type JobStatus = 'pending' | 'relaying' | 'completed' | 'failed';
