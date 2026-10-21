import { Request, Response } from 'express';
import {
  WalletBalance,
  Transaction,
  PaginatedResponse,
  ApiResponse,
  ApiError,
} from '../models/wallet-types.js';

const WALLET_ADDRESS_PATTERN = /^(0x[a-fA-F0-9]{40}|wrf[a-zA-Z0-9]{35,40})$/;

function isValidWalletAddress(address: unknown): address is string {
  return typeof address === 'string' && WALLET_ADDRESS_PATTERN.test(address);
}

function normalizePositiveInteger(
  value: unknown,
  defaultValue: number,
  maxValue?: number
): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue)) {
    return defaultValue;
  }

  const normalizedValue = Math.max(1, Math.floor(parsedValue));
  return maxValue ? Math.min(maxValue, normalizedValue) : normalizedValue;
}

function createApiResponse<T>(
  data: T,
  meta?: Record<string, any>
): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}

function createApiError(
  code: string,
  message: string,
  details?: unknown
): ApiError {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
}

export class WalletController {
  static async getWalletBalance(req: Request, res: Response) {
    try {
      const { address } = req.params;

      // Validate address format
      if (!isValidWalletAddress(address)) {
        return res
          .status(400)
          .json(createApiError('INVALID_ADDRESS', 'Invalid address format'));
      }

      // Mock wallet balance data - in production this would query blockchain
      const walletBalance: WalletBalance = {
        address,
        balance: '125.4589 WRF',
        tokens: [
          { token: 'WRF', balance: '125.4589', value: '$125.46' },
          { token: 'USDC', balance: '500.00', value: '$500.00' },
          { token: 'WETH', balance: '0.05', value: '$150.00' },
        ],
        stakingRewards: '12.45 WRF',
        weatherRewards: '8.92 WRF',
      };

      return res.json(createApiResponse(walletBalance));
    } catch (error) {
      console.error('Wallet balance error:', error);
      return res
        .status(500)
        .json(
          createApiError(
            'WALLET_ERROR',
            'Failed to fetch wallet balance',
            error
          )
        );
    }
  }

  static async getTransactionHistory(req: Request, res: Response) {
    try {
      const { address } = req.params;
      const { page = 1, limit = 20 } = req.query;

      // Validate address format
      if (!isValidWalletAddress(address)) {
        return res
          .status(400)
          .json(createApiError('INVALID_ADDRESS', 'Invalid address format'));
      }

      // Validate pagination parameters
      const validatedPage = normalizePositiveInteger(page, 1);
      const validatedLimit = normalizePositiveInteger(limit, 20, 100);

      // Mock transaction data - in production this would query blockchain
      const mockTransactions: Transaction[] = [
        {
          hash: '0xabc123def456...',
          from: address,
          to: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f9999',
          amount: '10.5',
          token: 'WRF',
          timestamp: new Date('2025-06-22T10:00:00Z'),
          status: 'confirmed',
          fee: '0.001',
        },
        {
          hash: '0xdef456abc789...',
          from: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f8888',
          to: address,
          amount: '25.0',
          token: 'WRF',
          timestamp: new Date('2025-06-21T15:30:00Z'),
          status: 'confirmed',
          fee: '0.001',
          memo: 'Weather data reward',
        },
      ];

      const total = 150; // Mock total count
      const totalPages = Math.ceil(total / validatedLimit);

      const response: PaginatedResponse<Transaction> = {
        data: mockTransactions,
        pagination: {
          page: validatedPage,
          limit: validatedLimit,
          total,
          totalPages,
          hasNext: validatedPage < totalPages,
          hasPrev: validatedPage > 1,
        },
      };

      return res.json(createApiResponse(response));
    } catch (error) {
      console.error('Transaction history error:', error);
      return res
        .status(500)
        .json(
          createApiError(
            'TRANSACTIONS_ERROR',
            'Failed to fetch transaction history',
            error
          )
        );
    }
  }

  static async createTransaction(req: Request, res: Response) {
    try {
      const { to, amount, token = 'WRF', memo } = req.body;

      if (!to || amount === undefined || amount === null || amount === '') {
        return res
          .status(400)
          .json(
            createApiError(
              'MISSING_PARAMS',
              'Missing required parameters: to, amount'
            )
          );
      }

      if (!isValidWalletAddress(to)) {
        return res
          .status(400)
          .json(createApiError('INVALID_ADDRESS', 'Invalid address format'));
      }

      const numericAmount = Number(amount);

      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res
          .status(400)
          .json(createApiError('INVALID_AMOUNT', 'Amount must be greater than 0'));
      }

      // Mock transaction creation - in production this would interact with blockchain
      const transaction: Transaction = {
        hash: `0x${Math.random().toString(16).substr(2, 64)}`,
        from: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234', // Mock sender
        to,
        amount: amount.toString(),
        token,
        timestamp: new Date(),
        status: 'pending',
        fee: '0.001',
        memo,
      };

      return res.json(createApiResponse(transaction));
    } catch (error) {
      console.error('Transaction creation error:', error);
      return res
        .status(500)
        .json(
          createApiError(
            'TRANSACTION_ERROR',
            'Failed to create transaction',
            error
          )
        );
    }
  }
}
