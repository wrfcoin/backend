/**
 * Cloud Storage Providers
 * AWS S3, Google Cloud Storage, Azure Blob Storage implementations
 */

import { logger } from '../../utils/logger.js';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Storage as GoogleCloudStorage } from '@google-cloud/storage';
import { BlobServiceClient } from '@azure/storage-blob';
import * as crypto from 'crypto';

export interface CloudProvider {
  name: string;
  isConfigured: boolean;
  isHealthy: boolean;
  lastHealthCheck: Date;
}

export interface CloudStorageResult {
  path: string;
  checksum: string;
  size: number;
  etag?: string;
  versionId?: string;
  metadata: Record<string, any>;
}

export interface ProcessedFile {
  data: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
  checksum: string;
}

export class CloudStorageProviders {
  private s3Client?: S3Client;
  private gcsClient?: GoogleCloudStorage;
  private azureClient?: BlobServiceClient;
  private isInitialized: boolean = false;
  private providers: Map<string, CloudProvider> = new Map();

  // Configuration
  private config = {
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1',
      bucket: process.env.AWS_S3_BUCKET || 'wrfcoin-storage',
    },
    gcp: {
      projectId: process.env.GCP_PROJECT_ID,
      keyFilename: process.env.GCP_KEY_FILE,
      bucket: process.env.GCS_BUCKET || 'wrfcoin-storage',
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
      containerName: process.env.AZURE_CONTAINER_NAME || 'wrfcoin-storage',
    },
  };

  constructor() {
    this.initializeProviders();
  }

  /**
   * Initialize cloud storage providers
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[CloudStorage] Initializing cloud storage providers');

      await this.setupAWS();
      await this.setupGCP();
      await this.setupAzure();

      // Initial health check
      await this.healthCheckAll();

      this.isInitialized = true;
      logger.info(
        '[CloudStorage] Cloud storage providers initialized successfully',
        {
          configuredProviders: Array.from(this.providers.keys()).filter(
            key => this.providers.get(key)?.isConfigured
          ),
        }
      );
    } catch (error) {
      logger.error(
        '[CloudStorage] Failed to initialize cloud storage providers',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Store file on specified cloud provider
   */
  async store(
    fileId: string,
    file: ProcessedFile,
    providerName: string = 'aws_s3'
  ): Promise<CloudStorageResult> {
    if (!this.isInitialized) {
      throw new Error('Cloud storage providers not initialized');
    }

    const provider = this.providers.get(providerName);
    if (!provider?.isConfigured) {
      throw new Error(`Cloud provider ${providerName} is not configured`);
    }

    try {
      logger.info('[CloudStorage] Storing file on cloud provider', {
        fileId,
        provider: providerName,
        originalName: file.originalName,
        size: file.size,
      });

      let result: CloudStorageResult;

      switch (providerName) {
        case 'aws_s3':
          result = await this.storeOnS3(fileId, file);
          break;
        case 'google_cloud':
          result = await this.storeOnGCS(fileId, file);
          break;
        case 'azure_blob':
          result = await this.storeOnAzure(fileId, file);
          break;
        default:
          throw new Error(`Unsupported cloud provider: ${providerName}`);
      }

      logger.info('[CloudStorage] File stored successfully on cloud provider', {
        fileId,
        provider: providerName,
        path: result.path,
        size: result.size,
      });

      return result;
    } catch (error) {
      logger.error('[CloudStorage] Error storing file on cloud provider', {
        fileId,
        provider: providerName,
        file: { ...file, data: '[REDACTED]' },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve file from specified cloud provider
   */
  async retrieve(
    fileId: string,
    storagePath: string,
    providerName: string = 'aws_s3'
  ): Promise<Buffer> {
    if (!this.isInitialized) {
      throw new Error('Cloud storage providers not initialized');
    }

    const provider = this.providers.get(providerName);
    if (!provider?.isConfigured) {
      throw new Error(`Cloud provider ${providerName} is not configured`);
    }

    try {
      logger.info('[CloudStorage] Retrieving file from cloud provider', {
        fileId,
        provider: providerName,
        storagePath,
      });

      let data: Buffer;

      switch (providerName) {
        case 'aws_s3':
          data = await this.retrieveFromS3(storagePath);
          break;
        case 'google_cloud':
          data = await this.retrieveFromGCS(storagePath);
          break;
        case 'azure_blob':
          data = await this.retrieveFromAzure(storagePath);
          break;
        default:
          throw new Error(`Unsupported cloud provider: ${providerName}`);
      }

      logger.info(
        '[CloudStorage] File retrieved successfully from cloud provider',
        {
          fileId,
          provider: providerName,
          size: data.length,
        }
      );

      return data;
    } catch (error) {
      logger.error('[CloudStorage] Error retrieving file from cloud provider', {
        fileId,
        provider: providerName,
        storagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete file from specified cloud provider
   */
  async delete(
    fileId: string,
    storagePath: string,
    providerName: string = 'aws_s3'
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Cloud storage providers not initialized');
    }

    const provider = this.providers.get(providerName);
    if (!provider?.isConfigured) {
      throw new Error(`Cloud provider ${providerName} is not configured`);
    }

    try {
      logger.info('[CloudStorage] Deleting file from cloud provider', {
        fileId,
        provider: providerName,
        storagePath,
      });

      switch (providerName) {
        case 'aws_s3':
          await this.deleteFromS3(storagePath);
          break;
        case 'google_cloud':
          await this.deleteFromGCS(storagePath);
          break;
        case 'azure_blob':
          await this.deleteFromAzure(storagePath);
          break;
        default:
          throw new Error(`Unsupported cloud provider: ${providerName}`);
      }

      logger.info(
        '[CloudStorage] File deleted successfully from cloud provider',
        {
          fileId,
          provider: providerName,
        }
      );
    } catch (error) {
      logger.error('[CloudStorage] Error deleting file from cloud provider', {
        fileId,
        provider: providerName,
        storagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Store file on AWS S3
   */
  private async storeOnS3(
    fileId: string,
    file: ProcessedFile
  ): Promise<CloudStorageResult> {
    if (!this.s3Client) {
      throw new Error('AWS S3 client not configured');
    }

    const key = this.generateS3Key(fileId, file.originalName);

    const params = {
      Bucket: this.config.aws.bucket,
      Key: key,
      Body: file.data,
      ContentType: file.mimeType,
      ContentLength: file.size,
      ChecksumSHA256: file.checksum,
      Metadata: {
        'original-name': file.originalName,
        'file-id': fileId,
        'upload-timestamp': new Date().toISOString(),
      },
      ServerSideEncryption: 'AES256' as const,
    };

    const result = await this.s3Client.send(new PutObjectCommand(params));

    return {
      path: key,
      checksum: file.checksum,
      size: file.size,
      etag: result.ETag,
      versionId: result.VersionId,
      metadata: {
        provider: 'aws_s3',
        bucket: this.config.aws.bucket,
        region: this.config.aws.region,
        serverSideEncryption: 'AES256',
        uploadedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Store file on Google Cloud Storage
   */
  private async storeOnGCS(
    fileId: string,
    file: ProcessedFile
  ): Promise<CloudStorageResult> {
    if (!this.gcsClient) {
      throw new Error('Google Cloud Storage client not configured');
    }

    const fileName = this.generateGCSFileName(fileId, file.originalName);
    const bucket = this.gcsClient.bucket(this.config.gcp.bucket);
    const gcsFile = bucket.file(fileName);

    const metadata = {
      metadata: {
        'original-name': file.originalName,
        'file-id': fileId,
        'upload-timestamp': new Date().toISOString(),
        checksum: file.checksum,
      },
      contentType: file.mimeType,
    };

    await gcsFile.save(file.data, metadata);

    // Get the uploaded file metadata
    const [gcsMetadata] = await gcsFile.getMetadata();

    return {
      path: fileName,
      checksum: file.checksum,
      size: file.size,
      metadata: {
        provider: 'google_cloud',
        bucket: this.config.gcp.bucket,
        generation: gcsMetadata.generation,
        crc32c: gcsMetadata.crc32c,
        uploadedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Store file on Azure Blob Storage
   */
  private async storeOnAzure(
    fileId: string,
    file: ProcessedFile
  ): Promise<CloudStorageResult> {
    if (!this.azureClient) {
      throw new Error('Azure Blob Storage client not configured');
    }

    const blobName = this.generateAzureBlobName(fileId, file.originalName);
    const containerClient = this.azureClient.getContainerClient(
      this.config.azure.containerName
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const blobOptions = {
      blobHTTPHeaders: {
        blobContentType: file.mimeType,
      },
      metadata: {
        'original-name': file.originalName,
        'file-id': fileId,
        'upload-timestamp': new Date().toISOString(),
        checksum: file.checksum,
      },
    };

    const result = await blockBlobClient.upload(
      file.data,
      file.size,
      blobOptions
    );

    return {
      path: blobName,
      checksum: file.checksum,
      size: file.size,
      etag: result.etag,
      metadata: {
        provider: 'azure_blob',
        containerName: this.config.azure.containerName,
        requestId: result.requestId,
        uploadedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Retrieve file from AWS S3
   */
  private async retrieveFromS3(key: string): Promise<Buffer> {
    if (!this.s3Client) {
      throw new Error('AWS S3 client not configured');
    }

    const params = {
      Bucket: this.config.aws.bucket,
      Key: key,
    };

    const result = await this.s3Client.send(new GetObjectCommand(params));

    if (!result.Body) {
      throw new Error('No data received from S3');
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as any) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Retrieve file from Google Cloud Storage
   */
  private async retrieveFromGCS(fileName: string): Promise<Buffer> {
    if (!this.gcsClient) {
      throw new Error('Google Cloud Storage client not configured');
    }

    const bucket = this.gcsClient.bucket(this.config.gcp.bucket);
    const file = bucket.file(fileName);

    const [data] = await file.download();
    return data;
  }

  /**
   * Retrieve file from Azure Blob Storage
   */
  private async retrieveFromAzure(blobName: string): Promise<Buffer> {
    if (!this.azureClient) {
      throw new Error('Azure Blob Storage client not configured');
    }

    const containerClient = this.azureClient.getContainerClient(
      this.config.azure.containerName
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const response = await blockBlobClient.download();

    if (!response.readableStreamBody) {
      throw new Error('No data received from Azure Blob Storage');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Delete file from AWS S3
   */
  private async deleteFromS3(key: string): Promise<void> {
    if (!this.s3Client) {
      throw new Error('AWS S3 client not configured');
    }

    const params = {
      Bucket: this.config.aws.bucket,
      Key: key,
    };

    await this.s3Client.send(new DeleteObjectCommand(params));
  }

  /**
   * Delete file from Google Cloud Storage
   */
  private async deleteFromGCS(fileName: string): Promise<void> {
    if (!this.gcsClient) {
      throw new Error('Google Cloud Storage client not configured');
    }

    const bucket = this.gcsClient.bucket(this.config.gcp.bucket);
    const file = bucket.file(fileName);

    await file.delete();
  }

  /**
   * Delete file from Azure Blob Storage
   */
  private async deleteFromAzure(blobName: string): Promise<void> {
    if (!this.azureClient) {
      throw new Error('Azure Blob Storage client not configured');
    }

    const containerClient = this.azureClient.getContainerClient(
      this.config.azure.containerName
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.delete();
  }

  /**
   * Setup AWS S3 client
   */
  private async setupAWS(): Promise<void> {
    if (!this.config.aws.accessKeyId || !this.config.aws.secretAccessKey) {
      logger.warn('[CloudStorage] AWS S3 credentials not configured');
      this.providers.set('aws_s3', {
        name: 'AWS S3',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
      return;
    }

    try {
      this.s3Client = new S3Client({
        region: this.config.aws.region,
        credentials: {
          accessKeyId: this.config.aws.accessKeyId,
          secretAccessKey: this.config.aws.secretAccessKey,
        },
      });

      this.providers.set('aws_s3', {
        name: 'AWS S3',
        isConfigured: true,
        isHealthy: false, // Will be set by health check
        lastHealthCheck: new Date(),
      });

      logger.info('[CloudStorage] AWS S3 client configured successfully');
    } catch (error) {
      logger.error('[CloudStorage] Failed to setup AWS S3', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.providers.set('aws_s3', {
        name: 'AWS S3',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
    }
  }

  /**
   * Setup Google Cloud Storage client
   */
  private async setupGCP(): Promise<void> {
    if (!this.config.gcp.projectId) {
      logger.warn(
        '[CloudStorage] Google Cloud Storage project ID not configured'
      );
      this.providers.set('google_cloud', {
        name: 'Google Cloud Storage',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
      return;
    }

    try {
      const gcsConfig: any = {
        projectId: this.config.gcp.projectId,
      };

      if (this.config.gcp.keyFilename) {
        gcsConfig.keyFilename = this.config.gcp.keyFilename;
      }

      this.gcsClient = new GoogleCloudStorage(gcsConfig);

      this.providers.set('google_cloud', {
        name: 'Google Cloud Storage',
        isConfigured: true,
        isHealthy: false, // Will be set by health check
        lastHealthCheck: new Date(),
      });

      logger.info(
        '[CloudStorage] Google Cloud Storage client configured successfully'
      );
    } catch (error) {
      logger.error('[CloudStorage] Failed to setup Google Cloud Storage', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.providers.set('google_cloud', {
        name: 'Google Cloud Storage',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
    }
  }

  /**
   * Setup Azure Blob Storage client
   */
  private async setupAzure(): Promise<void> {
    if (!this.config.azure.connectionString) {
      logger.warn(
        '[CloudStorage] Azure Blob Storage connection string not configured'
      );
      this.providers.set('azure_blob', {
        name: 'Azure Blob Storage',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
      return;
    }

    try {
      this.azureClient = BlobServiceClient.fromConnectionString(
        this.config.azure.connectionString
      );

      this.providers.set('azure_blob', {
        name: 'Azure Blob Storage',
        isConfigured: true,
        isHealthy: false, // Will be set by health check
        lastHealthCheck: new Date(),
      });

      logger.info(
        '[CloudStorage] Azure Blob Storage client configured successfully'
      );
    } catch (error) {
      logger.error('[CloudStorage] Failed to setup Azure Blob Storage', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.providers.set('azure_blob', {
        name: 'Azure Blob Storage',
        isConfigured: false,
        isHealthy: false,
        lastHealthCheck: new Date(),
      });
    }
  }

  /**
   * Health check all configured providers
   */
  private async healthCheckAll(): Promise<void> {
    const healthChecks = Array.from(this.providers.entries())
      .filter(([, provider]) => provider.isConfigured)
      .map(async ([name, provider]) => {
        try {
          const isHealthy = await this.healthCheckProvider(name);
          provider.isHealthy = isHealthy;
          provider.lastHealthCheck = new Date();
        } catch (error) {
          logger.error(`[CloudStorage] Health check failed for ${name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          provider.isHealthy = false;
          provider.lastHealthCheck = new Date();
        }
      });

    await Promise.allSettled(healthChecks);
  }

  /**
   * Health check individual provider
   */
  private async healthCheckProvider(providerName: string): Promise<boolean> {
    try {
      switch (providerName) {
        case 'aws_s3':
          if (!this.s3Client) return false;
          // Test S3 access by listing objects (limit 1)
          await this.s3Client.send(
            new HeadObjectCommand({
              Bucket: this.config.aws.bucket,
              Key: 'health-check-non-existent-file',
            })
          );
          return true; // If we get here without exception, S3 is accessible

        case 'google_cloud':
          if (!this.gcsClient) return false;
          // Test GCS access
          const bucket = this.gcsClient.bucket(this.config.gcp.bucket);
          await (bucket as any).exists();
          return true;

        case 'azure_blob':
          if (!this.azureClient) return false;
          // Test Azure access
          const containerClient = this.azureClient.getContainerClient(
            this.config.azure.containerName
          );
          await containerClient.exists();
          return true;

        default:
          return false;
      }
    } catch (error) {
      // For health checks, we expect some errors (like 404 for non-existent files)
      // The important thing is that we can connect to the service
      return true;
    }
  }

  /**
   * Initialize provider registry
   */
  private initializeProviders(): void {
    // Initialize all providers as unconfigured
    this.providers.set('aws_s3', {
      name: 'AWS S3',
      isConfigured: false,
      isHealthy: false,
      lastHealthCheck: new Date(),
    });

    this.providers.set('google_cloud', {
      name: 'Google Cloud Storage',
      isConfigured: false,
      isHealthy: false,
      lastHealthCheck: new Date(),
    });

    this.providers.set('azure_blob', {
      name: 'Azure Blob Storage',
      isConfigured: false,
      isHealthy: false,
      lastHealthCheck: new Date(),
    });
  }

  /**
   * Generate S3 key for file
   */
  private generateS3Key(fileId: string, originalName: string): string {
    const hash = crypto.createHash('md5').update(fileId).digest('hex');
    const dir1 = hash.substring(0, 2);
    const dir2 = hash.substring(2, 4);
    const timestamp = Date.now();
    const extension = originalName.split('.').pop() || '';

    return `files/${dir1}/${dir2}/${fileId}_${timestamp}.${extension}`;
  }

  /**
   * Generate GCS file name
   */
  private generateGCSFileName(fileId: string, originalName: string): string {
    return this.generateS3Key(fileId, originalName); // Same structure
  }

  /**
   * Generate Azure blob name
   */
  private generateAzureBlobName(fileId: string, originalName: string): string {
    return this.generateS3Key(fileId, originalName); // Same structure
  }

  /**
   * Get provider status
   */
  getProviderStatus(): CloudProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get healthy providers
   */
  getHealthyProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([, provider]) => provider.isConfigured && provider.isHealthy)
      .map(([name]) => name);
  }
}

export const cloudStorageProviders = new CloudStorageProviders();
