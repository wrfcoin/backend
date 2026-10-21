/**
 * ERC-4626 Tokenized Vault Implementation for Wrfcoin
 *
 * This module provides utilities for implementing the ERC-4626 standard
 * for tokenized vaults in the Wrfcoin ecosystem. This enables standardized
 * yield-bearing tokens for staking, computational resources, and data validation.
 *
 * References:
 * - https://eips.ethereum.org/EIPS/eip-4626
 */

/**
 * Base class for creating ERC-4626 compatible vaults
 * Note: This is a simplified implementation focusing on the core concepts
 */
class TokenizedVault {
  constructor(assetToken, shareToken, name, symbol, decimals = 18) {
    this.asset = assetToken; // The underlying token (e.g., WRF)
    this.share = shareToken; // The vault share token (e.g., wWRF)
    this.name = name; // Name of the vault
    this.symbol = symbol; // Symbol of the vault share token
    this.decimals = decimals; // Decimals for the share token

    // Internal state
    this._totalAssets = 0;
    this._totalShares = 0;
    this._users = new Map();
  }

  /**
   * Returns the total amount of underlying assets managed by the vault
   * @returns {number} Total assets
   */
  totalAssets() {
    return this._totalAssets;
  }

  /**
   * Converts a given amount of underlying assets to vault shares
   * @param {number} assets - Amount of assets to convert
   * @returns {number} - Equivalent amount of shares
   */
  convertToShares(assets) {
    if (this._totalAssets === 0 || this._totalShares === 0) {
      return assets; // Initial 1:1 ratio
    }

    return (assets * this._totalShares) / this._totalAssets;
  }

  /**
   * Converts a given amount of vault shares to underlying assets
   * @param {number} shares - Amount of shares to convert
   * @returns {number} - Equivalent amount of assets
   */
  convertToAssets(shares) {
    if (this._totalShares === 0) {
      return shares; // Initial 1:1 ratio
    }

    return (shares * this._totalAssets) / this._totalShares;
  }

  /**
   * Maximum amount of assets that can be deposited for a receiver
   * @param {string} receiver - Address of the receiver
   * @returns {number} - Maximum deposit amount
   */
  maxDeposit(receiver) {
    // Default implementation: no limit
    return Number.MAX_SAFE_INTEGER;
  }

  /**
   * Preview of how many shares would be minted for a given asset deposit
   * @param {number} assets - Amount of assets to deposit
   * @returns {number} - Amount of shares that would be minted
   */
  previewDeposit(assets) {
    return this.convertToShares(assets);
  }

  /**
   * Deposit assets into the vault and receive shares
   * @param {number} assets - Amount of assets to deposit
   * @param {string} receiver - Address receiving the shares
   * @returns {number} - Amount of shares minted
   */
  deposit(assets, receiver) {
    // Check constraints
    if (assets <= 0) {
      throw new Error('Cannot deposit zero or negative assets');
    }

    if (assets > this.maxDeposit(receiver)) {
      throw new Error('Deposit amount exceeds maximum');
    }

    // Calculate shares to mint
    const shares = this.previewDeposit(assets);

    // Update internal state
    this._totalAssets += assets;
    this._totalShares += shares;

    // Update user balance
    const currentShares = this._users.get(receiver) || 0;
    this._users.set(receiver, currentShares + shares);

    return shares;
  }

  /**
   * Maximum amount of shares that can be minted for a receiver
   * @param {string} receiver - Address of the receiver
   * @returns {number} - Maximum mint amount
   */
  maxMint(receiver) {
    // Default implementation: no limit
    return Number.MAX_SAFE_INTEGER;
  }

  /**
   * Preview of how many assets would be needed to mint a given amount of shares
   * @param {number} shares - Amount of shares to mint
   * @returns {number} - Amount of assets needed
   */
  previewMint(shares) {
    if (this._totalShares === 0) {
      return shares; // Initial 1:1 ratio
    }

    return (shares * this._totalAssets) / this._totalShares;
  }

