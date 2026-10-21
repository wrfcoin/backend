import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../node_modules/drizzle-orm/index.js';
import { db } from '../database/db.js';
import * as crypto from 'crypto';
// Import the field converter utility
import {
  snakeToCamel,
  camelToSnake,
  ApplicationSubmission,
  DatabaseSubmission,
} from '../utils/fieldNameConverter.js';
import { storageLogger, logError } from './utils/logger.js';

import {
  users,
  decentralizedIdentities,
  verifiableCredentials,
  trustAnchors,
  trustEndorsements,
  reputationScores,
  reputationEvents,
  reputationRankings,
  blocks,
  transactions,
  environmentalSubmissions,
  validationAttestations,
  popRewards,
  referenceDataSources,
  computationalNfts,
  computationalTasks,
  computationalNodes,
  wallets,
  type User,
  type InsertUser,
} from '../shared/schema.js';

const { eq, desc, and, sql } = drizzleOrm as unknown as typeof drizzleOrmEsm;


/**
 * Helper to convert camelCase properties to snake_case for database operations
 */
function toDbFormat(data: Record<string, any>): Record<string, any> {
  if (!data) {
    return {};
  }

  const dbData: Record<string, any> = {};

  // Go through all properties and convert camelCase to snake_case
  for (const [key, value] of Object.entries(data)) {
    // Skip null or undefined values to avoid database errors
    if (value === null || value === undefined) {
      continue;
    }

    // Special handling for known fields
    if (key === 'nftId') {
      dbData.nft_id = value;
    } else if (key === 'taskId') {
      dbData.task_id = value;
    } else if (key === 'regionCode') {
      dbData.region_code = value;
    } else if (key === 'baseReward') {
      dbData.base_reward = value;
    } else if (key === 'resourceRequirements') {
      dbData.resource_requirements = value;
    } else if (key === 'dataMetrics') {
      dbData.data_metrics = value;
    } else if (key === 'requiresVerification') {
      dbData.requires_verification = value;
    } else if (key === 'assignedNodeId') {
      dbData.assigned_node_id = value;
    } else if (key === 'computationType') {
      dbData.computation_type = value;
    } else if (key === 'computationComplexity') {
      dbData.computation_complexity = value;
    } else if (key === 'content') {
      dbData.content_uri = value;
    } else if (key === 'createdAt') {
      dbData.created_at = value;
    } else if (key === 'updatedAt') {
      dbData.updated_at = value;
    }
    // IoT device fields
    else if (key === 'submissionId') {
      dbData.submission_id = value;
    } else if (key === 'submitterId') {
      dbData.submitter_id = value;
    } else if (key === 'dataType') {
      dbData.data_type = value;
    } else if (key === 'validationState') {
      dbData.validation_state = value;
    } else if (key === 'locationDescription') {
      dbData.location_description = value;
    } else if (key === 'submissionTimestamp') {
      dbData.submission_timestamp = value;
    } else if (key === 'deviceType') {
      dbData.device_type = value;
    } else if (key === 'deviceId') {
      dbData.device_id = value;
    } else if (key === 'sensorAccuracy') {
      dbData.sensor_accuracy = value;
    } else if (key === 'batteryLevel') {
      dbData.battery_level = value;
    } else if (key === 'signalStrength') {
      dbData.signal_strength = value;
    } else if (key === 'maintenanceStatus') {
      dbData.maintenance_status = value;
    } else if (key === 'firmwareVersion') {
      dbData.firmware_version = value;
    } else if (key === 'nodeId') {
      dbData.node_id = value;
    } else if (key === 'walletAddress') {
      dbData.wallet_address = value;
    } else if (key === 'ipAddress') {
      dbData.ip_address = value;
    } else if (key === 'verificationCount') {
      dbData.verification_count = value;
    } else if (key === 'lastActive') {
      dbData.last_active = value;
    } else if (key === 'taskType') {
      dbData.task_type = value;
    } else {
      // Default: convert camelCase to snake_case
      const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      dbData[snakeKey] = value;
    }
  }

  return dbData;
}

function toAppFormat(data: Record<string, any>): Record<string, any> {
  if (!data) {
    return {};
  }

  const appData: Record<string, any> = {};

  // Process each column from the database
  for (const [key, value] of Object.entries(data)) {
    // Special handling for known fields
    if (key === 'nft_id') {
      appData.nftId = value;
    } else if (key === 'task_id') {
      appData.taskId = value;
    } else if (key === 'region_code') {
      appData.regionCode = value;
    } else if (key === 'base_reward') {
      appData.baseReward = value;
    } else if (key === 'resource_requirements') {
      appData.resourceRequirements = value;
    } else if (key === 'data_metrics') {
      appData.dataMetrics = value;
    } else if (key === 'requires_verification') {
      appData.requiresVerification = value;
    } else if (key === 'assigned_node_id') {
      appData.assignedNodeId = value;
    } else if (key === 'computation_type') {
      appData.computationType = value;
    } else if (key === 'computation_complexity') {
      appData.computationComplexity = value;
    } else if (key === 'content_uri') {
      appData.content = value;
    } else if (key === 'created_at') {
      appData.createdAt = value;
    } else if (key === 'updated_at') {
      appData.updatedAt = value;
    } else if (key === 'node_id') {
      appData.nodeId = value;
    } else if (key === 'wallet_address') {
      appData.walletAddress = value;
    } else if (key === 'ip_address') {
      appData.ipAddress = value;
    } else if (key === 'verification_count') {
      appData.verificationCount = value;
    } else if (key === 'last_active') {
      appData.lastActive = value;
    } else if (key === 'task_type') {
      appData.taskType = value;
    }
    // IoT device fields
    else if (key === 'submission_id') {
      appData.submissionId = value;
    } else if (key === 'submitter_id') {
      appData.submitterId = value;
    } else if (key === 'data_type') {
      appData.dataType = value;
    } else if (key === 'validation_state') {
      appData.validationState = value;
    } else if (key === 'location_description') {
      appData.locationDescription = value;
    } else if (key === 'submission_timestamp') {
      appData.submissionTimestamp = value;
    } else if (key === 'device_type') {
      appData.deviceType = value;
    } else if (key === 'device_id') {
      appData.deviceId = value;
    } else if (key === 'sensor_accuracy') {
      appData.sensorAccuracy = value;
    } else if (key === 'battery_level') {
      appData.batteryLevel = value;
    } else if (key === 'signal_strength') {
      appData.signalStrength = value;
    } else if (key === 'maintenance_status') {
      appData.maintenanceStatus = value;
    } else if (key === 'firmware_version') {
      appData.firmwareVersion = value;
    } else {
      // Default: convert snake_case to camelCase
      const camelKey = key.replace(/_([a-z])/g, (match, letter) =>
        letter.toUpperCase()
      );
      appData[camelKey] = value;
    }
  }

  return appData;
}

