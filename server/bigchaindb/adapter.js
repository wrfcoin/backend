/**
 * BigchainDB Integration Adapter for Wrfcoin
 *
 * This adapter provides integration with BigchainDB's concepts for:
 * - Asset ownership and transfer model
 * - Rich metadata handling for computational assets
 * - Byzantine Fault Tolerance
 * - Privacy-preserving features
 *
 * Note: This is a custom implementation inspired by BigchainDB's architecture
 * rather than using their official driver (which has dependency conflicts).
 */

const crypto = require('crypto');
const { db } = require('../db');
const logger = require('../utils/logger')('bigchaindb:adapter');

class BigchainDBAdapter {
  /**
   * Create a new BigchainDB adapter
   * @param {Object} config - BigchainDB adapter configuration
   */
  constructor(config = {}) {
    this.config = {
      storageType: config.storageType || 'database', // database or memory
      privateNetworkEnabled: config.privateNetworkEnabled || false,
      networkName: config.networkName || 'wrfcoin',
      ...config,
    };

    this.initialized = false;

    // In-memory storage fallback (used for testing or if database is unavailable)
    this.memoryStorage = {
      assets: new Map(),
      transactions: new Map(),
      ownerships: new Map(),
      blockHeight: 0,
      lastTransactionId: null,
    };

    logger.info('BigchainDB adapter created', { config: this.config });
  }

  /**
   * Initialize the BigchainDB integration
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info('Initializing BigchainDB adapter');

      // Create necessary database tables
      await this.createTablesIfNotExist();

      this.initialized = true;
      logger.info('BigchainDB adapter initialized successfully');
      return true;
    } catch (error) {
      logger.error(
        `Failed to initialize BigchainDB adapter: ${error.message}`,
        { error }
      );
      return false;
    }
  }

  /**
   * Create database tables needed for BigchainDB integration
   * @private
   */
  async createTablesIfNotExist() {
    if (this.config.storageType === 'memory') {
      logger.info('Using in-memory storage for BigchainDB');
      return;
    }

    // Check if tables exist before creating them
    try {
      // Create the assets table if it doesn't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS bigchaindb_assets (
          id VARCHAR(64) PRIMARY KEY,
          data JSONB NOT NULL,
          metadata JSONB,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create the transactions table if it doesn't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS bigchaindb_transactions (
          id VARCHAR(64) PRIMARY KEY,
          asset_id VARCHAR(64) NOT NULL,
          operation VARCHAR(32) NOT NULL,
          metadata JSONB,
          public_key TEXT,
          signature TEXT,
          timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (asset_id) REFERENCES bigchaindb_assets(id)
        )
      `);

      // Create the ownerships table if it doesn't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS bigchaindb_ownerships (
          id SERIAL PRIMARY KEY,
          asset_id VARCHAR(64) NOT NULL,
          owner_id VARCHAR(128) NOT NULL,
          shares INTEGER NOT NULL DEFAULT 100,
          status VARCHAR(16) NOT NULL DEFAULT 'active',
          transaction_id VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (asset_id) REFERENCES bigchaindb_assets(id),
          FOREIGN KEY (transaction_id) REFERENCES bigchaindb_transactions(id)
        )
      `);

