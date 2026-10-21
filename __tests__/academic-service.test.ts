import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSelectLimit = jest.fn();
const mockSelectWhere = jest.fn(() => ({ limit: mockSelectLimit }));
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

const mockOnConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
const mockInsertValues = jest.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
};

jest.mock('../database/connection.js', () => ({
  db: mockDb,
}));

jest.mock('../shared/schema-marketplace.js', () => ({
  academicApplications: {
    id: 'academic_applications.id',
    userId: 'academic_applications.user_id',
    email: 'academic_applications.email',
  },
  marketplaceSubscriptions: {
    id: 'marketplace_subscriptions.id',
    userId: 'marketplace_subscriptions.user_id',
    tier: 'marketplace_subscriptions.tier',
    apiKey: 'marketplace_subscriptions.api_key',
    isActive: 'marketplace_subscriptions.is_active',
    updatedAt: 'marketplace_subscriptions.updated_at',
  },
  ACADEMIC_STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
  },
  MARKETPLACE_TIERS: {
    FREE: 'free',
    PRO: 'pro',
    ENTERPRISE: 'enterprise',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ['eq', a, b]),
}), { virtual: true });

import { AcademicService } from '../server/services/academic-service.js';

describe('AcademicService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the stored and returned API key aligned when approving an existing subscription', async () => {
    mockSelectLimit
      .mockResolvedValueOnce([
        {
          id: 'app-1',
          userId: 'user-1',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'sub-1',
          apiKey: 'persisted-pro-key',
        },
      ]);

    const service = new AcademicService();
    const result = await service.approve('app-1');

    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ['marketplace_subscriptions.user_id'],
        set: expect.objectContaining({
          tier: 'pro',
          apiKey: expect.stringMatching(/^wrf_edu_/),
          isActive: true,
        }),
      })
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        provisionedApiKey: 'persisted-pro-key',
      })
    );
    expect(result).toEqual({ success: true, apiKey: 'persisted-pro-key' });
  });
});
