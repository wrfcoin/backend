/**
 * MockStorage for Cross-Chain API
 *
 * This is a simpler implementation of the storage interface that works with just
 * JavaScript instead of requiring TypeScript. It's used by the Cross-Chain API
 * for development and testing.
 */

interface CrossChainTransfer {
  id: number;
  fromChain: string;
  toChain: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  token: string;
  status: 'pending' | 'completed' | 'failed';
  transactionHash?: string;
  timestamp: number;
}

// In-memory storage for cross-chain transfers
const crossChainTransfers: CrossChainTransfer[] = [];
let nextCrossChainId = 1;

// Simple mock storage implementation
export const mockStorage = {
  /**
   * Get all cross-chain transfers
   * @param {string} status - Filter by status
   * @param {number} limit - Maximum number of results
   * @param {number} page - Page number
   * @returns {Promise<Array>} Matching transfers
   */
  getAllCrossChainTransfers: async (status, limit = 10, page = 1) => {
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    let results = [...crossChainTransfers];

    if (status) {
      results = results.filter(tx => tx.status === status);
    }

    return results.slice(startIndex, endIndex);
  },

  /**
   * Get count of cross-chain transfers
   * @param {string} status - Filter by status
   * @returns {Promise<number>} Count of matching transfers
   */
  getCrossChainTransfersCount: async status => {
    if (status) {
      return crossChainTransfers.filter(tx => tx.status === status).length;
    }
    return crossChainTransfers.length;
  },

  /**
   * Get a cross-chain transfer by ID
   * @param {number} id - Transfer ID
   * @returns {Promise<Object|undefined>} The transfer or undefined
   */
  getCrossChainTransferById: async id => {
    return crossChainTransfers.find(tx => tx.id === id);
  },

  /**
   * Get cross-chain transfers by sender address
   * @param {string} address - Sender address
   * @param {number} limit - Maximum number of results
   * @param {number} page - Page number
   * @returns {Promise<Array>} Matching transfers
   */
  getCrossChainTransfersBySender: async (address, limit = 10, page = 1) => {
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const results = crossChainTransfers.filter(
      tx => tx.fromAddress === address
    );

    return results.slice(startIndex, endIndex);
  },

  /**
   * Get count of cross-chain transfers by sender
   * @param {string} address - Sender address
   * @returns {Promise<number>} Count of matching transfers
   */
  getCrossChainTransfersBySenderCount: async address => {
    return crossChainTransfers.filter(tx => tx.fromAddress === address).length;
  },

  /**
   * Get cross-chain transfers by recipient address
   * @param {string} address - Recipient address
   * @param {number} limit - Maximum number of results
   * @param {number} page - Page number
   * @returns {Promise<Array>} Matching transfers
   */
  getCrossChainTransfersByRecipient: async (address, limit = 10, page = 1) => {
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const results = crossChainTransfers.filter(tx => tx.toAddress === address);

    return results.slice(startIndex, endIndex);
  },

  /**
   * Get count of cross-chain transfers by recipient
   * @param {string} address - Recipient address
   * @returns {Promise<number>} Count of matching transfers
   */
  getCrossChainTransfersByRecipientCount: async address => {
    return crossChainTransfers.filter(tx => tx.toAddress === address).length;
  },

  /**
   * Get cross-chain transfers by any address (sender or recipient)
   * @param {string} address - Address to search for
   * @param {number} limit - Maximum number of results
   * @param {number} page - Page number
   * @returns {Promise<Array>} Matching transfers
   */
  getCrossChainTransfersByAddress: async (address, limit = 10, page = 1) => {
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const results = crossChainTransfers.filter(
      tx => tx.fromAddress === address || tx.toAddress === address
    );

    return results.slice(startIndex, endIndex);
  },

  /**
   * Get count of cross-chain transfers by any address
   * @param {string} address - Address to search for
   * @returns {Promise<number>} Count of matching transfers
   */
  getCrossChainTransfersByAddressCount: async address => {
    return crossChainTransfers.filter(
      tx => tx.fromAddress === address || tx.toAddress === address
    ).length;
  },

  /**
   * Get cross-chain transfers between specific chains
   * @param {string} fromChain - Source chain
   * @param {string} toChain - Destination chain
   * @param {number} limit - Maximum number of results
   * @param {number} page - Page number
   * @returns {Promise<Array>} Matching transfers
   */
  getTransfersByChainPair: async (fromChain, toChain, limit = 10, page = 1) => {
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    const results = crossChainTransfers.filter(
      tx => tx.fromChain === fromChain && tx.toChain === toChain
    );

    return results.slice(startIndex, endIndex);
  },

  /**
   * Get count of cross-chain transfers between specific chains
   * @param {string} fromChain - Source chain
   * @param {string} toChain - Destination chain
   * @returns {Promise<number>} Count of matching transfers
   */
  getTransfersByChainPairCount: async (fromChain, toChain) => {
    return crossChainTransfers.filter(
      tx => tx.fromChain === fromChain && tx.toChain === toChain
    ).length;
  },

  /**
   * Create a new cross-chain transfer
   * @param {Object} transfer - Transfer data
   * @returns {Promise<Object>} Created transfer
   */
  createCrossChainTransfer: async transfer => {
    const newTransfer = {
      id: nextCrossChainId++,
      ...transfer,
      timestamp: Date.now(),
    };

    crossChainTransfers.push(newTransfer);
    return newTransfer;
  },

  /**
   * Update a cross-chain transfer
   * @param {number} id - Transfer ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated transfer
   */
  updateCrossChainTransfer: async (id, updates) => {
    const index = crossChainTransfers.findIndex(tx => tx.id === id);

    if (index === -1) {
      throw new Error(`Cross-chain transfer with ID ${id} not found`);
    }

    crossChainTransfers[index] = {
      ...crossChainTransfers[index],
      ...updates,
      timestamp: Date.now(),
    };

    return crossChainTransfers[index];
  },
};

export default mockStorage;
