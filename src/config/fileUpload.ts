/**
 * Secure File Upload Configuration
 * Implements security best practices for file uploads following Gemini security strategy
 */

import { CloudStorageProvider } from '../types/upload.js';

export interface FileUploadConfig {
  // Storage configuration
  storage: {
    provider: CloudStorageProvider;
    s3: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
      acl: string;
      serverSideEncryption: string;
      storageClass: string;
    };
  };

  // Security configuration
  security: {
    maxFileSize: number;
    maxFiles: number;
    allowedMimeTypes: string[];
    allowedExtensions: string[];
    virusScan: {
      enabled: boolean;
      clamavHost: string;
      clamavPort: number;
      timeout: number;
    };
    contentValidation: {
      enabled: boolean;
      magicNumberCheck: boolean;
      contentTypeValidation: boolean;
    };
    rateLimiting: {
      windowMs: number;
      maxUploads: number;
    };
  };

  // Temporary storage
  tempStorage: {
    path: string;
    cleanupInterval: number;
    maxAge: number;
  };

  // Logging configuration
  logging: {
    enabled: boolean;
    level: string;
    auditTrail: boolean;
  };
}

// Default configuration
export const defaultFileUploadConfig: FileUploadConfig = {
  storage: {
    provider: 's3',
    s3: {
      bucket: process.env.AWS_S3_BUCKET || 'wrfcoin-secure-uploads',
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      endpoint: process.env.AWS_S3_ENDPOINT,
      acl: 'private',
      serverSideEncryption: 'AES256',
      storageClass: 'STANDARD',
    },
  },

  security: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    allowedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/json',
      'application/xml',
      'text/xml',
    ],
    allowedExtensions: [
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.txt',
      '.csv',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.json',
      '.xml',
    ],
    virusScan: {
      enabled: true,
      clamavHost: process.env.CLAMAV_HOST || 'localhost',
      clamavPort: parseInt(process.env.CLAMAV_PORT || '3310'),
      timeout: 30000, // 30 seconds
    },
    contentValidation: {
      enabled: true,
      magicNumberCheck: true,
      contentTypeValidation: true,
    },
    rateLimiting: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxUploads: 20,
    },
  },

  tempStorage: {
    path: process.env.TEMP_UPLOAD_PATH || '/tmp/wrfcoin-uploads',
    cleanupInterval: 60 * 60 * 1000, // 1 hour
    maxAge: 4 * 60 * 60 * 1000, // 4 hours
  },

  logging: {
    enabled: true,
    level: process.env.LOG_LEVEL || 'info',
    auditTrail: true,
  },
};

// File type magic numbers for validation
export const FILE_MAGIC_NUMBERS = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  gif: [0x47, 0x49, 0x46, 0x38],
  doc: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  docx: [0x50, 0x4b, 0x03, 0x04], // ZIP signature (DOCX is ZIP-based)
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  xlsx: [0x50, 0x4b, 0x03, 0x04], // ZIP signature (XLSX is ZIP-based)
  webp: [0x57, 0x45, 0x42, 0x50], // WEBP
};

// Security headers for file uploads
export const UPLOAD_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

// Upload categories for different use cases
export const UPLOAD_CATEGORIES = {
  DOCUMENT: 'document',
  IMAGE: 'image',
  REPORT: 'report',
  VERIFICATION: 'verification',
  COMPLIANCE: 'compliance',
  TEMP: 'temp',
} as const;

export type UploadCategory =
  (typeof UPLOAD_CATEGORIES)[keyof typeof UPLOAD_CATEGORIES];

// Error messages
export const UPLOAD_ERROR_MESSAGES = {
  FILE_TOO_LARGE: 'File size exceeds maximum limit',
  INVALID_FILE_TYPE: 'File type not allowed',
  INVALID_EXTENSION: 'File extension not allowed',
  VIRUS_DETECTED: 'File contains malicious content',
  VALIDATION_FAILED: 'File validation failed',
  UPLOAD_FAILED: 'Upload failed',
  RATE_LIMIT_EXCEEDED: 'Upload rate limit exceeded',
  MISSING_FILE: 'No file provided',
  INVALID_CONTENT_TYPE: 'Invalid content type',
  MAGIC_NUMBER_MISMATCH: 'File content does not match extension',
  STORAGE_ERROR: 'Storage service error',
  TEMP_STORAGE_ERROR: 'Temporary storage error',
  CLEANUP_ERROR: 'File cleanup error',
} as const;

export type UploadErrorMessage =
  (typeof UPLOAD_ERROR_MESSAGES)[keyof typeof UPLOAD_ERROR_MESSAGES];
