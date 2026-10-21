/**
 * Enhanced Database Storage Implementation for Wrfcoin
 *
 * This implementation provides consistent field name conversion between camelCase (application code)
 * and snake_case (database) for all database operations, utilizing the field name converter utility.
 */

import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../node_modules/drizzle-orm/index.js';
import { db } from '../database/db.js';
import * as crypto from 'crypto';
import fieldNameConverter from '../utils/fieldNameConverter.js';
import { storageLogger } from './utils/logger.js';

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
  crossChainTransfers,
  achievements,
  achievementCategories,
  minerAchievementProgress,
  minerAchievements,
  wallets,
  type User,
  type InsertUser,
} from '../shared/schema.js';

// Import IStorage interface
import {
  IStorage,
  PrivacyLevel,
  SecurityConfig,
  ConsensusConfig,
  DEFAULT_SECURITY_CONFIG,
} from './storage.js';

const { eq, and, or, desc, asc, sql } =
  drizzleOrm as unknown as typeof drizzleOrmEsm;

// Enhanced database storage implementation
export class EnhancedDatabaseStorage implements IStorage {
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

  // Identity operations
  async getIdentityByDid(did: string): Promise<any | undefined> {
    const [identity] = await db
      .select()
      .from(decentralizedIdentities)
      .where(eq(decentralizedIdentities.did, did));

    return identity ? fieldNameConverter.snakeToCamel(identity) : undefined;
  }

  async getAllIdentities(): Promise<any[]> {
    const identities = await db.select().from(decentralizedIdentities);
    return identities.map(identity =>
      fieldNameConverter.snakeToCamel(identity)
    );
  }

  async createIdentity(identity: any): Promise<any> {
    const dbIdentity = fieldNameConverter.camelToSnake(identity);
    const [result] = await db
      .insert(decentralizedIdentities)
      .values(dbIdentity as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateIdentity(did: string, updateData: any): Promise<any> {
    const dbUpdateData = fieldNameConverter.camelToSnake(updateData);
    const [result] = await db
      .update(decentralizedIdentities)
      .set(dbUpdateData as any)
      .where(eq(decentralizedIdentities.did, did))
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async getIdentitiesByType(type: string): Promise<any[]> {
    const identities = await db
      .select()
      .from(decentralizedIdentities)
      .where(eq(decentralizedIdentities.identityType, type));

    return identities.map(identity =>
      fieldNameConverter.snakeToCamel(identity)
    );
  }

  async getIdentitiesByVerificationLevel(level: string): Promise<any[]> {
    const identities = await db
      .select()
      .from(decentralizedIdentities)
      .where(eq(decentralizedIdentities.verificationLevel, level));

    return identities.map(identity =>
      fieldNameConverter.snakeToCamel(identity)
    );
  }

  // Verifiable Credential operations
  async getCredentialById(id: number): Promise<any | undefined> {
    const [credential] = await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.id, id));

    return credential ? fieldNameConverter.snakeToCamel(credential) : undefined;
  }

  async getCredentialsBySubject(subjectDid: string): Promise<any[]> {
    const credentials = await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.subjectDid, subjectDid));

