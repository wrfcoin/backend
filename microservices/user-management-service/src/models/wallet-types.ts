export interface WalletBalance {
  address: string;
  balance: string;
  tokens: TokenBalance[];
  stakingRewards: string;
  weatherRewards: string;
}

export interface TokenBalance {
  token: string;
  balance: string;
  value?: string;
}

export interface Transaction {
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

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
  meta?: Record<string, string | number | boolean>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}