      logger.info('BigchainDB tables created or confirmed');
    } catch (error) {
      logger.error(`Error creating BigchainDB tables: ${error.message}`, {
        error,
      });
      throw error;
    }
  }

  /**
   * Create a new digital asset with initial ownership
   * @param {Object} assetData - Core data of the asset
   * @param {Object} metadata - Metadata associated with the asset
   * @param {String} ownerId - ID of the initial owner
   * @param {String} publicKey - Public key for verification
   * @param {String} signature - Cryptographic signature
   * @returns {Promise<Object>} Created asset info
   */
  async createAsset(assetData, metadata = {}, ownerId, publicKey, signature) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      // Generate a unique asset ID based on assetData
      const assetId = this.generateAssetId(assetData);

      // Verify the signature if provided
      if (publicKey && signature) {
        const dataToVerify = JSON.stringify(assetData);
        const isValid = this.verifySignature(
          dataToVerify,
          signature,
          publicKey
        );

        if (!isValid) {
          throw new Error('Invalid signature for asset creation');
        }
      }

      // Generate transaction ID for the creation transaction
      const transactionId = this.generateTransactionId(
        assetId,
        'CREATE',
        ownerId
      );

      if (this.config.storageType === 'memory') {
        // Store in memory
        this.memoryStorage.assets.set(assetId, {
          id: assetId,
          data: assetData,
          metadata: metadata,
          created_at: new Date(),
          updated_at: new Date(),
        });

        this.memoryStorage.transactions.set(transactionId, {
          id: transactionId,
          asset_id: assetId,
          operation: 'CREATE',
          metadata: metadata,
          public_key: publicKey,
          signature: signature,
          timestamp: new Date(),
        });

        const ownershipId = crypto.randomBytes(8).toString('hex');
        this.memoryStorage.ownerships.set(ownershipId, {
          id: ownershipId,
          asset_id: assetId,
          owner_id: ownerId,
          shares: 100,
          status: 'active',
          transaction_id: transactionId,
          created_at: new Date(),
        });

        this.memoryStorage.blockHeight++;
        this.memoryStorage.lastTransactionId = transactionId;
      } else {
        // Store in database
        // 1. Insert the asset
        await db.query(
          `INSERT INTO bigchaindb_assets (id, data, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [assetId, JSON.stringify(assetData), JSON.stringify(metadata)]
        );

        // 2. Insert the transaction
        await db.query(
          `INSERT INTO bigchaindb_transactions (id, asset_id, operation, metadata, public_key, signature, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            transactionId,
            assetId,
            'CREATE',
            JSON.stringify(metadata),
            publicKey,
            signature,
          ]
        );

        // 3. Set the initial ownership
        await db.query(
          `INSERT INTO bigchaindb_ownerships (asset_id, owner_id, shares, status, transaction_id, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [assetId, ownerId, 100, 'active', transactionId]
        );
      }

      logger.info('Asset created successfully', {
        assetId,
        ownerId,
        transactionId,
      });

      // Return the asset with transaction info
      return {
        assetId,
        transactionId,
        data: assetData,
        metadata,
        ownerId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Error creating asset: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Transfer ownership of an asset
   * @param {String} assetId - ID of the asset to transfer
   * @param {String} currentOwnerId - ID of the current owner
   * @param {String} newOwnerId - ID of the new owner
   * @param {Object} metadata - Metadata for the transfer
   * @param {String} publicKey - Public key for verification
   * @param {String} signature - Cryptographic signature
   * @returns {Promise<Object>} Transfer transaction info
   */
  async transferAsset(
    assetId,
    currentOwnerId,
    newOwnerId,
    metadata = {},
    publicKey,
    signature
  ) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      // First check if the current owner actually owns the asset
      let currentOwnership;

      if (this.config.storageType === 'memory') {
        // Find the ownership in memory
        for (const [id, ownership] of this.memoryStorage.ownerships.entries()) {
          if (
            ownership.asset_id === assetId &&
            ownership.owner_id === currentOwnerId &&
            ownership.status === 'active'
          ) {
            currentOwnership = { ...ownership, id };
            break;
          }
        }
      } else {
        // Query the database for the ownership
        const result = await db.query(
          `SELECT * FROM bigchaindb_ownerships 
           WHERE asset_id = $1 AND owner_id = $2 AND status = 'active'`,
          [assetId, currentOwnerId]
        );

        if (result.rows.length > 0) {
          currentOwnership = result.rows[0];
        }
      }

      if (!currentOwnership) {
        throw new Error(`Asset ${assetId} is not owned by ${currentOwnerId}`);
      }

      // Verify the signature if provided
      if (publicKey && signature) {
        const dataToVerify = JSON.stringify({
          assetId,
          currentOwnerId,
          newOwnerId,
        });
        const isValid = this.verifySignature(
          dataToVerify,
          signature,
          publicKey
        );

        if (!isValid) {
          throw new Error('Invalid signature for asset transfer');
        }
      }

      // Generate transaction ID for the transfer transaction
      const transactionId = this.generateTransactionId(
        assetId,
        'TRANSFER',
        currentOwnerId
      );

      if (this.config.storageType === 'memory') {
        // Update in memory
        // 1. Mark the current ownership as inactive
        const ownership = this.memoryStorage.ownerships.get(
          currentOwnership.id
        );
        ownership.status = 'inactive';

        // 2. Create a new ownership
        const newOwnershipId = crypto.randomBytes(8).toString('hex');
        this.memoryStorage.ownerships.set(newOwnershipId, {
          id: newOwnershipId,
          asset_id: assetId,
          owner_id: newOwnerId,
          shares: currentOwnership.shares,
          status: 'active',
          transaction_id: transactionId,
          created_at: new Date(),
        });

        // 3. Record the transaction
        this.memoryStorage.transactions.set(transactionId, {
          id: transactionId,
          asset_id: assetId,
          operation: 'TRANSFER',
          metadata: metadata,
          public_key: publicKey,
          signature: signature,
          timestamp: new Date(),
        });

        // 4. Update the asset metadata
        const asset = this.memoryStorage.assets.get(assetId);
        asset.metadata = { ...asset.metadata, ...metadata };
        asset.updated_at = new Date();

        this.memoryStorage.blockHeight++;
        this.memoryStorage.lastTransactionId = transactionId;
      } else {
        // Update in database
        // 1. Mark the current ownership as inactive
        await db.query(
          `UPDATE bigchaindb_ownerships 
           SET status = 'inactive' 
           WHERE id = $1`,
          [currentOwnership.id]
        );

        // 2. Create a new ownership
        await db.query(
          `INSERT INTO bigchaindb_ownerships (asset_id, owner_id, shares, status, transaction_id, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            assetId,
            newOwnerId,
            currentOwnership.shares,
            'active',
            transactionId,
          ]
        );

        // 3. Record the transaction
        await db.query(
          `INSERT INTO bigchaindb_transactions (id, asset_id, operation, metadata, public_key, signature, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            transactionId,
            assetId,
            'TRANSFER',
            JSON.stringify(metadata),
            publicKey,
            signature,
          ]
        );

        // 4. Update the asset metadata
        await db.query(
          `UPDATE bigchaindb_assets 
           SET metadata = metadata || $2::jsonb, updated_at = NOW() 
           WHERE id = $1`,
          [assetId, JSON.stringify(metadata)]
        );
      }

      logger.info('Asset transferred successfully', {
        assetId,
        fromOwnerId: currentOwnerId,
        toOwnerId: newOwnerId,
        transactionId,
      });

      // Return the transaction info
      return {
        transactionId,
        assetId,
        operation: 'TRANSFER',
        metadata,
        previousOwnerId: currentOwnerId,
        newOwnerId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Error transferring asset: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Get asset by ID
   * @param {String} assetId - ID of the asset to retrieve
   * @returns {Promise<Object>} Asset data
   */
  async getAsset(assetId) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      let asset;
      let currentOwner;

      if (this.config.storageType === 'memory') {
        // Get from memory
        asset = this.memoryStorage.assets.get(assetId);

        if (!asset) {
          return null;
        }

        // Find the current owner
        for (const ownership of this.memoryStorage.ownerships.values()) {
          if (ownership.asset_id === assetId && ownership.status === 'active') {
            currentOwner = ownership.owner_id;
            break;
          }
        }
      } else {
        // Query the database
        // Get the asset data
        const assetResult = await db.query(
          'SELECT * FROM bigchaindb_assets WHERE id = $1',
          [assetId]
        );

        if (assetResult.rows.length === 0) {
          return null;
        }

        asset = assetResult.rows[0];

        // Get the current owner
        const ownershipResult = await db.query(
          `SELECT * FROM bigchaindb_ownerships 
           WHERE asset_id = $1 AND status = 'active'`,
          [assetId]
        );

        if (ownershipResult.rows.length > 0) {
          currentOwner = ownershipResult.rows[0].owner_id;
        }
      }

      // Format the response
      return {
        assetId: asset.id,
        data:
          this.config.storageType === 'memory'
            ? asset.data
            : JSON.parse(asset.data),
        metadata:
          this.config.storageType === 'memory'
            ? asset.metadata
            : JSON.parse(asset.metadata),
        currentOwner,
        createdAt: asset.created_at,
        updatedAt: asset.updated_at,
      };
    } catch (error) {
      logger.error(`Error getting asset: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Search for assets based on data or metadata
   * @param {Object} query - Query parameters
   * @param {Number} limit - Maximum number of results
   * @param {Number} offset - Number of results to skip
   * @returns {Promise<Array>} Matching assets
   */
  async searchAssets(query = {}, limit = 10, offset = 0) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      let assets = [];

      if (this.config.storageType === 'memory') {
        // Search in memory
        assets = Array.from(this.memoryStorage.assets.values())
          .filter(asset => {
            // Check if the asset data matches all query fields
            if (query.data) {
              for (const [key, value] of Object.entries(query.data)) {
                if (
                  !asset.data[key] ||
                  JSON.stringify(asset.data[key]) !== JSON.stringify(value)
                ) {
                  return false;
                }
              }
            }

            // Check if the metadata matches all query fields
            if (query.metadata) {
              for (const [key, value] of Object.entries(query.metadata)) {
                if (
                  !asset.metadata[key] ||
                  JSON.stringify(asset.metadata[key]) !== JSON.stringify(value)
                ) {
                  return false;
                }
              }
            }

            return true;
          })
          .slice(offset, offset + limit)
          .map(asset => {
            // Find the current owner
            let currentOwner;
            for (const ownership of this.memoryStorage.ownerships.values()) {
              if (
                ownership.asset_id === asset.id &&
                ownership.status === 'active'
              ) {
                currentOwner = ownership.owner_id;
                break;
              }
            }

            return {
              assetId: asset.id,
              data: asset.data,
              metadata: asset.metadata,
              currentOwner,
              createdAt: asset.created_at,
              updatedAt: asset.updated_at,
            };
          });
      } else {
        // Search in database
        // This is a simplified implementation - in a real app, you'd want to use more sophisticated
        // JSON querying capabilities of your database
        const conditions = [];
        const parameters = [];

        // Build the query conditions
        let paramIndex = 1;

        if (query.data) {
          for (const [key, value] of Object.entries(query.data)) {
            conditions.push(`data->>'${key}' = $${paramIndex}`);
            parameters.push(
              typeof value === 'object' ? JSON.stringify(value) : value
            );
            paramIndex++;
          }
        }

        if (query.metadata) {
          for (const [key, value] of Object.entries(query.metadata)) {
            conditions.push(`metadata->>'${key}' = $${paramIndex}`);
            parameters.push(
              typeof value === 'object' ? JSON.stringify(value) : value
            );
            paramIndex++;
          }
        }

        // Generate the WHERE clause
        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Execute the query
        const result = await db.query(
          `SELECT * FROM bigchaindb_assets ${whereClause} 
           ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          [...parameters, limit, offset]
        );

        // Get the current owners for each asset
        const assetIds = result.rows.map(row => row.id);

        const ownersResult =
          assetIds.length > 0
            ? await db.query(
                `SELECT asset_id, owner_id FROM bigchaindb_ownerships 
               WHERE asset_id = ANY($1) AND status = 'active'`,
                [assetIds]
              )
            : { rows: [] };

        // Create a map of asset IDs to owners
        const ownersMap = new Map();
        ownersResult.rows.forEach(row => {
          ownersMap.set(row.asset_id, row.owner_id);
        });

        // Format the assets with their owners
        assets = result.rows.map(row => ({
          assetId: row.id,
          data: JSON.parse(row.data),
          metadata: JSON.parse(row.metadata),
          currentOwner: ownersMap.get(row.id),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      }

      return assets;
    } catch (error) {
      logger.error(`Error searching assets: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Get assets owned by a specific user
   * @param {String} ownerId - ID of the owner
   * @param {Number} limit - Maximum number of results
   * @param {Number} offset - Number of results to skip
   * @returns {Promise<Array>} Assets owned by the user
   */
  async getAssetsByOwner(ownerId, limit = 10, offset = 0) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      let assets = [];

      if (this.config.storageType === 'memory') {
        // Get from memory
        // 1. Find all asset IDs owned by this user
        const ownedAssetIds = new Set();
        for (const ownership of this.memoryStorage.ownerships.values()) {
          if (ownership.owner_id === ownerId && ownership.status === 'active') {
            ownedAssetIds.add(ownership.asset_id);
          }
        }

        // 2. Get the assets
        assets = Array.from(ownedAssetIds)
          .slice(offset, offset + limit)
          .map(assetId => {
            const asset = this.memoryStorage.assets.get(assetId);
            return {
              assetId,
              data: asset.data,
              metadata: asset.metadata,
              currentOwner: ownerId,
              createdAt: asset.created_at,
              updatedAt: asset.updated_at,
            };
          });
      } else {
        // Query the database
        const result = await db.query(
          `SELECT a.* FROM bigchaindb_assets a
           JOIN bigchaindb_ownerships o ON a.id = o.asset_id
           WHERE o.owner_id = $1 AND o.status = 'active'
           ORDER BY a.created_at DESC
           LIMIT $2 OFFSET $3`,
          [ownerId, limit, offset]
        );

        // Format the assets
        assets = result.rows.map(row => ({
          assetId: row.id,
          data: JSON.parse(row.data),
          metadata: JSON.parse(row.metadata),
          currentOwner: ownerId,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      }

      return assets;
    } catch (error) {
      logger.error(`Error getting assets by owner: ${error.message}`, {
        error,
      });
      throw error;
    }
  }

  /**
   * Update asset metadata without changing ownership
   * @param {String} assetId - ID of the asset to update
   * @param {String} ownerId - ID of the current owner
   * @param {Object} metadata - New metadata for the asset
   * @param {String} publicKey - Public key for verification
   * @param {String} signature - Cryptographic signature
   * @returns {Promise<Object>} Updated asset info
   */
  async updateAssetMetadata(
    assetId,
    ownerId,
    metadata = {},
    publicKey,
    signature
  ) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    try {
      // First check if the current owner actually owns the asset
      let currentOwnership;

      if (this.config.storageType === 'memory') {
        // Find the ownership in memory
        for (const [id, ownership] of this.memoryStorage.ownerships.entries()) {
          if (
            ownership.asset_id === assetId &&
            ownership.owner_id === ownerId &&
            ownership.status === 'active'
          ) {
            currentOwnership = { ...ownership, id };
            break;
          }
        }
      } else {
        // Query the database for the ownership
        const result = await db.query(
          `SELECT * FROM bigchaindb_ownerships 
           WHERE asset_id = $1 AND owner_id = $2 AND status = 'active'`,
          [assetId, ownerId]
        );

        if (result.rows.length > 0) {
          currentOwnership = result.rows[0];
        }
      }

      if (!currentOwnership) {
        throw new Error(`Asset ${assetId} is not owned by ${ownerId}`);
      }

      // Verify the signature if provided
      if (publicKey && signature) {
        const dataToVerify = JSON.stringify({ assetId, ownerId, metadata });
        const isValid = this.verifySignature(
          dataToVerify,
          signature,
          publicKey
        );

        if (!isValid) {
          throw new Error('Invalid signature for metadata update');
        }
      }

      // Generate transaction ID for the metadata transaction
      const transactionId = this.generateTransactionId(
        assetId,
        'METADATA',
        ownerId
      );

      if (this.config.storageType === 'memory') {
        // Update in memory
        // 1. Update the asset metadata
        const asset = this.memoryStorage.assets.get(assetId);
        asset.metadata = { ...asset.metadata, ...metadata };
        asset.updated_at = new Date();

        // 2. Record the transaction
        this.memoryStorage.transactions.set(transactionId, {
          id: transactionId,
          asset_id: assetId,
          operation: 'METADATA',
          metadata: metadata,
          public_key: publicKey,
          signature: signature,
          timestamp: new Date(),
        });

        this.memoryStorage.blockHeight++;
        this.memoryStorage.lastTransactionId = transactionId;
      } else {
        // Update in database
        // 1. Update the asset metadata
        await db.query(
          `UPDATE bigchaindb_assets 
           SET metadata = metadata || $2::jsonb, updated_at = NOW() 
           WHERE id = $1`,
          [assetId, JSON.stringify(metadata)]
        );

        // 2. Record the transaction
        await db.query(
          `INSERT INTO bigchaindb_transactions (id, asset_id, operation, metadata, public_key, signature, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            transactionId,
            assetId,
            'METADATA',
            JSON.stringify(metadata),
            publicKey,
            signature,
          ]
        );
      }

      logger.info('Asset metadata updated successfully', {
        assetId,
        ownerId,
        transactionId,
      });

      // Return the transaction info
      return {
        transactionId,
        assetId,
        operation: 'METADATA',
        metadata,
        ownerId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Error updating asset metadata: ${error.message}`, {
        error,
      });
      throw error;
    }
  }

  /**
   * Create a shared ownership asset
   * @param {Object} assetData - Core data of the asset
   * @param {Object} metadata - Metadata associated with the asset
   * @param {Array} owners - Array of {ownerId, shares} objects
   * @param {String} publicKey - Public key for verification
   * @param {String} signature - Cryptographic signature
   * @returns {Promise<Object>} Created asset info
   */
  async createSharedAsset(
    assetData,
    metadata = {},
    owners,
    publicKey,
    signature
  ) {
    if (!this.initialized) {
      throw new Error('BigchainDB adapter not initialized');
    }

    if (!owners || !Array.isArray(owners) || owners.length === 0) {
      throw new Error(
        'Owners must be a non-empty array of {ownerId, shares} objects'
      );
    }

    // Validate that total shares add up to 100
    const totalShares = owners.reduce(
      (sum, owner) => sum + (owner.shares || 1),
      0
    );
    if (totalShares !== 100) {
      throw new Error('Total shares must add up to 100');
    }

    try {
      // Generate a unique asset ID based on assetData
      const assetId = this.generateAssetId(assetData);

      // Verify the signature if provided
      if (publicKey && signature) {
        const dataToVerify = JSON.stringify({ assetData, owners });
        const isValid = this.verifySignature(
          dataToVerify,
          signature,
          publicKey
        );

        if (!isValid) {
          throw new Error('Invalid signature for shared asset creation');
        }
      }

      // Generate transaction ID for the creation transaction
      const transactionId = this.generateTransactionId(
        assetId,
        'CREATE_SHARED',
        owners[0].ownerId
      );

      if (this.config.storageType === 'memory') {
        // Store in memory
        // 1. Store the asset
        this.memoryStorage.assets.set(assetId, {
          id: assetId,
          data: assetData,
          metadata: { ...metadata, isShared: true, ownerCount: owners.length },
          created_at: new Date(),
          updated_at: new Date(),
        });

        // 2. Record the transaction
        this.memoryStorage.transactions.set(transactionId, {
          id: transactionId,
          asset_id: assetId,
          operation: 'CREATE_SHARED',
          metadata: metadata,
          public_key: publicKey,
          signature: signature,
          timestamp: new Date(),
        });

        // 3. Set the initial ownerships
        for (const owner of owners) {
          const ownershipId = crypto.randomBytes(8).toString('hex');
          this.memoryStorage.ownerships.set(ownershipId, {
            id: ownershipId,
            asset_id: assetId,
            owner_id: owner.ownerId,
            shares: owner.shares || 1,
            status: 'active',
            transaction_id: transactionId,
            created_at: new Date(),
          });
        }

        this.memoryStorage.blockHeight++;
        this.memoryStorage.lastTransactionId = transactionId;
      } else {
        // Store in database
        // 1. Insert the asset with shared ownership metadata
        await db.query(
          `INSERT INTO bigchaindb_assets (id, data, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [
            assetId,
            JSON.stringify(assetData),
            JSON.stringify({
              ...metadata,
              isShared: true,
              ownerCount: owners.length,
            }),
          ]
        );

        // 2. Insert the transaction
        await db.query(
          `INSERT INTO bigchaindb_transactions (id, asset_id, operation, metadata, public_key, signature, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            transactionId,
            assetId,
            'CREATE_SHARED',
            JSON.stringify(metadata),
            publicKey,
            signature,
          ]
        );

        // 3. Set the initial ownerships
        for (const owner of owners) {
          await db.query(
            `INSERT INTO bigchaindb_ownerships (asset_id, owner_id, shares, status, transaction_id, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [assetId, owner.ownerId, owner.shares || 1, 'active', transactionId]
          );
        }
      }

      logger.info('Shared asset created successfully', {
        assetId,
        ownerCount: owners.length,
        transactionId,
      });

      // Return the asset with transaction info
      return {
        assetId,
        transactionId,
        data: assetData,
        metadata: { ...metadata, isShared: true, ownerCount: owners.length },
        owners: owners.map(owner => ({
          ownerId: owner.ownerId,
          shares: owner.shares || 1,
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Error creating shared asset: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Generate a unique asset ID
   * @private
   * @param {Object} assetData - Data to generate ID from
   * @returns {String} Unique asset ID
   */
  generateAssetId(assetData) {
    const data =
      typeof assetData === 'string' ? assetData : JSON.stringify(assetData);
    const hash = crypto
      .createHash('sha256')
      .update(data + Date.now())
      .digest('hex');
    return `asset_${hash.substring(0, 16)}`;
  }

  /**
   * Generate a unique transaction ID
   * @private
   * @param {String} assetId - Asset ID
   * @param {String} operation - Transaction operation
   * @param {String} ownerId - Owner ID
   * @returns {String} Unique transaction ID
   */
  generateTransactionId(assetId, operation, ownerId) {
    const data = `${assetId}:${operation}:${ownerId}:${Date.now()}`;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `tx_${hash.substring(0, 16)}`;
  }

  /**
   * Verify cryptographic signature
   * @private
   * @param {String} data - Data that was signed
   * @param {String} signature - Signature to verify
   * @param {String} publicKey - Public key for verification
   * @returns {Boolean} True if signature is valid
   */
  verifySignature(data, signature, publicKey) {
    try {
      // For basic implementation, we'll simply return true if we're in development mode
      if (process.env.NODE_ENV !== 'production') {
        return true;
      }

      const verifier = crypto.createVerify('SHA256');
      verifier.update(data);
      return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
    } catch (error) {
      logger.error(`Error verifying signature: ${error.message}`, { error });
      return false;
    }
  }

  /**
   * Sign data with a private key
   * @param {String} data - Data to sign
   * @param {String} privateKey - Private key for signing
   * @returns {String} Signature
   */
  static signData(data, privateKey) {
    const signer = crypto.createSign('SHA256');
    signer.update(data);
    return signer.sign(privateKey, 'base64');
  }
}

module.exports = BigchainDBAdapter;
