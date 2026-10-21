const { paginatedResponse } = require('../../server/utils/api-error.js');

describe('paginatedResponse', () => {
  it('emits pagination.limit for frontend consumers', () => {
    const response = paginatedResponse([{ id: 1 }], 11, 2, 5);

    expect(response.pagination).toMatchObject({
      total: 11,
      page: 2,
      limit: 5,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
    expect(response.pagination).not.toHaveProperty('pageSize');
  });

  it('gracefully handles zero-or-less limit values', () => {
    const response = paginatedResponse([], 0, 1, 0);

    expect(response.pagination).toMatchObject({
      limit: 0,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });
});

import { describe, expect, it } from '@jest/globals';
import { createApiError } from '../../server/utils/api-error.js';

describe('server api error helper', () => {
  it('omits raw Error details from canonical envelopes', () => {
    const error = Object.assign(
      new Error('postgres://user:secret@db.internal/wrfcoin'),
      { code: 'DB_CONN_FAILURE', statusCode: 503 }
    );

    const response = createApiError(
      'STORAGE_STATUS_ERROR',
      'Failed to fetch storage status',
      error
    );

    expect(response.error).toEqual({
      code: 'STORAGE_STATUS_ERROR',
      message: 'Failed to fetch storage status',
      details: {
        code: 'DB_CONN_FAILURE',
        statusCode: 503,
      },
    });
    expect(JSON.stringify(response)).not.toContain('postgres://');
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
