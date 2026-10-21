/**
 * Sharded Storage System for Computational NFTs
 *
 * This module provides a sharded storage system for large computational datasets,
 * allowing for efficient storage and retrieval of data across distributed storage nodes.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface ShardedStorageConfig {
  shardSize: number;
  replicaCount: number;
  storagePath: string;
  indexPath: string;
  consistencyCheckInterval: number;
  compressionEnabled: boolean;
  encryptionEnabled: boolean;
  hashAlgorithm: string;
}

interface StorageNode {
  id: string;
  status: 'active' | 'inactive' | 'maintenance';
  capacity: number;
  used: number;
  path: string;
}

interface ShardMetadata {
  id: string;
  dataId: string;
  index: number;
  contentHash: string;
  size: number;
  created: number;
  locations: Array<{
    nodeId: string;
    path: string;
  }>;
}

interface DataIndexEntry {
  id: string;
  contentHash: string;
  size: number;
  shardCount: number;
  shards: string[];
  created: number;
  updated: number;
  [key: string]: any;
}

/**
 * Configuration for the sharded storage system
 */
const DEFAULT_CONFIG: ShardedStorageConfig = {
  shardSize: 1024 * 1024, // 1MB default shard size
  replicaCount: 3, // Number of replicas for each shard
  storagePath: path.join(__dirname, '../../data/sharded_storage'),
  indexPath: path.join(__dirname, '../../data/sharded_storage/index'),
  consistencyCheckInterval: 3600000, // 1 hour in milliseconds
  compressionEnabled: true,
  encryptionEnabled: false,
  hashAlgorithm: 'sha256',
} as const;

/**
 * Sharded Storage Manager
 *
 * Handles distribution and retrieval of data across shards
 */
export class ShardedStorageManager {
  private config: ShardedStorageConfig;
  private shards: Map<string, ShardMetadata>; // Map of shard IDs to shard metadata
  private dataIndex: Map<string, DataIndexEntry>; // Map of data IDs to shard locations
  private storageNodes: StorageNode[];

  constructor(config: Partial<ShardedStorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.shards = new Map<string, ShardMetadata>();
    this.dataIndex = new Map<string, DataIndexEntry>();
    this.storageNodes = [
      {
        id: 'node1',
        status: 'active',
        capacity: 1000000000,
        used: 0,
        path: path.join(this.config.storagePath, 'node1'),
      },
      {
        id: 'node2',
        status: 'active',
        capacity: 1000000000,
        used: 0,
        path: path.join(this.config.storagePath, 'node2'),
      },
      {
        id: 'node3',
        status: 'active',
        capacity: 1000000000,
        used: 0,
        path: path.join(this.config.storagePath, 'node3'),
      },
    ];

    // Initialize storage
    this.initialize();
  }

  /**
   * Initialize storage system
   */
  async initialize(): Promise<void> {
    try {
      // Create base storage directory if it doesn't exist
      await fs.mkdir(this.config.storagePath, { recursive: true });

      // Create storage node directories
      for (const node of this.storageNodes) {
        await fs.mkdir(node.path, { recursive: true });
      }

      // Create index directory
      await fs.mkdir(this.config.indexPath, { recursive: true });

      // Load existing index if available
      await this.loadIndex();

      console.log('Sharded storage system initialized');
    } catch (error) {
      console.error('Failed to initialize sharded storage:', error);
    }
  }

  /**
   * Load existing index from disk
   */
  async loadIndex(): Promise<void> {
    try {
      const indexFile = path.join(this.config.indexPath, 'data_index.json');

      if (await this.fileExists(indexFile)) {
        const indexData = await fs.readFile(indexFile, 'utf8');
        const parsed = JSON.parse(indexData);

        // Convert map entries
        this.dataIndex = new Map(Object.entries(parsed.dataIndex));
        this.shards = new Map(Object.entries(parsed.shards));

        console.log(
          `Loaded ${this.dataIndex.size} data entries and ${this.shards.size} shards from index`
        );
      }
    } catch (error) {
      console.error('Failed to load storage index:', error);
      // Initialize with empty maps
      this.dataIndex = new Map();
      this.shards = new Map();
    }
  }

