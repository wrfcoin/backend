/**
 * Storage Adapter for JavaScript
 *
 * This module provides a consistent interface to database operations,
 * hiding the implementation details and ensuring proper field mapping.
 * It serves as an adapter between the application and the fixed database implementation.
 */

// Import the fixed database implementation
const db = require('./db-fixed');
const { storageLogger } = require('./utils/logger');

// Expose enum values for privacy levels
const PrivacyLevel = {
  STANDARD: 'STANDARD',
  ENHANCED: 'ENHANCED',
  MAXIMUM: 'MAXIMUM',
};

// Default security configuration
const DEFAULT_SECURITY_CONFIG = {
  mevProtection: true,
  privacyLevel: PrivacyLevel.STANDARD,
  activeProtection: true,
};

/**
 * Storage adapter class that provides a clean interface for database operations
 */
class StorageAdapter {
  /**
   * Get all computational NFTs with pagination
   * @param {number} limit Maximum number of NFTs to return
   * @param {number} page Page number for pagination
   * @returns {Promise<Array>} List of computational NFTs
   */
  async getAllComputationalNFTs(limit = 100, page = 1) {
    return db.getAllComputationalNFTs(limit, page);
  }

  /**
   * Get a computational NFT by ID
   * @param {number} id NFT ID
   * @returns {Promise<Object|null>} Computational NFT or null if not found
   */
  async getComputationalNFTById(id) {
    return db.getComputationalNFTById(id);
  }

  /**
   * Get computational NFTs by region
   * @param {string} regionCode Region code
   * @returns {Promise<Array>} List of computational NFTs in the region
   */
  async getNFTsByRegion(regionCode) {
    return db.getNFTsByRegion(regionCode);
  }

  /**
   * Create a computational NFT
   * @param {Object} nft NFT data object
   * @returns {Promise<Object|null>} Created NFT or null on error
   */
  async createComputationalNFT(nft) {
    // Add default values for required fields if they are missing
    const nftData = {
      ...nft,
      nftId: nft.nftId || `nft-${Math.random().toString(36).substring(2, 10)}`,
      name: nft.name || nft.title || 'Unnamed NFT',
      computationType: nft.computationType || 'GENERIC',
      computationComplexity: nft.computationComplexity || 1,
      region: nft.region || 'GLOBAL',
    };

    return db.createComputationalNFT(nftData);
  }

  /**
   * Update a computational NFT
   * @param {number} id NFT ID
   * @param {Object} updates Fields to update
   * @returns {Promise<Object|null>} Updated NFT or null on error
   */
  async updateComputationalNFT(id, updates) {
    return db.updateComputationalNFT(id, updates);
  }

  /**
   * Get all computational tasks with pagination
   * @param {number} limit Maximum number of tasks to return
   * @param {number} page Page number for pagination
   * @returns {Promise<Array>} List of computational tasks
   */
  async getAllComputationalTasks(limit = 100, page = 1) {
    return db.getAllComputationalTasks(limit, page);
  }

  /**
   * Get a computational task by ID
   * @param {number} id Task ID
   * @returns {Promise<Object|null>} Computational task or null if not found
   */
  async getComputationalTaskById(id) {
    return db.getComputationalTaskById(id);
  }

  /**
   * Get a computational task by task_id (string)
   * @param {string} taskId Task ID string
   * @returns {Promise<Object|null>} Computational task or null if not found
   */
  async getComputationalTaskByTaskId(taskId) {
    return db.getComputationalTaskByTaskId(taskId);
  }

  /**
   * Get computational tasks by NFT ID
   * @param {number} nftId NFT ID
   * @returns {Promise<Array>} List of computational tasks for the NFT
   */
  async getComputationalTasksByNFTId(nftId) {
    return db.getComputationalTasksByNFTId(nftId);
  }

  /**
   * Create a computational task
   * @param {Object} task Task data
   * @returns {Promise<Object|null>} Created task or null on error
   */
  async createComputationalTask(task) {
    // Add default values for required fields if they are missing
    const taskData = {
      ...task,
      taskId:
        task.taskId || `task-${Math.random().toString(36).substring(2, 10)}`,
      title: task.title || 'Unnamed Task',
      status: task.status || 'PENDING',
      priority: task.priority || 'MEDIUM',
    };

    return db.createComputationalTask(taskData);
  }

  /**
   * Update a computational task
   * @param {string} taskId Task ID string
   * @param {Object} updates Fields to update
   * @returns {Promise<Object|null>} Updated task or null on error
   */
  async updateComputationalTask(taskId, updates) {
    return db.updateComputationalTask(taskId, updates);
  }

  /**
   * Get optimal computational node for an NFT
   * @param {number} nftId NFT ID
   * @returns {Promise<Object|null>} Optimal node or null if not found
   */
  async getOptimalNodeForNFT(nftId) {
    return db.getOptimalNodeForNFT(nftId);
  }

  // User operations (stub implementation - these could be expanded as needed)
  async getUser(id) {
    try {
      const query = 'SELECT * FROM users WHERE id = $1';
      const results = await db.executeQuery(query, [id]);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      storageLogger.error('Error getting user', { module: 'StorageAdapter', operation: 'getUser', userId: id, error: error.message });
      return null;
    }
  }

  async getUserByUsername(username) {
    try {
      const query = 'SELECT * FROM users WHERE username = $1';
      const results = await db.executeQuery(query, [username]);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      storageLogger.error('Error getting user by username', { module: 'StorageAdapter', operation: 'getUserByUsername', username, error: error.message });
      return null;
    }
  }

  async createUser(userData) {
    try {
      const columns = Object.keys(userData).join(', ');
      const placeholders = Object.keys(userData)
        .map((_, i) => `$${i + 1}`)
        .join(', ');
      const values = Object.values(userData);

      const query = `
        INSERT INTO users (${columns})
        VALUES (${placeholders})
        RETURNING *
      `;

      const results = await db.executeQuery(query, values);
      return results[0];
    } catch (error) {
      storageLogger.error('Error creating user', { module: 'StorageAdapter', operation: 'createUser', error: error.message });
      throw error;
    }
  }
}

// Export a singleton instance
const storage = new StorageAdapter();
module.exports = storage;

// Export type definitions and utilities
module.exports.PrivacyLevel = PrivacyLevel;
module.exports.DEFAULT_SECURITY_CONFIG = DEFAULT_SECURITY_CONFIG;
module.exports.toDbFormat = db.toDbFormat;
module.exports.toAppFormat = db.toAppFormat;