    return credentials.map(cred => fieldNameConverter.snakeToCamel(cred));
  }

  async getCredentialsByIssuer(issuerDid: string): Promise<any[]> {
    const credentials = await db
      .select()
      .from(verifiableCredentials)
      .where(eq(verifiableCredentials.issuerDid, issuerDid));

    return credentials.map(cred => fieldNameConverter.snakeToCamel(cred));
  }

  async createCredential(credential: any): Promise<any> {
    const dbCredential = fieldNameConverter.camelToSnake(credential);
    const [result] = await db
      .insert(verifiableCredentials)
      .values(dbCredential as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateCredentialStatus(id: number, status: string): Promise<any> {
    const [result] = await db
      .update(verifiableCredentials)
      .set({ status })
      .where(eq(verifiableCredentials.id, id))
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async verifyCredential(credential: any): Promise<boolean> {
    // Simplified verification logic
    // In a real implementation, this would check cryptographic proofs
    return true;
  }

  // Trust Anchor operations
  async getTrustAnchorById(id: number): Promise<any | undefined> {
    const [anchor] = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.id, id));

    return anchor ? fieldNameConverter.snakeToCamel(anchor) : undefined;
  }

  async getTrustAnchorByDid(did: string): Promise<any | undefined> {
    const [anchor] = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.anchorDid, did));

    return anchor ? fieldNameConverter.snakeToCamel(anchor) : undefined;
  }

  async createTrustAnchor(anchor: any): Promise<any> {
    const dbAnchor = fieldNameConverter.camelToSnake(anchor);
    const [result] = await db
      .insert(trustAnchors)
      .values(dbAnchor as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateTrustAnchor(id: number, updates: any): Promise<any> {
    const dbUpdates = fieldNameConverter.camelToSnake(updates);
    const [result] = await db
      .update(trustAnchors)
      .set(dbUpdates as any)
      .where(eq(trustAnchors.id, id))
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async getTrustAnchorsByType(type: string): Promise<any[]> {
    const anchors = await db
      .select()
      .from(trustAnchors)
      .where(eq(trustAnchors.anchorType, type));

    return anchors.map(anchor => fieldNameConverter.snakeToCamel(anchor));
  }

  // Reputation operations
  async getReputationById(id: number): Promise<any | undefined> {
    const [rep] = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.id, id));

    return rep ? fieldNameConverter.snakeToCamel(rep) : undefined;
  }

  async getReputationScoreByIdentity(identityDid: string): Promise<number> {
    const [rep] = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.identityDid, identityDid));

    return rep?.overallScore || 0;
  }

  async getReputationEventsByIdentity(
    identityDid: string,
    factor?: string,
    limit?: number,
    offset?: number
  ): Promise<any[]> {
    let whereClause = eq(reputationEvents.identityDid, identityDid);

    if (factor) {
      whereClause = and(
        whereClause,
        eq(reputationEvents.factor, factor)
      ) as any;
    }

    let query = db
      .select()
      .from(reputationEvents)
      .where(whereClause)
      .orderBy(desc(reputationEvents.createdAt));

    if (limit) {
      query = query.limit(limit) as any;
    }

    if (offset) {
      query = query.offset(offset) as any;
    }

    const events = await query;
    return events.map(event => fieldNameConverter.snakeToCamel(event));
  }

  async createReputationScore(scoreData: any): Promise<any> {
    const dbScoreData = fieldNameConverter.camelToSnake(scoreData);
    const [result] = await db
      .insert(reputationScores)
      .values(dbScoreData as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateReputationScore(id: number, scoreData: any): Promise<any> {
    const dbScoreData = fieldNameConverter.camelToSnake(scoreData);
    const [result] = await db
      .update(reputationScores)
      .set(dbScoreData as any)
      .where(eq(reputationScores.id, id))
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async recordReputationEvent(eventData: any): Promise<any> {
    const dbEventData = fieldNameConverter.camelToSnake(eventData);
    const [result] = await db
      .insert(reputationEvents)
      .values(dbEventData as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async refreshReputationScoreForIdentity(identityDid: string): Promise<void> {
    const factorScores = await this.calculateFactorScores(identityDid);
    const totalEvents = await db
      .select({ count: sql`count(*)` })
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid));

    const count = Number(totalEvents[0]?.count || 0);
    const confidence = this.calculateConfidenceLevel(count);

    // Calculate aggregate score
    const aggregate = await this.calculateAggregateReputation(identityDid);

    await db
      .update(reputationScores)
      .set({
        overallScore: aggregate,
        metadata: factorScores as any,
        confidenceLevel: confidence.toString(),
        lastUpdated: new Date(),
      })
      .where(eq(reputationScores.identityDid, identityDid));
  }

  async getAllReputationScores(): Promise<any[]> {
    const scores = await db.select().from(reputationScores);
    return scores.map(score => fieldNameConverter.snakeToCamel(score));
  }

  async calculateFactorScores(
    identityDid: string
  ): Promise<Record<string, number>> {
    const events = await db
      .select()
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid));

    const factorScores: Record<string, { total: number; count: number }> = {};

    for (const event of events) {
      const factor = event.factor;
      if (!factorScores[factor]) {
        factorScores[factor] = { total: 0, count: 0 };
      }

      factorScores[factor].total += event.impact;
      factorScores[factor].count += 1;
    }

    const result: Record<string, number> = {};

    for (const [factor, data] of Object.entries(factorScores)) {
      result[factor] = data.total / data.count;
    }

    return result;
  }

  calculateConfidenceLevel(totalEvents: number): number {
    // Simple confidence calculation based on event count
    if (totalEvents >= 100) return 1.0;
    if (totalEvents >= 50) return 0.9;
    if (totalEvents >= 20) return 0.8;
    if (totalEvents >= 10) return 0.7;
    if (totalEvents >= 5) return 0.6;
    return 0.5;
  }

  async getReputationFactorsByIdentity(identityDid: string): Promise<any[]> {
    const events = await db
      .select({
        factor: reputationEvents.factor,
        count: sql`count(*)`,
        avg: sql`avg(${reputationEvents.impact})`,
      })
      .from(reputationEvents)
      .where(eq(reputationEvents.identityDid, identityDid))
      .groupBy(reputationEvents.factor);

    return events.map(e => ({
      factor: e.factor,
      count: Number(e.count),
      average: Number(e.avg),
    }));
  }

  async calculateAggregateReputation(identityDid: string): Promise<number> {
    const factorScores = await this.calculateFactorScores(identityDid);
    const factors = Object.values(factorScores);

    if (factors.length === 0) return 0;

    return factors.reduce((sum, score) => sum + score, 0) / factors.length;
  }

  // Proof of Publishing operations
  async submitEnvironmentalData(data: any): Promise<any> {
    try {
      storageLogger.info('[PoP:storage] Processing environmental data submission from IoT device', {
        dataType: data.dataType,
        submitterId: data.submitterId,
        deviceType: data.deviceType || 'UNKNOWN',
        measurementCount: data.measurements?.length,
      });

      // Generate a unique submission ID if not provided
      const submissionId =
        data.submissionId || `pop-${crypto.randomUUID().substring(0, 8)}`;

      // Convert location to separate latitude and longitude fields
      const location = data.location || { latitude: 0, longitude: 0 };

      // Process metadata to include device information
      const metadata = {
        ...(data.metadata || {}),
        deviceType: data.deviceType || 'UNKNOWN',
        deviceModel: data.deviceModel,
        deviceFirmware: data.deviceFirmware,
        deviceId: data.deviceId,
        calibrationDate: data.calibrationDate,
        sensorAccuracy: data.sensorAccuracy,
        batteryLevel: data.batteryLevel,
        signalStrength: data.signalStrength,
        iotProtocol: data.iotProtocol || 'MQTT',
      };

      // Create submission hash from data for verification
      const submissionContent = JSON.stringify({
        submitterId: data.submitterId,
        dataType: data.dataType,
        location: data.location,
        measurements: data.measurements,
        timestamp: data.timestamp || new Date(),
        deviceId: data.deviceId,
      });

      // Use proper hashing for verification
      const submissionHash = crypto
        .createHash('sha256')
        .update(submissionContent)
        .digest('hex');

      // Convert to camelCase for the database schema
      const submission = {
        submissionId: submissionId,
        submitterId: data.submitter || data.submitterId,
        dataType: data.dataType,
        validationState: 'PENDING',
        latitude: location.latitude,
        longitude: location.longitude,
        elevation: location.elevation,
        locationDescription: location.description,
        measurements: data.measurements || [],
        metadata: metadata,
        submissionTimestamp: new Date(),
        validationCount: 0,
        validCount: 0,
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
        firmwareVersion: data.deviceFirmware || '',
        batteryLevel: data.batteryLevel || 100,
        signalStrength: data.signalStrength || 5,
      };

      // Convert to snake_case for database operation
      const dbSubmission = fieldNameConverter.camelToSnake(submission);

      // Insert the submission into the database
      const [result] = await db
        .insert(environmentalSubmissions)
        .values(dbSubmission as any)
        .returning();

      // Convert back to camelCase for application code
      return fieldNameConverter.snakeToCamel(result);
    } catch (error) {
      storageLogger.error('[PoP:storage] Error submitting environmental data', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async getSubmissionById(submissionId: string): Promise<any | undefined> {
    const [submission] = await db
      .select()
      .from(environmentalSubmissions)
      .where(eq(environmentalSubmissions.submissionId, submissionId));

    if (!submission) return undefined;

    // Convert from database format to application format
    return fieldNameConverter.snakeToCamel(submission);
  }

  async getRecentSubmissions(
    limit?: number,
    dataType?: string
  ): Promise<any[]> {
    let query = db
      .select()
      .from(environmentalSubmissions)
      .orderBy(desc(environmentalSubmissions.submissionTimestamp));

    if (dataType) {
      query = query.where(
        eq(environmentalSubmissions.dataType, dataType)
      ) as any;
    }

    const finalQuery = query.limit(limit || 10);

    const submissions = await finalQuery;

    // Convert from database format to application format
    return submissions.map(sub => fieldNameConverter.snakeToCamel(sub));
  }

  async submitAttestation(attestation: any): Promise<any> {
    const dbAttestation = fieldNameConverter.camelToSnake(attestation);
    const [result] = await db
      .insert(validationAttestations)
      .values(dbAttestation as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async getAttestationsForSubmission(submissionId: string): Promise<any[]> {
    const attestations = await db
      .select()
      .from(validationAttestations)
      .where(eq(validationAttestations.submissionId, submissionId));

    return attestations.map(att => fieldNameConverter.snakeToCamel(att));
  }

  async validateSubmission(submissionId: string): Promise<boolean> {
    const attestations = await this.getAttestationsForSubmission(submissionId);

    // Simple validation: require at least 3 attestations
    if (attestations.length < 3) {
      return false;
    }

    // Calculate how many attestations have isValid = true
    const validCount = attestations.filter(att => att.isValid).length;

    // Require majority valid attestations
    const isValid = validCount > attestations.length / 2;

    // Update the submission validation state
    await db
      .update(environmentalSubmissions)
      .set({
        validationState: isValid ? 'VALIDATED' : 'REJECTED',
        metadata: {
          validationCount: attestations.length,
          validCount: validCount,
          updatedAt: new Date(),
        },
      })
      .where(eq(environmentalSubmissions.submissionId, submissionId));

    return isValid;
  }

  async createPopReward(rewardData: any): Promise<any> {
    const dbRewardData = fieldNameConverter.camelToSnake(rewardData);
    const [result] = await db
      .insert(popRewards)
      .values(dbRewardData as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async getRewardsForSubmission(submissionId: string): Promise<any[]> {
    const rewards = await db
      .select()
      .from(popRewards)
      .where(eq(popRewards.submissionId, submissionId));

    return rewards.map(reward => fieldNameConverter.snakeToCamel(reward));
  }

  // Reference data operations
  async getReferenceDataSourceById(id: number): Promise<any | undefined> {
    const [source] = await db
      .select()
      .from(referenceDataSources)
      .where(eq(referenceDataSources.id, id));

    return source ? fieldNameConverter.snakeToCamel(source) : undefined;
  }

  async createReferenceDataSource(source: any): Promise<any> {
    const dbSource = fieldNameConverter.camelToSnake(source);
    const [result] = await db
      .insert(referenceDataSources)
      .values(dbSource as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateReferenceDataSource(id: number, updates: any): Promise<any> {
    const dbUpdates = fieldNameConverter.camelToSnake(updates);
    const [result] = await db
      .update(referenceDataSources)
      .set(dbUpdates as any)
      .where(eq(referenceDataSources.id, id))
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async getActiveReferenceDataSources(): Promise<any[]> {
    const sources = await db
      .select()
      .from(referenceDataSources)
      .where(eq(referenceDataSources.isActive, true));

    return sources.map(source => fieldNameConverter.snakeToCamel(source));
  }

  // Computational NFT operations
  async getAllComputationalNFTs(limit?: number, page?: number): Promise<any[]> {
    const offset = page && page > 0 ? (page - 1) * (limit || 10) : 0;

    const nfts = await db
      .select()
      .from(computationalNfts)
      .limit(limit || 10)
      .offset(offset)
      .orderBy(desc(computationalNfts.createdAt));

    return nfts.map(nft => fieldNameConverter.snakeToCamel(nft));
  }

  async getComputationalNFTById(id: number): Promise<any | null> {
    const [nft] = await db
      .select()
      .from(computationalNfts)
      .where(eq(computationalNfts.id, id));

    return nft ? fieldNameConverter.snakeToCamel(nft) : null;
  }

  async createComputationalNFT(nft: any): Promise<any> {
    const dbNft = fieldNameConverter.camelToSnake(nft);
    const [result] = await db
      .insert(computationalNfts)
      .values(dbNft as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateComputationalNFT(id: number, updates: any): Promise<any | null> {
    const dbUpdates = fieldNameConverter.camelToSnake(updates);
    const [result] = await db
      .update(computationalNfts)
      .set(dbUpdates as any)
      .where(eq(computationalNfts.id, id))
      .returning();

    return result ? fieldNameConverter.snakeToCamel(result) : null;
  }

  async getNFTsByRegion(regionCode: string): Promise<any[]> {
    const nfts = await db
      .select()
      .from(computationalNfts)
      .where(eq(computationalNfts.region, regionCode));

    return nfts.map(nft => fieldNameConverter.snakeToCamel(nft));
  }

  // Computational Task operations
  async getAllComputationalTasks(
    limit?: number,
    page?: number
  ): Promise<any[]> {
    const offset = page && page > 0 ? (page - 1) * (limit || 10) : 0;

    const tasks = await db
      .select()
      .from(computationalTasks)
      .limit(limit || 10)
      .offset(offset)
      .orderBy(desc(computationalTasks.createdAt));

    return tasks.map(task => fieldNameConverter.snakeToCamel(task));
  }

  async getComputationalTaskById(id: number): Promise<any | null> {
    const [task] = await db
      .select()
      .from(computationalTasks)
      .where(eq(computationalTasks.id, id));

    return task ? fieldNameConverter.snakeToCamel(task) : null;
  }

  async getComputationalTaskByTaskId(taskId: string): Promise<any | null> {
    const [task] = await db
      .select()
      .from(computationalTasks)
      .where(eq(computationalTasks.taskId, taskId));

    return task ? fieldNameConverter.snakeToCamel(task) : null;
  }

  async getComputationalTasksByNFTId(nftId: number): Promise<any[]> {
    const tasks = await db
      .select()
      .from(computationalTasks)
      .where(eq(computationalTasks.nftId, nftId));

    return tasks.map(task => fieldNameConverter.snakeToCamel(task));
  }

  async createComputationalTask(task: any): Promise<any> {
    const dbTask = fieldNameConverter.camelToSnake(task);
    const [result] = await db
      .insert(computationalTasks)
      .values(dbTask as any)
      .returning();

    return fieldNameConverter.snakeToCamel(result);
  }

  async updateComputationalTask(
    taskId: string,
    updates: any
  ): Promise<any | null> {
    const dbUpdates = fieldNameConverter.camelToSnake(updates);
    const [result] = await db
      .update(computationalTasks)
      .set(dbUpdates as any)
      .where(eq(computationalTasks.taskId, taskId))
      .returning();

    return result ? fieldNameConverter.snakeToCamel(result) : null;
  }

  // Computational Node operations
  async getOptimalNodeForNFT(nftId: number): Promise<any | null> {
    // Get the NFT to determine requirements
    const [nft] = await db
      .select()
      .from(computationalNfts)
      .where(eq(computationalNfts.id, nftId));

    if (!nft) return null;

    // Find appropriate nodes based on computation type and region
    const nodes = await db
      .select()
      .from(computationalNodes)
      .where(eq(computationalNodes.status, 'ONLINE'));

    if (nodes.length === 0) return null;

    // For simplicity, just return the first node
    // In a real implementation, this would use more sophisticated matching
    return fieldNameConverter.snakeToCamel(nodes[0]);
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
        storageLogger.info('No block found with hash', { blockHash });
        return [];
      }

      // Then get transactions for that block
      const txs = await db
        .select()
        .from(transactions)
        .where(eq(transactions.blockId, block.id))
        .orderBy(desc(transactions.timestamp));

      return txs.map(tx => fieldNameConverter.snakeToCamel(tx));
    } catch (error) {
      storageLogger.error('Error getting transactions by block hash', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async getBlockByHash(blockHash: string): Promise<any | undefined> {
    try {
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.hash, blockHash));

      return block ? fieldNameConverter.snakeToCamel(block) : undefined;
    } catch (error) {
      storageLogger.error('Error getting block by hash', { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async getBlockByHeight(height: number): Promise<any | undefined> {
    try {
      const [block] = await db
        .select()
        .from(blocks)
        .where(eq(blocks.height, height));

      return block ? fieldNameConverter.snakeToCamel(block) : undefined;
    } catch (error) {
      storageLogger.error('Error getting block by height', { error: error instanceof Error ? error.message : String(error) });
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

      return latestBlocks.map(block => fieldNameConverter.snakeToCamel(block));
    } catch (error) {
      storageLogger.error('Error getting latest blocks', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async getWalletByUserId(userId: number): Promise<any | undefined> {
    try {
      // Get the user to find their wallet address
      const [user] = await db.select().from(users).where(eq(users.id, userId));

      if (!user || !user.walletAddress) {
        storageLogger.info('No user found or user has no wallet address', { userId });
        return undefined;
      }

      // Find the wallet by address
      const [wallet] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.address, user.walletAddress));

      return wallet ? fieldNameConverter.snakeToCamel(wallet) : undefined;
    } catch (error) {
      storageLogger.error('Error getting wallet by user ID', { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}

export const enhancedStorage = new EnhancedDatabaseStorage();
