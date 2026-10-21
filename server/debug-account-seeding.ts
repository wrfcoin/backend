import crypto from 'node:crypto';
import express, { Request, Response } from 'express';

import type { WalletBalance } from '../shared/types/api-types.js';
import type { ValidatorInfo } from '../shared/types/blockchain-types.js';
import type {
  EthereumAddress,
  PositiveNumber,
} from '../shared/types/security-types.js';

interface DebugSeedAccountRequestBody {
  address?: unknown;
  amount?: unknown;
  stakeAmount?: unknown;
}

type ApiErrorFactory = (
  code: string,
  message: string,
  details?: unknown,
) => unknown;

export interface DebugSeedAccountInput {
  address: string;
  amount: number;
  stakeAmount?: number;
}

export interface SeededAccountState {
  address: string;
  amount: number;
  stakeAmount: number;
  seededAt: string;
}

export interface DebugSeedAccountRouterOptions {
  createApiError?: ApiErrorFactory;
  getNodeEnv?: () => string | undefined;
  getOperatorToken?: () => string | undefined;
}

const ADDRESS_PATTERN = /^(0x[a-fA-F0-9]{40}|wrf[a-zA-Z0-9]{35,40})$/;
const seededAccounts = new Map<string, SeededAccountState>();

function toPositiveNumber(value: number): PositiveNumber {
  return value as PositiveNumber;
}

function toEthereumAddress(value: string): EthereumAddress {
  return value as EthereumAddress;
}

function normalizeSeedAddress(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address;
}

function createDefaultApiError(
  code: string,
  message: string,
  details?: unknown,
): Record<string, unknown> {
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

function hasMatchingOperatorToken(
  req: Request,
  getOperatorToken: () => string | undefined,
): boolean {
  const expectedToken = getOperatorToken();
  const authorizationHeader = req.headers.authorization;

  if (!expectedToken || !authorizationHeader?.startsWith('Bearer ')) {
    return false;
  }

  const providedToken = authorizationHeader.slice('Bearer '.length).trim();
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(providedToken);

  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length !== providedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function isDebugSeedAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address);
}

export function parseSeedAmount(
  value: unknown,
  fieldName: 'amount' | 'stakeAmount',
): number | null {
  if (value === undefined) {
    return fieldName === 'stakeAmount' ? 0 : null;
  }

  const numericValue =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  if (
    typeof numericValue !== 'number' ||
    !Number.isFinite(numericValue) ||
    !Number.isSafeInteger(numericValue) ||
    numericValue < 0
  ) {
    return null;
  }

  return numericValue;
}

function parseSeedAccountRequest(
  body: DebugSeedAccountRequestBody,
): DebugSeedAccountInput | null {
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const amount = parseSeedAmount(body.amount, 'amount');
  const stakeAmount = parseSeedAmount(body.stakeAmount, 'stakeAmount');

  if (!isDebugSeedAddress(address) || amount === null || stakeAmount === null) {
    return null;
  }

  return {
    address,
    amount,
    stakeAmount,
  };
}

export function seedDebugAccount(
  input: DebugSeedAccountInput,
): SeededAccountState {
  const normalizedAddress = normalizeSeedAddress(input.address);
  const seededAccount: SeededAccountState = {
    address: input.address,
    amount: input.amount,
    stakeAmount: input.stakeAmount ?? 0,
    seededAt: new Date().toISOString(),
  };

  seededAccounts.set(normalizedAddress, seededAccount);
  return seededAccount;
}

export function getSeededWalletBalance(address: string): WalletBalance | null {
  const seededAccount = seededAccounts.get(normalizeSeedAddress(address));
  if (!seededAccount) {
    return null;
  }

  return {
    address: seededAccount.address,
    balance: `${seededAccount.amount} WRF`,
    tokens: [],
    nfts: [],
  };
}

export function getSeededValidators(): ValidatorInfo[] {
  return [...seededAccounts.values()]
    .filter(account => account.stakeAmount > 0)
    .sort((left, right) => left.address.localeCompare(right.address))
    .map(account => ({
      address: toEthereumAddress(account.address),
      stake: toPositiveNumber(account.stakeAmount),
      commission: 5,
      uptime: 99.9,
      blocksProposed: 0,
      slashingEvents: 0,
      delegators: 0,
      isActive: true,
    }));
}

export function resetDebugAccountSeedState(): void {
  seededAccounts.clear();
}

export function createDebugAccountSeedRouter(
  options: DebugSeedAccountRouterOptions = {},
): express.Router {
  const router = express.Router();
  const createApiError = options.createApiError ?? createDefaultApiError;
  const getNodeEnv = options.getNodeEnv ?? (() => process.env.NODE_ENV);
  const getOperatorToken =
    options.getOperatorToken ?? (() => process.env.WRFCOIN_OPERATOR_TOKEN);

  router.post('/debug/seed-account', (req: Request, res: Response) => {
    if (getNodeEnv() === 'production') {
      res
        .status(404)
        .json(createApiError('NOT_FOUND', `Endpoint ${req.originalUrl} not found`));
      return;
    }

    if (!getOperatorToken()) {
      res
        .status(503)
        .json(
          createApiError(
            'DEBUG_SEED_ACCOUNT_DISABLED',
            'WRFCOIN_OPERATOR_TOKEN must be configured to enable /debug/seed-account',
          ),
        );
      return;
    }

    if (!hasMatchingOperatorToken(req, getOperatorToken)) {
      res
        .status(401)
        .json(
          createApiError(
            'UNAUTHORIZED',
            'Operator bearer token required for /debug/seed-account',
          ),
        );
      return;
    }

    const parsedBody = parseSeedAccountRequest(
      (req.body ?? {}) as DebugSeedAccountRequestBody,
    );

    if (!parsedBody) {
      res
        .status(400)
        .json(
          createApiError(
            'INVALID_SEED_ACCOUNT_REQUEST',
            'address must be valid and amount/stakeAmount must be non-negative safe integers',
          ),
        );
      return;
    }

    const seededAccount = seedDebugAccount(parsedBody);
    res.status(200).json({
      status: 'success',
      address: seededAccount.address,
      amount: seededAccount.amount,
      stakeAmount: seededAccount.stakeAmount,
      validatorSeeded: seededAccount.stakeAmount > 0,
    });
  });

  return router;
}