export enum PrivacyLevel {
  STANDARD = 'STANDARD',
  ENHANCED = 'ENHANCED',
  MAXIMUM = 'MAXIMUM',
}

export interface SecurityConfig {
  mevProtection: boolean;
  privacyLevel: PrivacyLevel;
  activeProtection: boolean;
}

export interface ConsensusConfig {
  mechanism: 'ProofOfWork' | 'ProofOfUsefulAnalysis' | 'ProofOfPublishing';
  parameters: Record<string, any>;
}

// Default security config
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  mevProtection: true,
  privacyLevel: PrivacyLevel.STANDARD,
  activeProtection: true,
};

// Interface for storage operations
export interface IStorage {
  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(insertUser: InsertUser): Promise<User>;

  // Identity operations
  getIdentityByDid(did: string): Promise<any | undefined>;
  getAllIdentities(limit?: number, offset?: number): Promise<any[]>;
  createIdentity(identity: any): Promise<any>;
  updateIdentity(did: string, updateData: any): Promise<any>;
  getIdentitiesByType(type: string): Promise<any[]>;
  getIdentitiesByVerificationLevel(level: string): Promise<any[]>;

  // Verifiable Credential operations
  getCredentialById(id: number): Promise<any | undefined>;
  getCredentialsBySubject(subjectDid: string): Promise<any[]>;
  getCredentialsByIssuer(issuerDid: string): Promise<any[]>;
  createCredential(credential: any): Promise<any>;
  updateCredentialStatus(id: number, status: string): Promise<any>;
  verifyCredential(credential: any): Promise<boolean>;

  // Trust Anchor operations
  getTrustAnchorById(id: number): Promise<any | undefined>;
  getTrustAnchorByDid(did: string): Promise<any | undefined>;
  createTrustAnchor(anchor: any): Promise<any>;
  updateTrustAnchor(id: number, updates: any): Promise<any>;
  getTrustAnchorsByType(type: string): Promise<any[]>;

  // Reputation operations
  getReputationById(id: number): Promise<any | undefined>;
  getReputationScoreByIdentity(identityDid: string): Promise<number>;
  getReputationEventsByIdentity(
    identityDid: string,
    factor?: string,
    limit?: number,
    offset?: number
  ): Promise<any[]>;
  createReputationScore(scoreData: any): Promise<any>;
  updateReputationScore(id: number, scoreData: any): Promise<any>;
  recordReputationEvent(eventData: any): Promise<any>;
  refreshReputationScoreForIdentity(identityDid: string): Promise<void>;
  getAllReputationScores(limit?: number, offset?: number): Promise<any[]>;
  calculateFactorScores(identityDid: string): Promise<Record<string, number>>;
  calculateConfidenceLevel(totalEvents: number): number;
  getReputationFactorsByIdentity(identityDid: string): Promise<any[]>;
  calculateAggregateReputation(identityDid: string): Promise<number>;

  // Proof of Publishing operations
  submitEnvironmentalData(data: any): Promise<any>;
  getSubmissionById(submissionId: string): Promise<any | undefined>;
  getRecentSubmissions(limit?: number, dataType?: string): Promise<any[]>;
  submitAttestation(attestation: any): Promise<any>;
  getAttestationsForSubmission(submissionId: string): Promise<any[]>;
  validateSubmission(submissionId: string): Promise<boolean>;
  createPopReward(rewardData: any): Promise<any>;
  getRewardsForSubmission(submissionId: string): Promise<any[]>;

  // Reference data operations
  getReferenceDataSourceById(id: number): Promise<any | undefined>;
  createReferenceDataSource(source: any): Promise<any>;
  updateReferenceDataSource(id: number, updates: any): Promise<any>;
  getActiveReferenceDataSources(): Promise<any[]>;

  // Computational NFT operations
  getAllComputationalNFTs(limit?: number, page?: number): Promise<any[]>;
  getComputationalNFTById(id: number): Promise<any | null>;
  createComputationalNFT(nft: any): Promise<any>;
  updateComputationalNFT(id: number, updates: any): Promise<any | null>;
  getNFTsByRegion(regionCode: string): Promise<any[]>;

  // Computational Task operations
  getAllComputationalTasks(limit?: number, page?: number): Promise<any[]>;
  getComputationalTaskById(id: number): Promise<any | null>;
  getComputationalTaskByTaskId(taskId: string): Promise<any | null>;
  getComputationalTasksByNFTId(nftId: number): Promise<any[]>;
  createComputationalTask(task: any): Promise<any>;
  updateComputationalTask(taskId: string, updates: any): Promise<any | null>;

  // Computational Node operations
  getOptimalNodeForNFT(nftId: number): Promise<any | null>;

