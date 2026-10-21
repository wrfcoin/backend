/**
 * API types for User Management service
 */

export interface BaseResponse<T = unknown> {
  success: boolean;
  data: T;
  timestamp: string;
  meta?: Record<string, string | number | boolean>;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded';
  service: string;
  timestamp: string;
}

export interface WalletBalanceResponse {
  address: string;
  balance: string;
  tokens: Array<{
    token: string;
    balance: string;
    value?: string;
  }>;
  stakingRewards: string;
  weatherRewards: string;
}

export interface TransactionResponse {
  hash: string;
  from: string;
  to: string;
  amount: string;
  token: string;
  timestamp: Date;
  status: 'pending' | 'confirmed' | 'failed';
  fee: string;
  memo?: string;
}

export interface PaginatedTransactionsResponse {
  transactions: TransactionResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export enum WalletErrorCodes {
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}
