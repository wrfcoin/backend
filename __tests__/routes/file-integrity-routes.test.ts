import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Application } from 'express';
import { Readable } from 'stream';
const request = require('supertest');
const express = require('express');

const testFileId = '550e8400-e29b-41d4-a716-446655440000';
const testFileContent = 'file-integrity-test-content';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockFilePermissionService = {
  checkFilePermission: jest.fn(),
};

const mockEnhancedFileStorageService = {
  getFile: jest.fn(),
};

const mockFileIntegrityService = {
  verifyFileIntegrity: jest.fn(),
  detectCorruption: jest.fn(),
  getMonitoringStatus: jest.fn(),
  getIntegrityStatistics: jest.fn(),
  updateMonitoringConfig: jest.fn(),
};

const mockIntegrityMonitoringService = {
  scheduleVerification: jest.fn(),
  getHealthStatus: jest.fn(),
  getScheduledVerifications: jest.fn(),
  cancelVerification: jest.fn(),
  acknowledgeAlert: jest.fn(),
  generateReport: jest.fn(),
};

const mockS3Send = jest.fn();

jest.mock('../../utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('../../server/services/file-permission-service', () => ({
  filePermissionService: mockFilePermissionService,
}));

jest.mock('../../server/services/enhanced-file-storage', () => ({
  enhancedFileStorageService: mockEnhancedFileStorageService,
}));

jest.mock('../../server/services/file-integrity-service', () => ({
  fileIntegrityService: mockFileIntegrityService,
}));

jest.mock('../../server/services/integrity-monitoring-service', () => ({
  integrityMonitoringService: mockIntegrityMonitoringService,
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: mockS3Send,
  })),
  GetObjectCommand: jest.fn((input: unknown) => input),
}));

import fileIntegrityRoutes from '../../src/routes/file-integrity-routes.js';

const createApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/file-integrity', fileIntegrityRoutes);
  return app;
};

describe('file-integrity-routes hashing policy', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();

    mockFilePermissionService.checkFilePermission.mockResolvedValue({
      hasPermission: true,
    });
    mockEnhancedFileStorageService.getFile.mockResolvedValue({
      filename: 'test.txt',
      storagePath: 'uploads/test.txt',
    });
    mockS3Send.mockResolvedValue({
      Body: Readable.from([Buffer.from(testFileContent)]),
    });
  });

  it('rejects MD5 by default for generate-hashes with deterministic payload', async () => {
    const response = await request(app)
      .post('/api/file-integrity/generate-hashes')
      .set('x-user-id', '1')
      .send({
        fileId: testFileId,
        algorithms: ['MD5'],
      })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error:
        'Unsupported hash algorithm requested. Supported algorithms are SHA256, SHA512, and BLAKE2B.',
      code: 'UNSUPPORTED_HASH_ALGORITHM',
      details: {
        disallowedAlgorithms: ['MD5'],
        allowedAlgorithms: ['SHA256', 'SHA512', 'BLAKE2B'],
      },
    });
    expect(mockFilePermissionService.checkFilePermission).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects SHA1 by default for generate-hashes with deterministic payload', async () => {
    const response = await request(app)
      .post('/api/file-integrity/generate-hashes')
      .set('x-user-id', '1')
      .send({
        fileId: testFileId,
        algorithms: ['SHA1'],
      })
      .expect(400);

    expect(response.body.code).toBe('UNSUPPORTED_HASH_ALGORITHM');
    expect(response.body.details.disallowedAlgorithms).toEqual(['SHA1']);
    expect(response.body.details.allowedAlgorithms).toEqual([
      'SHA256',
      'SHA512',
      'BLAKE2B',
    ]);
  });

  it('accepts strong algorithms for generate-hashes', async () => {
    const response = await request(app)
      .post('/api/file-integrity/generate-hashes')
      .set('x-user-id', '1')
      .send({
        fileId: testFileId,
        algorithms: ['SHA256', 'SHA512', 'BLAKE2B'],
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.hashes).toHaveLength(3);
    expect(response.body.data.hashes.map((h: any) => h.algorithm)).toEqual([
      'SHA256',
      'SHA512',
      'BLAKE2B',
    ]);
    expect(response.body.data.hashes[0].hash).toHaveLength(64);
    expect(response.body.data.hashes[1].hash).toHaveLength(128);
    expect(response.body.data.hashes[2].hash).toHaveLength(128);
  });

  it('rejects mixed strong and weak algorithms deterministically', async () => {
    const response = await request(app)
      .post('/api/file-integrity/generate-hashes')
      .set('x-user-id', '1')
      .send({
        fileId: testFileId,
        algorithms: ['SHA256', 'MD5'],
      })
      .expect(400);

    expect(response.body.code).toBe('UNSUPPORTED_HASH_ALGORITHM');
    expect(response.body.details.disallowedAlgorithms).toEqual(['MD5']);
  });

  it('applies the same weak-hash policy to verify endpoint', async () => {
    const response = await request(app)
      .post('/api/file-integrity/verify')
      .set('x-user-id', '1')
      .send({
        fileId: testFileId,
        algorithms: ['SHA1'],
      })
      .expect(400);

    expect(response.body.code).toBe('UNSUPPORTED_HASH_ALGORITHM');
    expect(mockFileIntegrityService.verifyFileIntegrity).not.toHaveBeenCalled();
  });
});