  // GraphQL resolver methods
  getTransactionsByBlockHash(blockHash: string): Promise<any[]>;
  getBlockByHash(blockHash: string): Promise<any | undefined>;
  getBlockByHeight(height: number): Promise<any | undefined>;
  getLatestBlocks(limit?: number): Promise<any[]>;
  getWalletByUserId(userId: number): Promise<any | undefined>;
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  // Proof of Publishing operations
  async submitEnvironmentalData(data: any): Promise<any> {
    try {
      storageLogger.debug('Processing environmental data submission from IoT device', {
        dataType: data.dataType,
        submitterId: data.submitterId || data.submitter,
        deviceType: data.deviceType || 'UNKNOWN',
        measurementCount: data.measurements
          ? typeof data.measurements === 'object'
            ? Object.keys(data.measurements).length
            : Array.isArray(data.measurements)
              ? data.measurements.length
              : 0
          : 0,
      });

      // Generate a unique submission ID if not provided
      const submissionId =
        data.submissionId || `pop-${crypto.randomUUID().substring(0, 8)}`;

      // Convert location to separate latitude and longitude fields
      const location = data.location || {
        latitude: data.latitude || 0,
        longitude: data.longitude || 0,
      };

      // Process metadata to include device information
      const metadata = {
        ...(data.metadata || {}),
        deviceType: data.deviceType || 'UNKNOWN',
        deviceModel: data.deviceModel,
        deviceFirmware: data.deviceFirmware || data.firmwareVersion,
        deviceId: data.deviceId,
        calibrationDate: data.calibrationDate,
        sensorAccuracy: data.sensorAccuracy,
        batteryLevel: data.batteryLevel,
        signalStrength: data.signalStrength,
        iotProtocol: data.iotProtocol || 'MQTT',
      };

      // Create submission hash from data for verification
      const submissionContent = JSON.stringify({
        submitterId: data.submitterId || data.submitter,
        dataType: data.dataType,
        location: location,
        measurements: data.measurements,
        timestamp: data.timestamp || new Date(),
        deviceId: data.deviceId,
      });

      // Use proper hashing for verification
      const submissionHash = crypto
        .createHash('sha256')
        .update(submissionContent)
        .digest('hex');

      // Use camelCase property names that match the schema exactly as defined in our database
      const submission = {
        submissionId: submissionId,
        // Only use submitterId from input, don't use submitter field
        submitterId:
          data.submitterId || `user-${crypto.randomUUID().substring(0, 8)}`,
        dataType: data.dataType,
        validationState: 'PENDING',
        latitude: location.latitude || data.latitude || 0,
        longitude: location.longitude || data.longitude || 0,
        elevation: location.elevation || data.elevation,
        locationDescription: location.description || data.locationDescription,
        measurements: data.measurements || {},
        metadata: metadata, // Enhanced metadata with device information
        submissionTimestamp: data.submissionTimestamp || new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        submissionHash,
        regionCode: data.regionCode,
        visibility: data.visibility || 'PUBLIC',
        deviceType: data.deviceType || 'UNKNOWN',
        deviceId:
          data.deviceId || `device-${crypto.randomUUID().substring(0, 8)}`,
        sensorAccuracy: data.sensorAccuracy || 0.9, // Default sensor accuracy of 90%
        calibrationDate: data.calibrationDate || null,
        maintenanceStatus: data.maintenanceStatus || 'UNKNOWN',
        firmwareVersion: data.deviceFirmware || data.firmwareVersion || '',
        batteryLevel: data.batteryLevel || 100,
        signalStrength: data.signalStrength || 5,
      };

      storageLogger.debug('Before submission preparation', {
        submissionId: submissionId,
        dataType: data.dataType,
        deviceType: data.deviceType,
        deviceId: data.deviceId,
        sensorAccuracy: data.sensorAccuracy,
      });

      storageLogger.debug('Converting submission to DB format', {
        submissionId: submission.submissionId,
        deviceType: submission.deviceType,
        deviceId: submission.deviceId,
        dataType: submission.dataType,
        sensorAccuracy: submission.sensorAccuracy,
        batteryLevel: submission.batteryLevel,
        signalStrength: submission.signalStrength,
      });

      // Convert submission to snake_case for database using our utility
      // This should convert camelCase property names (e.g., submissionId) to snake_case column names (e.g., submission_id)
      const dbSubmission = camelToSnake<DatabaseSubmission>(submission);

      storageLogger.debug('Submission field conversion check', {
        submissionId: { camel: submission.submissionId, snake: dbSubmission.submission_id },
        deviceType: { camel: submission.deviceType, snake: dbSubmission.device_type },
        dataType: { camel: submission.dataType, snake: dbSubmission.data_type },
        sensorAccuracy: { camel: submission.sensorAccuracy, snake: dbSubmission.sensor_accuracy },
      });

      // Insert into database
      try {
        // Try with returning first
        const result = await db
          .insert(environmentalSubmissions)
          .values(dbSubmission as any)
          .returning();

        // Convert from snake_case DB column names to camelCase property names
        if (result && result.length > 0) {
          const returnValue = snakeToCamel<ApplicationSubmission>(result[0]);
          storageLogger.debug('Converted result from DB (successful insertion)', {
            submissionId: returnValue.submissionId,
            deviceType: returnValue.deviceType,
            deviceId: returnValue.deviceId,
            dataType: returnValue.dataType,
            sensorAccuracy: returnValue.sensorAccuracy,
            batteryLevel: returnValue.batteryLevel,
            signalStrength: returnValue.signalStrength,
          });
          return returnValue;
        }
      } catch (error) {
        logError(storageLogger, 'Error inserting environmental submission with RETURNING', error as Error);

        // Fall back to insert without returning
        try {
          await db.insert(environmentalSubmissions).values(dbSubmission as any);

          // Try to fetch the inserted record by submission ID
          const [dbResult] = await db
            .select()
            .from(environmentalSubmissions)
            .where(
              eq(environmentalSubmissions.submissionId, submission.submissionId)
            )
            .limit(1);

          if (dbResult) {
            // Convert from snake_case DB column names to camelCase property names
            const returnValue = snakeToCamel<ApplicationSubmission>(dbResult);
            storageLogger.debug('Retrieved and converted result (fallback method)', {
              submissionId: returnValue.submissionId,
              deviceType: returnValue.deviceType,
              deviceId: returnValue.deviceId,
              dataType: returnValue.dataType,
              sensorAccuracy: returnValue.sensorAccuracy,
              batteryLevel: returnValue.batteryLevel,
              signalStrength: returnValue.signalStrength,
            });
            return returnValue;
          }
        } catch (fallbackError) {
          logError(storageLogger, 'Error in fallback insertion method', fallbackError as Error);
          throw fallbackError;
        }
      }

      // When database insertion failed or returned no results, use the original submission data
      // But make sure we return it with camelCase property names
      const result = {
        submissionId: submission.submissionId,
        dataType: submission.dataType,
        submitterId: submission.submitterId,
        deviceType: submission.deviceType,
        deviceId: submission.deviceId,
        sensorAccuracy: submission.sensorAccuracy,
        batteryLevel: submission.batteryLevel,
        signalStrength: submission.signalStrength,
        maintenanceStatus: submission.maintenanceStatus,
        firmwareVersion: submission.firmwareVersion,
        measurements: submission.measurements,
        latitude: submission.latitude,
        longitude: submission.longitude,
        elevation: submission.elevation,
        locationDescription: submission.locationDescription,
        validationState: submission.validationState,
        visibility: submission.visibility,
        submissionTimestamp: submission.submissionTimestamp,
        metadata: submission.metadata,
      };

      storageLogger.info('Created new submission from IoT device', {
        submissionId: submission.submissionId,
        dataType: submission.dataType,
        submitterId: submission.submitterId,
        deviceType: submission.deviceType,
        deviceId: submission.deviceId,
        sensorAccuracy: submission.sensorAccuracy,
        measurementCount:
          typeof submission.measurements === 'object'
            ? Object.keys(submission.measurements).length
            : Array.isArray(submission.measurements)
              ? submission.measurements.length
              : 0,
        batteryLevel: submission.batteryLevel,
        signalStrength: submission.signalStrength,
      });

      return result;
    } catch (error) {
      logError(storageLogger, 'Error submitting environmental data', error as Error);
      throw error;
    }
  }

  async getSubmissionById(submissionId: string): Promise<any | undefined> {
    try {
      if (!submissionId) {
        storageLogger.warn('getSubmissionById called with invalid submissionId', { submissionId });
        return undefined;
      }

      storageLogger.debug('Getting submission by ID', { submissionId });

      const [submission] = await db
        .select()
        .from(environmentalSubmissions)
        .where(eq(environmentalSubmissions.submissionId, submissionId));

      if (!submission) {
        storageLogger.warn('No submission found with ID', { submissionId });
        return undefined;
      }

      // Access fields with column names as defined in the database
      storageLogger.debug('Retrieved submission from DB', {
        submissionId: submission.submissionId,
        dataType: submission.dataType,
        deviceType: submission.deviceType,
        deviceId: submission.deviceId,
        sensorAccuracy: submission.sensorAccuracy,
      });

      // Convert from snake_case DB column names to camelCase property names
      const convertedSubmission =
        snakeToCamel<ApplicationSubmission>(submission);

      storageLogger.debug('Converted submission to camelCase', {
        submissionId: convertedSubmission.submissionId,
        dataType: convertedSubmission.dataType,
        deviceType: convertedSubmission.deviceType,
        deviceId: convertedSubmission.deviceId,
        sensorAccuracy: convertedSubmission.sensorAccuracy,
      });

      return convertedSubmission;
    } catch (error) {
      logError(storageLogger, 'Error getting submission by ID', error as Error);
      return undefined;
    }
  }