  /**
   * Mint shares in the vault by depositing assets
   * @param {number} shares - Amount of shares to mint
   * @param {string} receiver - Address receiving the shares
   * @returns {number} - Amount of assets deposited
   */
  mint(shares, receiver) {
    // Check constraints
    if (shares <= 0) {
      throw new Error('Cannot mint zero or negative shares');
    }

    if (shares > this.maxMint(receiver)) {
      throw new Error('Mint amount exceeds maximum');
    }

    // Calculate assets needed
    const assets = this.previewMint(shares);

    // Update internal state
    this._totalAssets += assets;
    this._totalShares += shares;

    // Update user balance
    const currentShares = this._users.get(receiver) || 0;
    this._users.set(receiver, currentShares + shares);

    return assets;
  }

  /**
   * Maximum amount of assets that can be withdrawn
   * @param {string} owner - Address of the owner
   * @returns {number} - Maximum withdrawal amount
   */
  maxWithdraw(owner) {
    const shares = this._users.get(owner) || 0;
    return this.convertToAssets(shares);
  }

  /**
   * Preview of how many shares would be burned for a given asset withdrawal
   * @param {number} assets - Amount of assets to withdraw
   * @returns {number} - Amount of shares that would be burned
   */
  previewWithdraw(assets) {
    if (this._totalAssets === 0) {
      return 0;
    }

    return (assets * this._totalShares) / this._totalAssets;
  }

  /**
   * Withdraw assets from the vault by burning shares
   * @param {number} assets - Amount of assets to withdraw
   * @param {string} receiver - Address receiving the assets
   * @param {string} owner - Address owning the shares
   * @returns {number} - Amount of shares burned
   */
  withdraw(assets, receiver, owner) {
    // Check constraints
    if (assets <= 0) {
      throw new Error('Cannot withdraw zero or negative assets');
    }

    if (assets > this.maxWithdraw(owner)) {
      throw new Error('Withdrawal amount exceeds maximum');
    }

    // Calculate shares to burn
    const shares = this.previewWithdraw(assets);

    // Update internal state
    this._totalAssets -= assets;
    this._totalShares -= shares;

    // Update user balance
    const currentShares = this._users.get(owner) || 0;
    if (currentShares < shares) {
      throw new Error('Insufficient shares');
    }
    this._users.set(owner, currentShares - shares);

    return shares;
  }

  /**
   * Maximum amount of shares that can be redeemed
   * @param {string} owner - Address of the owner
   * @returns {number} - Maximum redemption amount
   */
  maxRedeem(owner) {
    return this._users.get(owner) || 0;
  }

  /**
   * Preview of how many assets would be received for redeeming a given amount of shares
   * @param {number} shares - Amount of shares to redeem
   * @returns {number} - Amount of assets that would be received
   */
  previewRedeem(shares) {
    return this.convertToAssets(shares);
  }

  /**
   * Redeem shares from the vault for assets
   * @param {number} shares - Amount of shares to redeem
   * @param {string} receiver - Address receiving the assets
   * @param {string} owner - Address owning the shares
   * @returns {number} - Amount of assets withdrawn
   */
  redeem(shares, receiver, owner) {
    // Check constraints
    if (shares <= 0) {
      throw new Error('Cannot redeem zero or negative shares');
    }

    if (shares > this.maxRedeem(owner)) {
      throw new Error('Redemption amount exceeds maximum');
    }

    // Calculate assets to withdraw
    const assets = this.previewRedeem(shares);

    // Update internal state
    this._totalAssets -= assets;
    this._totalShares -= shares;

    // Update user balance
    const currentShares = this._users.get(owner) || 0;
    if (currentShares < shares) {
      throw new Error('Insufficient shares');
    }
    this._users.set(owner, currentShares - shares);

    return assets;
  }

