/**
 * Data-Aware Block Service
 *
 * This service handles the creation, validation, and management of data-aware blocks
 * specialized for meteorological and computational data in the Wrfcoin blockchain.
 */

import { db } from '../database/db.js';
import { eq, desc, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { blockchainLogger } from './utils/logger.js';
import {
  dataAwareBlocks,
  checkpointBlocks,
  sensorDevices,
  sensorSubmissions,
  nodes,
} from '../shared/schema-data-aware.js';
import {
  DataAwareBlock,
  DataAwareBlockHeader,
  DataBlockType,
  DataStorageProvider,
  DataStorageReference,
  SensorSubmissions,
  PruningPolicy,
  BoundingBox,
  TimestampRange,
  DataParameter,
  DataProcessing,
  QualityInfo,
  AccessControl,
  CheckpointBlock,
  GeoReferenceSystem,
} from '../shared/data-aware-block.js';

class DataAwareBlockService {
  /**
   * Create a new data-aware block
   */
  async createDataBlock(
    creator: string,
    dataType: DataBlockType,
    forecastMetadata: {
      timeRange: TimestampRange;
      spatialExtent: BoundingBox;
      parameters: DataParameter[];
      processing: DataProcessing;
      quality: QualityInfo;
    },
    storage: DataStorageReference,
    access: AccessControl,
    pruning: PruningPolicy,
    transactions: string[],
    sensorData?: SensorSubmissions,
    extensions: Record<string, any> = {}
  ): Promise<DataAwareBlock> {
    try {
      // Get the latest block to use as parent
      const [latestBlock] = await db
        .select()
        .from(dataAwareBlocks)
        .orderBy(desc(dataAwareBlocks.timestamp))
        .limit(1);

      const parentBlockId = latestBlock ? latestBlock.block_id : 'genesis';

      // Generate a unique block ID
      const blockId = `dab-${uuidv4()}`;

      // Create block header
      const header: DataAwareBlockHeader = {
        version: 1,
        block_id: blockId,
        parent_block_id: parentBlockId,
        data_type: dataType,
        creator_address: creator,
        creation_timestamp: new Date().toISOString(),
        forecast_metadata: {
          time_range: forecastMetadata.timeRange,
          spatial_extent: forecastMetadata.spatialExtent,
          parameters: forecastMetadata.parameters,
          processing: forecastMetadata.processing,
          quality: forecastMetadata.quality,
        },
        sensor_data: sensorData,
        storage,
        access,
        pruning,
        extensions,
      };

      // Calculate data summary (for data preserved after pruning)
      const dataSummary = this.generateDataSummary(forecastMetadata.parameters);

      // Generate hash, nonce, and other block properties
      const timestamp = new Date().toISOString();
      const difficulty = 4; // Example difficulty, would be dynamic in production
      const { hash, nonce } = await this.mineBlock(
        header,
        transactions,
        timestamp,
        difficulty
      );

      // Calculate block size
      const blockContents = JSON.stringify({
        header,
        transactions,
        hash,
        nonce,
        timestamp,
        difficulty,
        dataSummary,
      });
      const sizeBytes = Buffer.from(blockContents).byteLength;

      // Create the complete block
      const block: DataAwareBlock = {
        header,
        transactions,
        hash,
        signature: this.signBlock(hash, creator),
        nonce,
        timestamp,
        difficulty,
        size_bytes: sizeBytes,
        data_summary: dataSummary,
      };

      // Store in database
      await db.insert(dataAwareBlocks).values({
        block_id: blockId,
        parent_block_id: parentBlockId,
        data_type: dataType,
        creator_address: creator,
        creation_timestamp: new Date(header.creation_timestamp),
        version: header.version,
        hash,
        signature: block.signature,
        nonce,
        timestamp: new Date(timestamp),
        difficulty,
        size_bytes: sizeBytes,
        forecast_metadata: header.forecast_metadata,
        sensor_data: header.sensor_data || null,
        storage: header.storage,
        access: header.access,
        pruning: header.pruning,
        transactions,
        data_summary: dataSummary || null,
        extensions: header.extensions,
      });

      return block;
    } catch (error) {
      blockchainLogger.error('Error creating data-aware block', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to create data-aware block: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Create a checkpoint block that summarizes multiple data blocks
   */
  async createCheckpointBlock(
    creator: string,
    checkpointLevel: number,
    summarizedBlocks: string[],
    periodStart: string,
    periodEnd: string,
    rollupTransactions: string[]
  ): Promise<CheckpointBlock> {
    try {
      // First, create a regular data-aware block
      const storageRef: DataStorageReference = {
        provider: DataStorageProvider.LOCAL,
        reference: `checkpoint-${uuidv4()}`,
        size_bytes: 0, // Will update after block creation
        format: 'json',
      };

      const timeRange: TimestampRange = {
        start: periodStart,
        end: periodEnd,
        temporal_resolution: 'checkpoint',
      };

      const bBox: BoundingBox = {
        reference_system: GeoReferenceSystem.WGS84,
        min_x: -180,
        min_y: -90,
        max_x: 180,
        max_y: 90,
        spatial_resolution: 'global',
      };

      const access: AccessControl = {
        license: 'CC0-1.0',
        owner_address: creator,
        is_public: true,
      };

      const pruning: PruningPolicy = {
        permanent_storage: true,
        reduced_retention: {
          keep_metadata: true,
          keep_summary: true,
          keep_extremes: true,
        },
      };

      // Generate a hash of the current system state
      const systemStateHash = this.generateSystemStateHash(summarizedBlocks);

      // Create the block
      const block = await this.createDataBlock(
        creator,
        DataBlockType.COMPUTATIONAL_RESULT,
        {
          timeRange,
          spatialExtent: bBox,
          parameters: [],
          processing: {
            model_name: 'CheckpointModel',
            model_version: '1.0',
            processor_id: creator,
            processing_date: new Date().toISOString(),
          },
          quality: {
            review_status: 'validated',
          },
        },
        storageRef,
        access,
        pruning,
        rollupTransactions,
        undefined,
        { checkpointData: true }
      );

      // Now extend it with checkpoint-specific data
      const checkpointBlock: CheckpointBlock = {
        ...block,
        checkpoint_level: checkpointLevel,
        summarized_blocks: summarizedBlocks,
        period_start: periodStart,
        period_end: periodEnd,
        system_state_hash: systemStateHash,
        rollup_transactions: rollupTransactions,
      };

      // Store the checkpoint block data
      await db.insert(checkpointBlocks).values({
        data_aware_block_id: (
          await db
            .select()
            .from(dataAwareBlocks)
            .where(eq(dataAwareBlocks.block_id, block.header.block_id))
            .limit(1)
        )[0].id,
        checkpoint_level: checkpointLevel,
        period_start: new Date(periodStart),
        period_end: new Date(periodEnd),
        system_state_hash: systemStateHash,
        summarized_blocks: summarizedBlocks,
        rollup_transactions: rollupTransactions,
      });

      return checkpointBlock;
    } catch (error) {
      blockchainLogger.error('Error creating checkpoint block', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to create checkpoint block: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get a data block by its ID
   */
  async getDataBlock(blockId: string): Promise<DataAwareBlock> {
    try {
      const [block] = await db
        .select()
        .from(dataAwareBlocks)
        .where(eq(dataAwareBlocks.block_id, blockId))
        .limit(1);

      if (!block) {
        throw new Error(`Block with ID ${blockId} not found`);
      }

      // Map database record to DataAwareBlock type
      return this.mapDbBlockToDataBlock(block);
    } catch (error) {
      blockchainLogger.error('Error retrieving data block', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to retrieve data block: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get a checkpoint block by its ID
   */
  async getCheckpointBlock(blockId: string): Promise<CheckpointBlock> {
    try {
      // Get the base data block
      const dataBlock = await this.getDataBlock(blockId);

      // Get the checkpoint-specific data
      const [block] = await db
        .select()
        .from(dataAwareBlocks)
        .innerJoin(
          checkpointBlocks,
          eq(dataAwareBlocks.id, checkpointBlocks.data_aware_block_id)
        )
        .where(eq(dataAwareBlocks.block_id, blockId))
        .limit(1);

      if (!block || !block.checkpoint_blocks) {
        throw new Error(`Checkpoint block with ID ${blockId} not found`);
      }

      // Create the checkpoint block by combining data
      const checkpointBlock: CheckpointBlock = {
        ...dataBlock,
        checkpoint_level: block.checkpoint_blocks.checkpoint_level,
        summarized_blocks: block.checkpoint_blocks
          .summarized_blocks as string[],
        period_start: block.checkpoint_blocks.period_start.toISOString(),
        period_end: block.checkpoint_blocks.period_end.toISOString(),
        system_state_hash: block.checkpoint_blocks.system_state_hash,
        rollup_transactions: block.checkpoint_blocks
          .rollup_transactions as string[],
      };

      return checkpointBlock;
    } catch (error) {
      blockchainLogger.error('Error retrieving checkpoint block', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to retrieve checkpoint block: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get blocks by data type
   */
  async getBlocksByType(
    dataType: DataBlockType,
    limit = 10
  ): Promise<DataAwareBlock[]> {
    try {
      const blocks = await db
        .select()
        .from(dataAwareBlocks)
        .where(eq(dataAwareBlocks.data_type, dataType))
        .orderBy(desc(dataAwareBlocks.timestamp))
        .limit(limit);

      return blocks.map(block => this.mapDbBlockToDataBlock(block));
    } catch (error) {
      blockchainLogger.error('Error retrieving blocks by type', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to retrieve blocks by type: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get blocks by creator address
   */
  async getBlocksByCreator(
    creatorAddress: string,
    limit = 10
  ): Promise<DataAwareBlock[]> {
    try {
      const blocks = await db
        .select()
        .from(dataAwareBlocks)
        .where(eq(dataAwareBlocks.creator_address, creatorAddress))
        .orderBy(desc(dataAwareBlocks.timestamp))
        .limit(limit);

      return blocks.map(block => this.mapDbBlockToDataBlock(block));
    } catch (error) {
      blockchainLogger.error('Error retrieving blocks by creator', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to retrieve blocks by creator: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all checkpoint blocks
   */
  async getCheckpointBlocks(limit = 10): Promise<CheckpointBlock[]> {
    try {
      const blocks = await db
        .select()
        .from(dataAwareBlocks)
        .innerJoin(
          checkpointBlocks,
          eq(dataAwareBlocks.id, checkpointBlocks.data_aware_block_id)
        )
        .orderBy(desc(dataAwareBlocks.timestamp))
        .limit(limit);

      return await Promise.all(
        blocks.map(block =>
          this.getCheckpointBlock(block.data_aware_blocks.block_id)
        )
      );
    } catch (error) {
      blockchainLogger.error('Error retrieving checkpoint blocks', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to retrieve checkpoint blocks: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Register a sensor device
   */
  async registerSensorDevice(
    deviceId: string,
    ownerAddress: string,
    deviceType: string,
    name: string,
    locationLat: string,
    locationLon: string,
    elevation?: number,
    metadata?: Record<string, any>
  ): Promise<string> {
    try {
      await db.insert(sensorDevices).values({
        device_id: deviceId,
        owner_address: ownerAddress,
        device_type: deviceType,
        name,
        location_lat: locationLat,
        location_lon: locationLon,
        elevation,
        active: true,
        registration_date: new Date(),
        metadata: metadata || null,
      });

      return deviceId;
    } catch (error) {
      blockchainLogger.error('Error registering sensor device', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to register sensor device: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Register a node
   */
  async registerNode(
    nodeId: string,
    nodeType:
      | 'validator'
      | 'data_submission'
      | 'forecast_compute'
      | 'file_storage'
      | 'light_client',
    ownerAddress: string,
    name: string,
    ipAddress?: string,
    port?: number,
    stakeAmount = 0,
    capabilities: Record<string, any> = {}
  ): Promise<string> {
    try {
      await db.insert(nodes).values({
        node_id: nodeId,
        node_type: nodeType,
        owner_address: ownerAddress,
        name,
        ip_address: ipAddress || null,
        port: port || null,
        registration_date: new Date(),
        last_seen: new Date(),
        stake_amount: stakeAmount,
        reputation_score: 100,
        capabilities,
        is_active: true,
      });

      return nodeId;
    } catch (error) {
      blockchainLogger.error('Error registering node', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to register node: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Submit sensor data
   */
  async submitSensorData(
    deviceId: string,
    data: Record<string, any>,
    submissionId = `submission-${uuidv4()}`
  ): Promise<string> {
    try {
      // Check if device exists
      const [device] = await db
        .select()
        .from(sensorDevices)
        .where(eq(sensorDevices.device_id, deviceId))
        .limit(1);

      if (!device) {
        throw new Error(`Device with ID ${deviceId} not found`);
      }

      // Hash the data
      const submissionHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');

      // Store the submission
      await db.insert(sensorSubmissions).values({
        submission_id: submissionId,
        device_id: deviceId,
        block_id: null, // Will be set when included in a block
        submission_hash: submissionHash,
        submission_timestamp: new Date(),
        data,
        verified: false,
      });

      // Update the device's last submission time
      await db
        .update(sensorDevices)
        .set({ last_submission: new Date() })
        .where(eq(sensorDevices.device_id, deviceId));

      return submissionId;
    } catch (error) {
      blockchainLogger.error('Error submitting sensor data', { error: error instanceof Error ? error.message : String(error) });
      throw new Error(
        `Failed to submit sensor data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Helper Methods

  /**
   * Generate data summary for a block
   */
  private generateDataSummary(parameters: DataParameter[]): {
    min_values: Record<string, number>;
    max_values: Record<string, number>;
    mean_values: Record<string, number>;
    anomaly_indices?: number[];
  } {
    // In a real implementation, this would analyze actual data
    const summary = {
      min_values: {} as Record<string, number>,
      max_values: {} as Record<string, number>,
      mean_values: {} as Record<string, number>,
    };

    parameters.forEach(param => {
      // Generate random values for demonstration
      const min =
        param.min_value !== undefined ? param.min_value : Math.random() * 100;
      const max =
        param.max_value !== undefined
          ? param.max_value
          : min + Math.random() * 100;
      const mean = min + (max - min) / 2;

      summary.min_values[param.name] = min;
      summary.max_values[param.name] = max;
      summary.mean_values[param.name] = mean;
    });

    return summary;
  }

  /**
   * Mine a block (simplified for demonstration)
   */
  private async mineBlock(
    header: DataAwareBlockHeader,
    transactions: string[],
    timestamp: string,
    difficulty: number
  ): Promise<{ hash: string; nonce: number }> {
    let nonce = 0;
    let hash = '';
    const target = '0'.repeat(difficulty);

    // Simplified mining algorithm
    while (true) {
      hash = this.calculateBlockHash(header, transactions, timestamp, nonce);
      if (hash.startsWith(target)) {
        break;
      }
      nonce++;

      // Prevent infinite loops in development
      if (nonce > 1000) {
        break; // For demo purposes only, real mining would continue
      }
    }

    return { hash, nonce };
  }

  /**
   * Calculate block hash
   */
  private calculateBlockHash(
    header: DataAwareBlockHeader,
    transactions: string[],
    timestamp: string,
    nonce: number
  ): string {
    const data = JSON.stringify({
      header,
      transactions,
      timestamp,
      nonce,
    });

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Sign a block (simplified for demonstration)
   */
  private signBlock(hash: string, address: string): string {
    // In a real implementation, this would use proper cryptographic signing
    return crypto
      .createHash('sha256')
      .update(`${hash}:${address}`)
      .digest('hex');
  }

  /**
   * Generate system state hash for checkpoint blocks
   */
  private generateSystemStateHash(blockIds: string[]): string {
    return crypto.createHash('sha256').update(blockIds.join(':')).digest('hex');
  }

  /**
   * Map database record to DataAwareBlock type
   */
  private mapDbBlockToDataBlock(block: any): DataAwareBlock {
    return {
      header: {
        version: block.version,
        block_id: block.block_id,
        parent_block_id: block.parent_block_id,
        data_type: block.data_type,
        creator_address: block.creator_address,
        creation_timestamp: block.creation_timestamp.toISOString(),
        forecast_metadata: block.forecast_metadata,
        sensor_data: block.sensor_data,
        storage: block.storage,
        access: block.access,
        pruning: block.pruning,
        extensions: block.extensions,
      },
      transactions: block.transactions,
      hash: block.hash,
      signature: block.signature,
      nonce: block.nonce,
      timestamp: block.timestamp.toISOString(),
      difficulty: block.difficulty,
      size_bytes: block.size_bytes,
      data_summary: block.data_summary,
    };
  }
}

export const dataAwareBlockService = new DataAwareBlockService();