  async getRecentSubmissions(
    limit: number = 50,
    dataType?: string
  ): Promise<any[]> {
    try {
      // Properly reference the column names using environmentalSubmissions schema
      const query = db
        .select()
        .from(environmentalSubmissions)
        .orderBy(desc(environmentalSubmissions.submissionTimestamp));

      let submissions;
      if (dataType) {
        submissions = await query
          .where(eq(environmentalSubmissions.dataType, dataType as any))
          .limit(limit);
      } else {
        submissions = await query.limit(limit);
      }

      storageLogger.debug('Retrieved recent submissions from DB', {
        count: submissions.length,
        firstSubmissionId: submissions.length > 0 ? submissions[0].submission_id : 'none',
      });

      // Convert submissions with consistent field naming using the utility function
      const convertedSubmissions = submissions.map((dbSubmission: any) =>
        snakeToCamel(dbSubmission)
      );

      storageLogger.debug('Converted recent submissions to camelCase', {
        count: convertedSubmissions.length,
        firstSubmissionId: convertedSubmissions.length > 0 ? convertedSubmissions[0].submissionId : 'none',
      });

      return convertedSubmissions;
    } catch (error) {
      logError(storageLogger, 'Error getting recent submissions', error as Error);
      return [];
    }
  }

  async submitAttestation(attestation: any): Promise<any> {
    try {
      // Generate a unique attestation ID if not provided
      const attestationId =
        attestation.attestationId ||
        `att-${crypto.randomUUID().substring(0, 8)}`;

      // Prepare attestation data for database
      const dbAttestation = {
        submissionId: attestation.submissionId,
        validatorDid: attestation.validatorId || 'unknown',
        validationType: attestation.attestationMethod || 'manual',
        isValid:
          attestation.validationResult === 'valid' ||
          Boolean(attestation.validationResult),
        confidence: attestation.confidenceScore || 50,
        validatedAt: new Date(),
        proof: attestation.signature
          ? {
              signature: attestation.signature,
              publicKey: attestation.publicKey,
            }
          : null,
        metadata: attestation.metadata || {},
      };

      // Insert attestation
      const [newAttestation] = await db
        .insert(validationAttestations)
        .values(dbAttestation)
        .returning();

      storageLogger.info('Added validation for submission', {
        attestationId: newAttestation.id,
        submissionId: newAttestation.submissionId,
        isValid: newAttestation.isValid,
        confidence: newAttestation.confidence,
        validationType: newAttestation.validationType,
      });

      // Update submission validation count
      await this.updateSubmissionValidationCount(attestation.submissionId);

      return toAppFormat(newAttestation);
    } catch (error) {
      logError(storageLogger, 'Error submitting attestation', error as Error);
      throw error;
    }
  }

  async getAttestationsForSubmission(submissionId: string): Promise<any[]> {
    try {
      const attestations = await db
        .select()
        .from(validationAttestations)
        .where(eq(validationAttestations.submissionId, submissionId))
        .orderBy(desc(validationAttestations.validatedAt));

      return attestations.map(attestation => toAppFormat(attestation));
    } catch (error) {
      logError(storageLogger, 'Error getting attestations for submission', error as Error);
      return [];
    }
  }

  async validateSubmission(submissionId: string): Promise<boolean> {
    try {
      const attestations =
        await this.getAttestationsForSubmission(submissionId);

      if (attestations.length === 0) return false;

      // Calculate validation metrics
      const validCount = attestations.filter(a => a.validationResult).length;
      const totalCount = attestations.length;
      const validRatio = validCount / totalCount;

      // Submission is valid if at least 2/3 of attestations are positive
      const isValid = validRatio >= 0.66;

      // Update submission status
      await this.updateSubmissionValidationStatus(
        submissionId,
        isValid ? 'VALIDATED' : 'REJECTED',
        isValid,
        validCount,
        totalCount
      );

      return isValid;
    } catch (error) {
      logError(storageLogger, 'Error validating submission', error as Error);
      return false;
    }
  }

  // Helper method to update submission validation count
  private async updateSubmissionValidationCount(
    submissionId: string
  ): Promise<void> {
    try {
      const attestations =
        await this.getAttestationsForSubmission(submissionId);
      const validCount = attestations.filter(a => a.validationResult).length;

      await db
        .update(environmentalSubmissions)
        .set({
          validationState: validCount > 0 ? 'validated' : 'pending',
          metadata: sql`jsonb_set(metadata, '{validationCount}', ${attestations.length}::text::jsonb)`,
        })
        .where(eq(environmentalSubmissions.submissionId, submissionId));
    } catch (error) {
      logError(storageLogger, 'Error updating submission validation count', error as Error);
    }
  }

  // Helper method to update submission validation status
  private async updateSubmissionValidationStatus(
    submissionId: string,
    validationState: string,
    isValid: boolean,
    validCount: number,
    totalCount: number
  ): Promise<void> {
    try {
      await db
        .update(environmentalSubmissions)
        .set({
          validationState: validationState,
          metadata: sql`jsonb_set(jsonb_set(metadata, '{isValid}', ${isValid}::text::jsonb), '{validationCount}', ${totalCount}::text::jsonb)`,
        })
        .where(eq(environmentalSubmissions.submissionId, submissionId));
    } catch (error) {
      logError(storageLogger, 'Error updating submission validation status', error as Error);
    }
  }

  // New method to create rewards for validated submissions
  async createPopReward(rewardData: any): Promise<any> {
    try {
      // Generate a unique reward ID if not provided
      const rewardId =
        rewardData.rewardId || `reward-${crypto.randomUUID().substring(0, 8)}`;

      // Prepare reward data for database
      const dbReward = {
        submissionId: rewardData.submissionId,
        recipientDid:
          rewardData.recipientId || rewardData.recipientDid || 'unknown',
        rewardType: rewardData.type || rewardData.rewardType || 'submission',
        amount: rewardData.amount.toString(),
        reason: rewardData.reason || 'PoP reward',
        distributedAt: new Date(),
        transactionId: rewardData.transactionId,
      };

      // Insert reward
      const [newReward] = await db
        .insert(popRewards)
        .values(dbReward)
        .returning();

      storageLogger.info('Created PoP reward', {
        rewardId: newReward.id,
        submissionId: newReward.submissionId,
        recipientDid: newReward.recipientDid,
        amount: newReward.amount,
        rewardType: newReward.rewardType,
      });

      return toAppFormat(newReward);
    } catch (error) {
      logError(storageLogger, 'Error creating PoP reward', error as Error);
      throw error;
    }
  }