  /**
   * Get the balance of shares for a user
   * @param {string} user - Address of the user
   * @returns {number} - Balance of shares
   */
  balanceOf(user) {
    return this._users.get(user) || 0;
  }

  /**
   * Get the asset value of a user's shares
   * @param {string} user - Address of the user
   * @returns {number} - Asset value of shares
   */
  getAssetValueOf(user) {
    const shares = this.balanceOf(user);
    return this.convertToAssets(shares);
  }
}

/**
 * Specialized vault for staking WRF tokens for network validation
 */
class ValidatorStakingVault extends TokenizedVault {
  constructor() {
    super('WRF', 'vWRF', 'Validator Staking Vault', 'vWRF');
    this.validatorRequirement = 10000; // Minimum WRF required to be a validator
    this.validators = new Map();
    this.rewardRate = 0.05; // 5% annual reward rate
    this.lastDistribution = Date.now();
  }

  /**
   * Special override: Validator staking requires a minimum amount
   * @param {string} receiver - Address of the receiver
   * @returns {number} - Maximum deposit amount
   */
  maxDeposit(receiver) {
    const currentStake = this.getAssetValueOf(receiver);
    // If they are already a validator, no upper limit
    if (currentStake >= this.validatorRequirement) {
      return Number.MAX_SAFE_INTEGER;
    }
    // Otherwise, limit to validator requirement
    return this.validatorRequirement;
  }

  /**
   * Register as a validator after staking the required amount
   * @param {string} user - Address of the user
   * @param {Object} validatorMetadata - Metadata about the validator
   * @returns {boolean} - Whether registration was successful
   */
  registerValidator(user, validatorMetadata) {
    const currentStake = this.getAssetValueOf(user);
    if (currentStake < this.validatorRequirement) {
      throw new Error('Insufficient stake to register as validator');
    }

    this.validators.set(user, {
      isActive: true,
      stake: currentStake,
      metadata: validatorMetadata,
      joinedAt: Date.now(),
    });

    return true;
  }

  /**
   * Distribute rewards to all validators based on their stake
   * @returns {Map<string, number>} - Map of validator addresses to rewards
   */
  distributeRewards() {
    const now = Date.now();
    const timeDiffInYears =
      (now - this.lastDistribution) / (365 * 24 * 60 * 60 * 1000);
    this.lastDistribution = now;

    const rewards = new Map();

    // Calculate rewards for each validator
    for (const [address, validator] of this.validators.entries()) {
      if (validator.isActive) {
        const reward = validator.stake * this.rewardRate * timeDiffInYears;
        rewards.set(address, reward);

        // Add rewards to their balance
        this._totalAssets += reward;
        const shares = this.convertToShares(reward);
        this._totalShares += shares;

        const currentShares = this._users.get(address) || 0;
        this._users.set(address, currentShares + shares);
      }
    }

    return rewards;
  }

  /**
   * Get all active validators
   * @returns {Array<Object>} - Array of validator objects
   */
  getActiveValidators() {
    const result = [];
    for (const [address, validator] of this.validators.entries()) {
      if (validator.isActive) {
        result.push({
          address,
          stake: validator.stake,
          metadata: validator.metadata,
          joinedAt: validator.joinedAt,
        });
      }
    }
    return result;
  }
}

/**
 * Specialized vault for computational resource staking
 */
class ComputationalResourceVault extends TokenizedVault {
  constructor() {
    super('WRF', 'cWRF', 'Computational Resource Vault', 'cWRF');
    this.computeNodes = new Map();
    this.rewardRate = 0.08; // 8% annual reward rate
    this.lastDistribution = Date.now();
    this.utilizationRate = 0.7; // 70% resource utilization
  }

