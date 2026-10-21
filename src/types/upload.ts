/**
 * Upload Types
 * Type definitions for file upload functionality
 */

export type CloudStorageProvider = 's3' | 'gcs' | 'azure' | 'local';

export interface UploadResponse {
  success: boolean;
  fileId?: string;
  fileName?: string;
  url?: string;
  error?: string;
}

export interface FileMetadata {
  originalName: string;
  mimeType: string;
  size: number;
  extension: string;
  uploadedAt: Date;
  uploadedBy?: string;
  category?: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

export interface UploadValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}