  // New method to get rewards for a submission
  async getRewardsForSubmission(submissionId: string): Promise<any[]> {
    try {
      const rewards = await db
        .select()
        .from(popRewards)
        .where(eq(popRewards.submissionId, submissionId))
        .orderBy(desc(popRewards.distributedAt));

      return rewards.map(reward => toAppFormat(reward));
    } catch (error) {
      logError(storageLogger, 'Error getting rewards for submission', error as Error);
      return [];
    }
  }

  // Identity operations
  async getIdentityByDid(did: string): Promise<any | undefined> {
    const [identity] = await db
      .select()
      .from(decentralizedIdentities)
      .where(eq(decentralizedIdentities.did, did));
    return identity || undefined;
  }

  // Legacy alias for backward compatibility
  async getDecentralizedIdentityByDid(did: string): Promise<any> {
    return this.getIdentityByDid(did);
  }

  async getAllIdentities(limit = 100, offset = 0): Promise<any[]> {
    return await db.select().from(decentralizedIdentities).limit(limit).offset(offset);
  }

  // Legacy alias for backward compatibility
  async getAllDecentralizedIdentities(): Promise<any[]> {
    return this.getAllIdentities();
  }

  async createIdentity(identity: any): Promise<any> {
    const [newIdentity] = await db
      .insert(decentralizedIdentities)
      .values(identity)
      .returning();
    return newIdentity;
  }

  // Legacy alias for backward compatibility
  async createDecentralizedIdentity(identityData: any): Promise<any> {
    return this.createIdentity(identityData);
  }

  async updateIdentity(did: string, updates: any): Promise<any> {
    const [updatedIdentity] = await db
      .update(decentralizedIdentities)
      .set(updates)
      .where(eq(decentralizedIdentities.did, did))
      .returning();
    return updatedIdentity;
  }

  // Legacy alias for backward compatibility
  async updateDecentralizedIdentity(
    did: string,
    updateData: any
  ): Promise<any> {
    return this.updateIdentity(did, updateData);
  }

  async getIdentitiesByType(type: string): Promise<any[]> {
    return await db
      .select()
      .from(decentralizedIdentities)
      .where(sql`${decentralizedIdentities.identityType}::text = ${type}`);
  }

  async getIdentitiesByVerificationLevel(level: string): Promise<any[]> {
    return await db
      .select()
      .from(decentralizedIdentities)
      .where(
        sql`${decentralizedIdentities.verificationLevel}::text = ${level}`
      );
  }