  /**
   * Register as a computational node
   * @param {string} user - Address of the user
   * @param {Object} nodeMetadata - Metadata about the computational node
   * @returns {boolean} - Whether registration was successful
   */
  registerComputeNode(user, nodeMetadata) {
    const currentStake = this.getAssetValueOf(user);
    if (currentStake <= 0) {
      throw new Error('Must stake some assets to register as compute node');
    }

    this.computeNodes.set(user, {
      isActive: true,
      stake: currentStake,
      metadata: nodeMetadata,
      joinedAt: Date.now(),
      usageHistory: [],
      performance: 1.0, // Performance multiplier
    });

    return true;
  }

  /**
   * Record computational task completion for a node
   * @param {string} node - Address of the node
   * @param {Object} taskMetadata - Metadata about the completed task
   * @returns {number} - Performance score for this task
   */
  recordTaskCompletion(node, taskMetadata) {
    const nodeInfo = this.computeNodes.get(node);
    if (!nodeInfo || !nodeInfo.isActive) {
      throw new Error('Node is not registered or not active');
    }

    // Calculate a performance score (simplified)
    const performanceScore =
      taskMetadata.difficulty / taskMetadata.completionTime;

    // Update node's usage history
    nodeInfo.usageHistory.push({
      taskId: taskMetadata.taskId,
      timestamp: Date.now(),
      performanceScore,
      metadata: taskMetadata,
    });

    // Update node's overall performance (rolling average)
    const historicalScores = nodeInfo.usageHistory.map(h => h.performanceScore);
    nodeInfo.performance =
      historicalScores.reduce((a, b) => a + b, 0) / historicalScores.length;

    this.computeNodes.set(node, nodeInfo);

    return performanceScore;
  }

  /**
   * Distribute rewards to all compute nodes based on their stake and performance
   * @returns {Map<string, number>} - Map of node addresses to rewards
   */
  distributeRewards() {
    const now = Date.now();
    const timeDiffInYears =
      (now - this.lastDistribution) / (365 * 24 * 60 * 60 * 1000);
    this.lastDistribution = now;

    const rewards = new Map();

    // Calculate rewards for each compute node
    for (const [address, node] of this.computeNodes.entries()) {
      if (node.isActive) {
        // Reward is based on stake, performance multiplier, and utilization
        const reward =
          node.stake *
          this.rewardRate *
          timeDiffInYears *
          node.performance *
          this.utilizationRate;

        rewards.set(address, reward);

        // Add rewards to their balance
        this._totalAssets += reward;
        const shares = this.convertToShares(reward);
        this._totalShares += shares;

        const currentShares = this._users.get(address) || 0;
        this._users.set(address, currentShares + shares);
      }
    }

    return rewards;
  }

  /**
   * Get all active compute nodes
   * @returns {Array<Object>} - Array of compute node objects
   */
  getActiveComputeNodes() {
    const result = [];
    for (const [address, node] of this.computeNodes.entries()) {
      if (node.isActive) {
        result.push({
          address,
          stake: node.stake,
          metadata: node.metadata,
          joinedAt: node.joinedAt,
          performance: node.performance,
          taskCount: node.usageHistory.length,
        });
      }
    }
    return result;
  }
}

/**
 * Specialized vault for data storage providers
 */
class StorageProviderVault extends TokenizedVault {
  constructor() {
    super('WRF', 'sWRF', 'Storage Provider Vault', 'sWRF');
    this.storageProviders = new Map();
    this.rewardRate = 0.06; // 6% annual reward rate
    this.lastDistribution = Date.now();
  }

  /**
   * Register as a storage provider
   * @param {string} user - Address of the user
   * @param {Object} providerMetadata - Metadata about the storage provider
   * @returns {boolean} - Whether registration was successful
   */
  registerStorageProvider(user, providerMetadata) {
    const currentStake = this.getAssetValueOf(user);
    if (currentStake <= 0) {
      throw new Error('Must stake some assets to register as storage provider');
    }

    this.storageProviders.set(user, {
      isActive: true,
      stake: currentStake,
      metadata: providerMetadata,
      joinedAt: Date.now(),
      storedDataSets: [],
      totalStorage: providerMetadata.capacityGB || 0,
      usedStorage: 0,
      availability: 1.0, // Availability score (1.0 = 100%)
    });

    return true;
  }