  /**
   * Save index to disk
   */
  async saveIndex(): Promise<void> {
    try {
      const indexFile = path.join(this.config.indexPath, 'data_index.json');

      // Convert maps to objects for JSON serialization
      const indexData = {
        dataIndex: Object.fromEntries(this.dataIndex),
        shards: Object.fromEntries(this.shards),
      };

      await fs.writeFile(indexFile, JSON.stringify(indexData, null, 2));
    } catch (error) {
      console.error('Failed to save storage index:', error);
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Store data in sharded storage
   */
  async storeData(
    dataId: string | null,
    data: Buffer | string,
    metadata: Record<string, any> = {}
  ): Promise<string> {
    try {
      // Generate data ID if not provided
      if (!dataId) {
        dataId = `data-${crypto.randomBytes(16).toString('hex')}`;
      }

      // Ensure data is a buffer
      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Generate content hash
      const contentHash = crypto
        .createHash(this.config.hashAlgorithm)
        .update(dataBuffer)
        .digest('hex');

      // Create data metadata
      const dataMetadata: DataIndexEntry = {
        id: dataId,
        contentHash,
        size: dataBuffer.length,
        shardCount: 0,
        shards: [],
        created: Date.now(),
        updated: Date.now(),
        ...metadata,
      };

      // Split data into shards
      const shards = this.splitIntoShards(dataBuffer);
      dataMetadata.shardCount = shards.length;

      // Distribute shards to storage nodes
      for (let i = 0; i < shards.length; i++) {
        const shardMetadata = await this.storeShard(shards[i], dataId, i);
        dataMetadata.shards.push(shardMetadata.id);
      }

      // Update index
      this.dataIndex.set(dataId, dataMetadata);

      // Save index
      await this.saveIndex();

      return dataId;
    } catch (error) {
      console.error(`Failed to store data ${dataId}:`, error);
      throw error;
    }
  }

  /**
   * Split data into shards
   * @param {Buffer} dataBuffer - Data to split
   * @returns {Array<Buffer>} Array of data shards
   */
  splitIntoShards(dataBuffer: Buffer): Buffer[] {
    const shards: Buffer[] = [];
    const shardSize = this.config.shardSize;

    for (let i = 0; i < dataBuffer.length; i += shardSize) {
      const shard = dataBuffer.slice(
        i,
        Math.min(i + shardSize, dataBuffer.length)
      );
      shards.push(shard);
    }

    return shards;
  }

  /**
   * Store a single shard on storage nodes
   * @param {Buffer} shardData - Shard data
   * @param {string} dataId - Parent data ID
   * @param {number} shardIndex - Index of this shard in the data
   * @returns {Promise<ShardMetadata>} Shard metadata
   */
  async storeShard(
    shardData: Buffer,
    dataId: string,
    shardIndex: number
  ): Promise<ShardMetadata> {
    // Generate shard ID
    const shardId = `shard-${dataId}-${shardIndex}-${crypto.randomBytes(8).toString('hex')}`;

    // Generate content hash
    const contentHash = crypto
      .createHash(this.config.hashAlgorithm)
      .update(shardData)
      .digest('hex');

    // Create shard metadata
    const shardMetadata: ShardMetadata = {
      id: shardId,
      dataId,
      index: shardIndex,
      contentHash,
      size: shardData.length,
      created: Date.now(),
      locations: [], // Will contain node IDs and paths where the shard is stored
    };

    // Select storage nodes for this shard (based on replica count)
    const selectedNodes = this.selectStorageNodesForShard(shardMetadata);

    // Store replicas on selected nodes
    for (const node of selectedNodes) {
      const nodePath = path.join(node.path, shardId);

      try {
        await fs.writeFile(nodePath, shardData);

        // Update shard locations
        shardMetadata.locations.push({
          nodeId: node.id,
          path: nodePath,
        });

        // Update node usage
        node.used += shardData.length;
      } catch (error) {
        console.error(
          `Failed to store shard ${shardId} on node ${node.id}:`,
          error
        );
      }
    }

    // Update shards index
    this.shards.set(shardId, shardMetadata);

    return shardMetadata;
  }

  /**
   * Select storage nodes for a shard
   * @param {ShardMetadata} shardMetadata - Shard metadata
   * @returns {Array<StorageNode>} Selected storage nodes
   */
  selectStorageNodesForShard(shardMetadata: ShardMetadata): StorageNode[] {
    // Simple strategy: select nodes with most available space
    const availableNodes = this.storageNodes
      .filter(node => node.status === 'active')
      .sort((a, b) => b.capacity - b.used - (a.capacity - a.used));

    // Take the top N nodes based on replica count
    return availableNodes.slice(0, this.config.replicaCount);
  }

  /**
   * Retrieve data from sharded storage
   * @param {string} dataId - ID of the data to retrieve
   * @returns {Promise<{data: Buffer, metadata: DataIndexEntry}>} Retrieved data and metadata
   */
  async retrieveData(
    dataId: string
  ): Promise<{ data: Buffer; metadata: DataIndexEntry }> {
    try {
      // Get data metadata from index
      const dataMetadata = this.dataIndex.get(dataId);

      if (!dataMetadata) {
        throw new Error(`Data ${dataId} not found in storage index`);
      }

      // Retrieve and combine shards
      const shards: Buffer[] = [];

      for (const shardId of dataMetadata.shards) {
        const shardData = await this.retrieveShard(shardId);
        shards.push(shardData);
      }

      // Combine shards into a single buffer
      const combinedData = Buffer.concat(shards);

      // Verify data integrity with hash
      const contentHash = crypto
        .createHash(this.config.hashAlgorithm)
        .update(combinedData)
        .digest('hex');

      if (contentHash !== dataMetadata.contentHash) {
        console.warn(
          `Data integrity check failed for ${dataId}. Expected hash ${dataMetadata.contentHash} but got ${contentHash}`
        );
      }

      return {
        data: combinedData,
        metadata: dataMetadata,
      };
    } catch (error) {
      console.error(`Failed to retrieve data ${dataId}:`, error);
      throw error;
    }
  }

  /**
   * Retrieve a shard from storage
   * @param {string} shardId - ID of the shard to retrieve
   * @returns {Promise<Buffer>} Shard data
   */
  async retrieveShard(shardId: string): Promise<Buffer> {
    // Get shard metadata from index
    const shardMetadata = this.shards.get(shardId);

    if (!shardMetadata) {
      throw new Error(`Shard ${shardId} not found in storage index`);
    }

    // Try each location until we successfully retrieve the shard
    for (const location of shardMetadata.locations) {
      try {
        const shardData = await fs.readFile(location.path);

        // Verify shard integrity with hash
        const contentHash = crypto
          .createHash(this.config.hashAlgorithm)
          .update(shardData)
          .digest('hex');

        if (contentHash !== shardMetadata.contentHash) {
          console.warn(
            `Shard integrity check failed for ${shardId} at ${location.path}. Trying next replica.`
          );
          continue;
        }

        return shardData;
      } catch (error) {
        console.warn(
          `Failed to retrieve shard ${shardId} from ${location.path}:`,
          error
        );
      }
    }

    throw new Error(`Failed to retrieve shard ${shardId} from any location`);
  }

  /**
   * Delete data from sharded storage
   * @param {string} dataId - ID of the data to delete
   * @returns {Promise<boolean>} True if deletion was successful
   */
  async deleteData(dataId: string): Promise<boolean> {
    try {
      // Get data metadata from index
      const dataMetadata = this.dataIndex.get(dataId);

      if (!dataMetadata) {
        throw new Error(`Data ${dataId} not found in storage index`);
      }

      // Delete all shards
      for (const shardId of dataMetadata.shards) {
        await this.deleteShard(shardId);
      }

      // Remove from index
      this.dataIndex.delete(dataId);

      // Save index
      await this.saveIndex();

      return true;
    } catch (error) {
      console.error(`Failed to delete data ${dataId}:`, error);
      return false;
    }
  }

  /**
   * Delete a shard from storage
   * @param {string} shardId - ID of the shard to delete
   * @returns {Promise<boolean>} True if deletion was successful
   */
  async deleteShard(shardId: string): Promise<boolean> {
    // Get shard metadata from index
    const shardMetadata = this.shards.get(shardId);

    if (!shardMetadata) {
      return false;
    }

    // Delete from all locations
    for (const location of shardMetadata.locations) {
      try {
        await fs.unlink(location.path);

        // Update node usage
        const node = this.storageNodes.find(n => n.id === location.nodeId);
        if (node) {
          node.used -= shardMetadata.size;
        }
      } catch (error) {
        console.warn(
          `Failed to delete shard ${shardId} from ${location.path}:`,
          error
        );
      }
    }

    // Remove from index
    this.shards.delete(shardId);

    return true;
  }

  /**
   * List all data in the storage
   * @returns {Array<DataIndexEntry>} Array of data metadata objects
   */
  listAllData(): DataIndexEntry[] {
    return Array.from(this.dataIndex.values());
  }

  /**
   * Get storage node stats
   * @returns {Array<Object>} Array of storage node stats
   */
  getStorageStats(): Array<{
    id: string;
    status: string;
    capacity: number;
    used: number;
    free: number;
    utilization: number;
  }> {
    return this.storageNodes.map(node => ({
      id: node.id,
      status: node.status,
      capacity: node.capacity,
      used: node.used,
      free: node.capacity - node.used,
      utilization: Math.round((node.used / node.capacity) * 100),
    }));
  }

  /**
   * Check consistency of stored data
   * @returns {Promise<Object>} Consistency check results
   */
  async checkConsistency(): Promise<{
    dataChecked: number;
    dataCorrupted: number;
    shardsChecked: number;
    shardsCorrupted: number;
    shardsRepaired: number;
    details: Array<{
      type: string;
      id: string;
      location?: string;
      issue: string;
    }>;
  }> {
    const results = {
      dataChecked: 0,
      dataCorrupted: 0,
      shardsChecked: 0,
      shardsCorrupted: 0,
      shardsRepaired: 0,
      details: [] as Array<{
        type: string;
        id: string;
        location?: string;
        issue: string;
      }>,
    };

    // Check each data item - Use Array.from to fix iterator issue
    for (const [dataId, metadata] of Array.from(this.dataIndex.entries())) {
      results.dataChecked++;

      try {
        const { data } = await this.retrieveData(dataId);

        // Verify content hash
        const contentHash = crypto
          .createHash(this.config.hashAlgorithm)
          .update(data)
          .digest('hex');

        if (contentHash !== metadata.contentHash) {
          results.dataCorrupted++;
          results.details.push({
            type: 'data',
            id: dataId,
            issue: 'Content hash mismatch',
          });
        }
      } catch (error) {
        results.dataCorrupted++;
        results.details.push({
          type: 'data',
          id: dataId,
          issue: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Check each shard - Use Array.from to fix iterator issue
    for (const [shardId, metadata] of Array.from(this.shards.entries())) {
      results.shardsChecked++;

      try {
        // For each location
        for (const location of metadata.locations) {
          try {
            const shardData = await fs.readFile(location.path);

            // Verify content hash
            const contentHash = crypto
              .createHash(this.config.hashAlgorithm)
              .update(shardData)
              .digest('hex');

            if (contentHash !== metadata.contentHash) {
              results.shardsCorrupted++;
              results.details.push({
                type: 'shard',
                id: shardId,
                location: location.path,
                issue: 'Content hash mismatch',
              });

              // Try to repair from another replica
              await this.repairShard(shardId, location);
              results.shardsRepaired++;
            }
          } catch (error) {
            results.shardsCorrupted++;
            results.details.push({
              type: 'shard',
              id: shardId,
              location: location.path,
              issue: error instanceof Error ? error.message : String(error),
            });

            // Try to repair from another replica
            await this.repairShard(shardId, location);
            results.shardsRepaired++;
          }
        }
      } catch (error) {
        console.error(`Failed to check shard ${shardId}:`, error);
      }
    }

    return results;
  }

  /**
   * Repair a corrupted shard
   * @param {string} shardId - ID of the shard to repair
   * @param {Object} corruptedLocation - Location information for the corrupted shard
   */
  async repairShard(
    shardId: string,
    corruptedLocation: { nodeId: string; path: string }
  ): Promise<boolean> {
    const shardMetadata = this.shards.get(shardId);

    if (!shardMetadata) {
      throw new Error(`Shard ${shardId} not found in storage index`);
    }

    // Find a healthy replica
    for (const location of shardMetadata.locations) {
      // Skip the corrupted location
      if (location.nodeId === corruptedLocation.nodeId) {
        continue;
      }

      try {
        // Try to read from this replica
        const shardData = await fs.readFile(location.path);

        // Verify the replica
        const contentHash = crypto
          .createHash(this.config.hashAlgorithm)
          .update(shardData)
          .digest('hex');

        if (contentHash === shardMetadata.contentHash) {
          // Found a healthy replica, copy it to the corrupted location
          await fs.writeFile(corruptedLocation.path, shardData);
          console.log(
            `Repaired shard ${shardId} at ${corruptedLocation.path} from ${location.path}`
          );
          return true;
        }
      } catch (error) {
        console.warn(
          `Failed to read replica for repair from ${location.path}:`,
          error
        );
      }
    }

    console.error(
      `Could not repair shard ${shardId}, no healthy replicas found`
    );
    return false;
  }
}

// Create singleton instance
const shardedStorage = new ShardedStorageManager();

export { shardedStorage, DEFAULT_CONFIG };
export default shardedStorage;