  // Verifiable Credential operations
  async getCredentialById(id: number): Promise<any | undefined> {
    const [credential] = await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.id, id));
    return credential || undefined;
  }

  async getVerifiableCredentialById(credentialId: string): Promise<any> {
    const [credential] = await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.credentialId, credentialId));
    return credential || undefined;
  }

  async getCredentialsBySubject(subjectDid: string): Promise<any[]> {
    return await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.subjectDid, subjectDid));
  }

  async getCredentialsByIssuer(issuerDid: string): Promise<any[]> {
    return await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.issuerDid, issuerDid));
  }

  async createCredential(credential: any): Promise<any> {
    const [newCredential] = await db
      .insert(verifiableCredentials)
      .values(credential)
      .returning();
    return newCredential;
  }

  async createVerifiableCredential(credentialData: any): Promise<any> {
    return this.createCredential(credentialData);
  }

  async updateCredentialStatus(
    id: number,
    status: 'ACTIVE' | 'REVOKED' | 'SUSPENDED' | 'EXPIRED'
  ): Promise<any> {
    const [updatedCredential] = await db
      .update(verifiableCredentials)
      .set({ status })
      .where(eq(verifiableCredentials.id, id))
      .returning();
    return updatedCredential;
  }

  async updateVerifiableCredential(
    credentialId: string,
    updateData: any
  ): Promise<any> {
    const [updatedCredential] = await db
      .update(verifiableCredentials)
      .set(updateData)
      .where(eq(verifiableCredentials.credentialId, credentialId))
      .returning();
    return updatedCredential;
  }

  async verifyCredential(credential: any): Promise<boolean> {
    // Implement actual credential verification logic here
    return true;
  }

  // Trust Anchor operations
  async getTrustAnchorById(id: number): Promise<any | undefined> {
    const [anchor] = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.id, id));
    return anchor || undefined;
  }

  async getTrustAnchorByDid(did: string): Promise<any | undefined> {
    const [anchor] = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.anchorDid, did));
    return anchor || undefined;
  }

  async createTrustAnchor(anchor: any): Promise<any> {
    const [newAnchor] = await db
      .insert(trustAnchors)
      .values(anchor)
      .returning();
    return newAnchor;
  }

  async updateTrustAnchor(id: number, updates: any): Promise<any> {
    const [updatedAnchor] = await db
      .update(trustAnchors)
      .set(updates)
      .where(eq(trustAnchors.id, id))
      .returning();
    return updatedAnchor;
  }

  async getTrustAnchorsByType(type: string): Promise<any[]> {
    return await db
      .select()
      .from(trustAnchors)
      .where(sql`${trustAnchors.anchorType}::text = ${type}`);
  }

  // Reputation operations
  async getReputationById(id: number): Promise<any | undefined> {
    const [score] = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.id, id));
    return score || undefined;
  }

  async getReputationScoreByIdentity(identityDid: string): Promise<number> {
    const [score] = await db
      .select({
        overallScore: reputationScores.overallScore,
      })
      .from(reputationScores)
      .where(eq(reputationScores.identityDid, identityDid));

    return score?.overallScore || 0;
  }

  async getReputationEventsByIdentity(
    identityDid: string,
    factor?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<any[]> {
    if (factor) {
      return await db
        .select()
        .from(reputationEvents)
        .where(
          and(
            eq(reputationEvents.identityDid, identityDid),
            sql`${reputationEvents.factor} = ${factor}`
          )
        )
        .orderBy(desc(reputationEvents.createdAt))
        .limit(limit)
        .offset(offset);
    }

    return await db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid))
      .orderBy(desc(reputationEvents.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async createReputationScore(scoreData: any): Promise<any> {
    const [score] = await db
      .insert(reputationScores)
      .values(scoreData)
      .returning();
    return score;
  }

  async updateReputationScore(id: number, scoreData: any): Promise<any> {
    const [updatedScore] = await db
      .update(reputationScores)
      .set(scoreData)
      .where(eq(reputationScores.id, id))
      .returning();
    return updatedScore;
  }

  async recordReputationEvent(eventData: any): Promise<any> {
    const [event] = await db
      .insert(reputationEvents)
      .values(eventData)
      .returning();

    // Update the aggregate score after recording an event
    await this.refreshReputationScoreForIdentity(eventData.identityDid);

    return event;
  }

  async refreshReputationScoreForIdentity(identityDid: string): Promise<void> {
    const aggregateScore = await this.calculateAggregateReputation(identityDid);

    // Get event counts
    const eventsCount = await db
      .select({ count: sql`count(*)` })
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid));

    // Use type assertion to handle the SQL count result
    const totalEvents =
      eventsCount[0] && eventsCount[0].count ? Number(eventsCount[0].count) : 0;

    // Check if a score exists
    const [existingScore] = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.identityDid, identityDid));

    // Calculate scores by factor
    const factorScores = await this.calculateFactorScores(identityDid);

    if (existingScore) {
      await db
        .update(reputationScores)
        .set({
          overallScore: aggregateScore,
          lastUpdated: new Date(),
          totalEvents,
          dataQuality: factorScores.dataSubmissionScore || 0,
          reliability: factorScores.blockValidationScore || 0,
          verification: factorScores.transactionValidationScore || 0,
          contributionValue: factorScores.computationalScore || 0,
          participationLevel: factorScores.governanceScore || 0,
          confidenceLevel:
            this.calculateConfidenceLevel(totalEvents) > 0.5
              ? 'high'
              : 'medium',
          metadata: {
            proximityScore: factorScores.proximityScore || 0,
            peerEndorsementScore: factorScores.peerEndorsementScore || 0,
            factorScores,
          },
        })
        .where(eq(reputationScores.id, existingScore.id));
    } else {
      // Create a new reputation score entry
      await db.insert(reputationScores).values({
        identityDid,
        lastUpdated: new Date(),
        overallScore: aggregateScore,
        dataQuality: factorScores.dataSubmissionScore || 0,
        reliability: factorScores.blockValidationScore || 0,
        verification: factorScores.transactionValidationScore || 0,
        contributionValue: factorScores.computationalScore || 0,
        participationLevel: factorScores.governanceScore || 0,
        totalEvents,
        confidenceLevel:
          this.calculateConfidenceLevel(totalEvents) > 0.5 ? 'high' : 'medium',
        metadata: {
          proximityScore: factorScores.proximityScore || 0,
          peerEndorsementScore: factorScores.peerEndorsementScore || 0,
          factorScores,
        },
      });
    }
  }

  async getAllReputationScores(limit = 100, offset = 0): Promise<any[]> {
    return await db.select().from(reputationScores).limit(limit).offset(offset);
  }

  /**
   * Calculate scores for each reputation factor
   */
  async calculateFactorScores(
    identityDid: string
  ): Promise<Record<string, number>> {
    // Get all events grouped by factor with their average impact scores
    const results = await db
      .select({
        factor: reputationEvents.factor,
        avgScore: sql`AVG(${reputationEvents.impact})`,
        count: sql`COUNT(*)`,
      })
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid))
      .groupBy(({ factor }) => factor);

    // Initialize with defaults
    const factorScores: Record<string, number> = {
      blockValidationScore: 0,
      transactionValidationScore: 0,
      dataSubmissionScore: 0,
      governanceScore: 0,
      computationalScore: 0,
      proximityScore: 0,
      peerEndorsementScore: 0,
    };

    // Map the DB results to our factor scores
    for (const result of results) {
      // Ensure avgScore is treated as a number
      const avgScore =
        typeof result.avgScore === 'number'
          ? result.avgScore
          : typeof result.avgScore === 'string'
            ? parseFloat(result.avgScore)
            : result.avgScore && typeof result.avgScore.toString === 'function'
              ? parseFloat(result.avgScore.toString())
              : 0;

      if (result.factor === 'BLOCK_VALIDATION') {
        factorScores.blockValidationScore = avgScore;
      } else if (result.factor === 'TRANSACTION_VALIDATION') {
        factorScores.transactionValidationScore = avgScore;
      } else if (result.factor === 'DATA_SUBMISSION') {
        factorScores.dataSubmissionScore = avgScore;
      } else if (result.factor === 'GOVERNANCE') {
        factorScores.governanceScore = avgScore;
      } else if (result.factor === 'COMPUTATIONAL') {
        factorScores.computationalScore = avgScore;
      } else if (result.factor === 'PROXIMITY') {
        factorScores.proximityScore = avgScore;
      } else if (result.factor === 'PEER_ENDORSEMENT') {
        factorScores.peerEndorsementScore = avgScore;
      }
    }

    return factorScores;
  }

  /**
   * Calculate the confidence level based on the number of events
   */
  calculateConfidenceLevel(totalEvents: number): number {
    // Simple confidence model: starts at 0.1 and approaches 1.0 asymptotically
    return Math.min(1.0, 0.1 + totalEvents / (totalEvents + 10));
  }

  async getReputationFactorsByIdentity(identityDid: string): Promise<any[]> {
    try {
      const [score] = await db
        .select()
        .from(reputationScores)
        .where(eq(reputationScores.identityDid, identityDid));

      if (!score) return [];

      // Use the actual schema fields and metadata for additional scores
      const metadata = (score.metadata as any) || {};
      return [
        { factor: 'BLOCK_VALIDATION', score: score.reliability },
        { factor: 'TRANSACTION_VALIDATION', score: score.verification },
        { factor: 'DATA_SUBMISSION', score: score.dataQuality },
        { factor: 'GOVERNANCE', score: score.participationLevel },
        { factor: 'COMPUTATIONAL', score: score.contributionValue },
        { factor: 'PROXIMITY', score: metadata.proximityScore || 0 },
        {
          factor: 'PEER_ENDORSEMENT',
          score: metadata.peerEndorsementScore || 0,
        },
      ];
    } catch (error) {
      logError(storageLogger, 'Error retrieving reputation factors', error as Error);
      return [];
    }
  }

  async calculateAggregateReputation(identityDid: string): Promise<number> {
    // Get the existing score
    const [score] = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.identityDid, identityDid));

    if (!score) return 0;

    // Calculate based on weighted factors using actual schema fields
    const weights = {
      BLOCK_VALIDATION: 0.15,
      TRANSACTION_VALIDATION: 0.15,
      DATA_SUBMISSION: 0.2,
      GOVERNANCE: 0.1,
      COMPUTATIONAL: 0.2,
      PROXIMITY: 0.1,
      PEER_ENDORSEMENT: 0.1,
    };

    const metadata = (score.metadata as any) || {};

    let aggregateScore =
      score.reliability * weights.BLOCK_VALIDATION +
      score.verification * weights.TRANSACTION_VALIDATION +
      score.dataQuality * weights.DATA_SUBMISSION +
      score.participationLevel * weights.GOVERNANCE +
      score.contributionValue * weights.COMPUTATIONAL +
      (metadata.proximityScore || 0) * weights.PROXIMITY +
      (metadata.peerEndorsementScore || 0) * weights.PEER_ENDORSEMENT;

    // Ensure score is between 0 and 100
    aggregateScore = Math.max(0, Math.min(100, aggregateScore));

    return aggregateScore;
  }

  // These declarations will be implemented in DatabaseStorage class

  // Reference data operations
  async getReferenceDataSourceById(id: number): Promise<any | undefined> {
    const [source] = await db
      .select()
      .from(referenceDataSources)
      .where(eq(referenceDataSources.id, id));
    return source || undefined;
  }

  async createReferenceDataSource(source: any): Promise<any> {
    const [newSource] = await db
      .insert(referenceDataSources)
      .values(source)
      .returning();
    return newSource;
  }

  async updateReferenceDataSource(id: number, updates: any): Promise<any> {
    const [updatedSource] = await db
      .update(referenceDataSources)
      .set(updates)
      .where(eq(referenceDataSources.id, id))
      .returning();
    return updatedSource;
  }

  async getActiveReferenceDataSources(): Promise<any[]> {
    return db
      .select()
      .from(referenceDataSources)
      .where(eq(referenceDataSources.isActive, true))
      .orderBy(desc(referenceDataSources.trustLevel));
  }

  // Computational NFT methods
  async getAllComputationalNFTs(limit = 100, page = 1): Promise<any[]> {
    try {
      const offset = (page - 1) * limit;

      // Map returned database fields to match expected interface
      const dbNfts = await db
        .select()
        .from(computationalNfts)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(computationalNfts.createdAt));

      // Transform database column names to camelCase field names expected by the application
      const nfts = dbNfts.map(nft => toAppFormat(nft));

      return nfts;
    } catch (error) {
      logError(storageLogger, 'Error getting computational NFTs', error as Error);
      return [];
    }
  }

  async getComputationalNFTById(id: number): Promise<any | null> {
    try {
      // Try to get the NFT directly
      const [nft] = await db
        .select()
        .from(computationalNfts)
        .where(eq(computationalNfts.id, id));

      if (!nft) {
        return null;
      }

      // Transform database column names to camelCase field names expected by the application
      return toAppFormat(nft);
    } catch (error) {
      logError(storageLogger, 'Error getting computational NFT by ID', error as Error);
      return null;
    }
  }

  async createComputationalNFT(nft: any): Promise<any> {
    try {
      // Ensure required fields have default values
      const nftWithDefaults = {
        ...nft,
        nftId: nft.nftId || `nft-${Date.now()}`,
        name: nft.name || 'Unnamed NFT',
        description: nft.description || '',
        creator: nft.creator || 'unknown',
        computationType: nft.computationType || 'GENERIC',
        computationComplexity: nft.computationComplexity || 1,
        content: nft.content || '',
        region: nft.region || '',
        resourceRequirements: nft.resourceRequirements || {},
        parameters: nft.parameters || {},
        metadata: nft.metadata || {},
        createdAt: nft.createdAt || new Date(),
        updatedAt: nft.updatedAt || new Date(),
      };

      // Map application fields to database schema using our helper
      const dbNft = toDbFormat(nftWithDefaults);

      // Insert into database with proper type casting
      const [insertedNft] = await db
        .insert(computationalNfts)
        .values(dbNft as any)
        .returning();

      // Return the inserted NFT in the application's expected format
      return toAppFormat(insertedNft);
    } catch (error) {
      logError(storageLogger, 'Error creating computational NFT', error as Error);
      throw error;
    }
  }

  async updateComputationalNFT(
    id: number | string,
    updates: any
  ): Promise<any | null> {
    try {
      // First check what columns are actually in the table
      const columnsResult = await db.execute(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'computational_nfts'
        ORDER BY ordinal_position
      `);

      const tableColumns = new Set(
        columnsResult.map((r: any) => r.column_name)
      );
      const updateData = toDbFormat(updates);

      // Filter out columns that don't exist in the table
      const filteredUpdates: Record<string, any> = {};
      for (const [key, value] of Object.entries(updateData)) {
        if (tableColumns.has(key)) {
          filteredUpdates[key] = value;
        }
      }

      // If no valid columns to update, return early
      if (Object.keys(filteredUpdates).length === 0) {
        storageLogger.warn('No valid columns to update for computational NFT');
        return null;
      }

      // Build the SET clause with direct string values instead of parameters
      const setClauses: string[] = [];

      for (const [key, value] of Object.entries(filteredUpdates)) {
        if (value === null) {
          setClauses.push(`${key} = NULL`);
        } else if (typeof value === 'string') {
          setClauses.push(`${key} = '${value.replace(/'/g, "''")}'`);
        } else if (typeof value === 'object') {
          setClauses.push(
            `${key} = '${JSON.stringify(value).replace(/'/g, "''")}'`
          );
        } else {
          setClauses.push(`${key} = ${value}`);
        }
      }

      // Add updated_at timestamp
      setClauses.push('updated_at = CURRENT_TIMESTAMP');

      // Direct SQL query with values embedded
      const query = `
        UPDATE computational_nfts 
        SET ${setClauses.join(', ')}
        WHERE id = ${parseInt(id.toString(), 10) || 0}
        RETURNING *
      `;

      storageLogger.debug('Executing NFT update query', { queryPreview: query.substring(0, 200) });
      const result = await db.execute(query);

      if (result.length === 0) {
        storageLogger.debug('No NFT found to update', { id });
        return null;
      }

      return toAppFormat(result[0]);
    } catch (error) {
      logError(storageLogger, 'Error updating computational NFT', error as Error);
      return null;
    }
  }

  async getNFTsByRegion(regionCode: string): Promise<any[]> {
    try {
      // Query the database using the region column
      const dbNfts = await db
        .select()
        .from(computationalNfts)
        .where(eq(computationalNfts.region, regionCode))
        .orderBy(desc(computationalNfts.createdAt));

      // Transform database results to application format using our helper function
      const nfts = dbNfts.map(nft => toAppFormat(nft));

      return nfts;
    } catch (error) {
      logError(storageLogger, 'Error getting NFTs by region', error as Error);
      return [];
    }
  }

  // Computational Task methods
  async getAllComputationalTasks(limit = 100, page = 1): Promise<any[]> {
    try {
      const offset = (page - 1) * limit;

      // Query the database
      const dbTasks = await db
        .select()
        .from(computationalTasks)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(computationalTasks.createdAt));

      // Transform database results to application format using our helper function
      const tasks = dbTasks.map(task => toAppFormat(task));

      return tasks;
    } catch (error) {
      logError(storageLogger, 'Error getting computational tasks', error as Error);
      return [];
    }
  }

  async getComputationalTaskById(id: number | string): Promise<any | null> {
    try {
      // Use Drizzle ORM for the query instead of raw SQL to prevent schema mismatches
      const result = await db
        .select()
        .from(computationalTasks)
        .where(eq(computationalTasks.id, parseInt(id.toString(), 10) || 0))
        .limit(1);

      storageLogger.debug('Executing task lookup query using Drizzle ORM', { id });
      if (result.length === 0) {
        storageLogger.debug('No task found', { id });
        return null;
      }

      // Transform database result to application format using our helper function
      return toAppFormat(result[0]);
    } catch (error) {
      logError(storageLogger, 'Error getting computational task by ID', error as Error);
      return null;
    }
  }

  async getComputationalTaskByTaskId(taskId: string): Promise<any | null> {
    try {
      const [dbTask] = await db
        .select()
        .from(computationalTasks)
        .where(eq(computationalTasks.taskId, taskId));

      if (!dbTask) {
        return null;
      }

      // Transform to application format using our helper function
      return toAppFormat(dbTask);
    } catch (error) {
      logError(storageLogger, 'Error getting computational task by task ID', error as Error);
      return null;
    }
  }

  async getComputationalTasksByNFTId(nftId: number): Promise<any[]> {
    try {
      // Use Drizzle ORM for the query
      const result = await db
        .select()
        .from(computationalTasks)
        .where(
          eq(computationalTasks.nftId, parseInt(nftId.toString(), 10) || 0)
        )
        .orderBy(desc(computationalTasks.createdAt));

      storageLogger.debug('Executing tasks by NFT ID query', { nftId, resultCount: result.length });

      // Transform database results to application format using our helper function
      return result.map(task => toAppFormat(task));
    } catch (error) {
      logError(storageLogger, 'Error getting computational tasks by NFT ID', error as Error);
      return [];
    }
  }

  async createComputationalTask(task: any): Promise<any> {
    try {
      // Apply defaults to the task object
      const taskWithDefaults = {
        taskId:
          task.taskId || `task-${Math.random().toString(36).substring(2, 10)}`,
        title: task.title,
        description: task.description,
        status: task.status || 'PENDING',
        latitude: task.latitude,
        longitude: task.longitude,
        region: task.region,
        regionCode: task.regionCode,
        taskType: task.taskType || 'GENERIC',
        priority: task.priority || 'MEDIUM',
        baseReward: task.baseReward || 0,
        dataMetrics: task.dataMetrics || {},
        resourceRequirements: task.resourceRequirements || {},
        nftId: task.nftId,
        assignedNodeId: task.assignedNodeId,
        requiresVerification:
          task.requiresVerification !== undefined
            ? task.requiresVerification
            : false,
        deadline: task.deadline,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Map application data to database schema using our helper function
      const dbTask = toDbFormat(taskWithDefaults);

      // Create in database with proper type casting
      const [newDbTask] = await db
        .insert(computationalTasks)
        .values(dbTask as any)
        .returning();

      if (!newDbTask) {
        throw new Error('Failed to create computational task');
      }

      // Transform database result to application format using our helper function
      return toAppFormat(newDbTask);
    } catch (error) {
      logError(storageLogger, 'Error creating computational task', error as Error);
      throw error;
    }
  }

  async updateComputationalTask(
    taskId: string,
    updates: any
  ): Promise<any | null> {
    try {
      // Convert input data to database format
      const dbUpdates = toDbFormat(updates);

      // Update the task using Drizzle's typesafe API
      const [updatedTask] = await db
        .update(computationalTasks)
        .set(dbUpdates)
        .where(eq(computationalTasks.taskId, taskId))
        .returning();

      if (!updatedTask) {
        storageLogger.debug('No task found to update', { taskId });
        return null;
      }

      // Convert database result back to application format
      return toAppFormat(updatedTask);
    } catch (error) {
      logError(storageLogger, 'Error updating computational task', error as Error);
      return null;
    }
  }

  // Computational Node methods
  async getOptimalNodeForNFT(nftId: number): Promise<any | null> {
    try {
      // Get the NFT to determine its requirements
      const nft = await this.getComputationalNFTById(nftId);
      if (!nft) {
        storageLogger.warn('NFT not found for optimal node lookup', { nftId });
        return null;
      }

      // Find nodes matching the NFT's region code and capabilities
      const dbNodes = await db
        .select()
        .from(computationalNodes)
        .where(
          and(
            eq(computationalNodes.location, nft.regionCode), // Match region code using location field
            eq(computationalNodes.status, 'active')
          )
        )
        .orderBy(desc(computationalNodes.totalTasksCompleted));

      if (dbNodes.length === 0) {
        storageLogger.debug('No matching nodes found for NFT', { nftId, regionCode: nft.regionCode });
        return null;
      }

      // Transform the database result to application format using our helper function
      return toAppFormat(dbNodes[0]);
    } catch (error) {
      logError(storageLogger, 'Error finding optimal node for NFT', error as Error);
      return null;
    }
  }

  // Missing GraphQL resolver methods

  async getTransactionsByBlockHash(blockHash: string): Promise<any[]> {
    try {
      // First get the block by hash
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, blockHash));

      if (!block) {
        storageLogger.debug('No block found with hash', { blockHash });
        return [];
      }

      // Then get transactions for that block
      const txs = await db
        .select()
        .from(transactions)
        .where(eq(transactions.blockId, block.id))
        .orderBy(desc(transactions.timestamp));

      return txs;
    } catch (error) {
      logError(storageLogger, 'Error getting transactions by block hash', error as Error);
      return [];
    }
  }

  async getBlockByHash(blockHash: string): Promise<any | undefined> {
    try {
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, blockHash));

      return block || undefined;
    } catch (error) {
      logError(storageLogger, 'Error getting block by hash', error as Error);
      return undefined;
    }
  }

  async getBlockByHeight(height: number): Promise<any | undefined> {
    try {
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.height, height));

      return block || undefined;
    } catch (error) {
      logError(storageLogger, 'Error getting block by height', error as Error);
      return undefined;
    }
  }

  async getLatestBlocks(limit: number = 10): Promise<any[]> {
    try {
      const latestBlocks = await db
        .select()
        .from(blocks)
        .orderBy(desc(blocks.height))
        .limit(limit);

      return latestBlocks;
    } catch (error) {
      logError(storageLogger, 'Error getting latest blocks', error as Error);
      return [];
    }
  }

  async getWalletByUserId(userId: number): Promise<any | undefined> {
    try {
      // Get the user to find their wallet address
      const [user] = await db.select().from(users).where(eq(users.id, userId));

      if (!user || !user.walletAddress) {
        storageLogger.debug('User not found or has no wallet address', { userId });
        return undefined;
      }

      // Find the wallet by address
      const [wallet] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.address, user.walletAddress));

      return wallet || undefined;
    } catch (error) {
      logError(storageLogger, 'Error getting wallet by user ID', error as Error);
      return undefined;
    }
  }
}

export const storage = new DatabaseStorage();