  /**
   * Record dataset storage by a provider
   * @param {string} provider - Address of the provider
   * @param {Object} datasetMetadata - Metadata about the stored dataset
   * @returns {boolean} - Whether recording was successful
   */
  recordDatasetStorage(provider, datasetMetadata) {
    const providerInfo = this.storageProviders.get(provider);
    if (!providerInfo || !providerInfo.isActive) {
      throw new Error('Provider is not registered or not active');
    }

    // Check if there's enough storage space
    if (
      providerInfo.usedStorage + datasetMetadata.sizeGB >
      providerInfo.totalStorage
    ) {
      throw new Error('Insufficient storage space');
    }

    // Update provider's stored datasets
    providerInfo.storedDataSets.push({
      datasetId: datasetMetadata.datasetId,
      timestamp: Date.now(),
      sizeGB: datasetMetadata.sizeGB,
      metadata: datasetMetadata,
    });

    // Update used storage
    providerInfo.usedStorage += datasetMetadata.sizeGB;

    this.storageProviders.set(provider, providerInfo);

    return true;
  }

  /**
   * Update provider availability based on uptime monitoring
   * @param {string} provider - Address of the provider
   * @param {number} availabilityScore - New availability score (0.0-1.0)
   * @returns {boolean} - Whether update was successful
   */
  updateProviderAvailability(provider, availabilityScore) {
    const providerInfo = this.storageProviders.get(provider);
    if (!providerInfo || !providerInfo.isActive) {
      throw new Error('Provider is not registered or not active');
    }

    providerInfo.availability = Math.max(0, Math.min(1, availabilityScore));
    this.storageProviders.set(provider, providerInfo);

    return true;
  }

  /**
   * Distribute rewards to all storage providers based on stake, storage, and availability
   * @returns {Map<string, number>} - Map of provider addresses to rewards
   */
  distributeRewards() {
    const now = Date.now();
    const timeDiffInYears =
      (now - this.lastDistribution) / (365 * 24 * 60 * 60 * 1000);
    this.lastDistribution = now;

    const rewards = new Map();

    // Calculate rewards for each storage provider
    for (const [address, provider] of this.storageProviders.entries()) {
      if (provider.isActive) {
        // Reward is based on stake, storage utilization, and availability
        const storageUtilization =
          provider.totalStorage > 0
            ? provider.usedStorage / provider.totalStorage
            : 0;

        const reward =
          provider.stake *
          this.rewardRate *
          timeDiffInYears *
          provider.availability *
          (0.3 + 0.7 * storageUtilization);

        rewards.set(address, reward);

        // Add rewards to their balance
        this._totalAssets += reward;
        const shares = this.convertToShares(reward);
        this._totalShares += shares;

        const currentShares = this._users.get(address) || 0;
        this._users.set(address, currentShares + shares);
      }
    }

    return rewards;
  }

  /**
   * Get all active storage providers
   * @returns {Array<Object>} - Array of storage provider objects
   */
  getActiveStorageProviders() {
    const result = [];
    for (const [address, provider] of this.storageProviders.entries()) {
      if (provider.isActive) {
        result.push({
          address,
          stake: provider.stake,
          metadata: provider.metadata,
          joinedAt: provider.joinedAt,
          totalStorage: provider.totalStorage,
          usedStorage: provider.usedStorage,
          utilization:
            provider.totalStorage > 0
              ? provider.usedStorage / provider.totalStorage
              : 0,
          availability: provider.availability,
          datasetCount: provider.storedDataSets.length,
        });
      }
    }
    return result;
  }
}

// Export the classes
module.exports = {
  TokenizedVault,
  ValidatorStakingVault,
  ComputationalResourceVault,
  StorageProviderVault,
};
