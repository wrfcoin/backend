/**
 * Wrfcoin Validator Node
 *
 * This module defines the functionality for full validator nodes in the
 * Wrfcoin blockchain network. These specialized nodes are responsible for
 * maintaining consensus, validating transactions and blocks, and ensuring
 * the integrity of the blockchain.
 */

const crypto = require('crypto');
const { DataBlockType, GeoReferenceSystem } = require('./data-aware-block');

// Validator node modes
const ValidatorMode = {
  FULL: 'full', // Full validator with all capabilities
  CONSENSUS_ONLY: 'consensus', // Only participates in consensus
  ARCHIVE: 'archive', // Stores full blockchain history
  CHECKPOINT: 'checkpoint', // Stores and validates checkpoint blocks
  BOOTSTRAP: 'bootstrap', // Helps new nodes sync quickly
};

// Consensus mechanisms supported by the validator
const ConsensusMechanism = {
  PROOF_OF_WORK: 'pow', // Traditional Proof of Work
  PROOF_OF_STAKE: 'pos', // Proof of Stake
  PROOF_OF_PRESENCE: 'pop', // Proof of Presence (location-based)
  DELEGATED_POS: 'dpos', // Delegated Proof of Stake
  PROOF_OF_AUTHORITY: 'poa', // Proof of Authority
  PROOF_OF_LOCATION: 'pol', // Proof of Location
  PROOF_OF_IMPORTANCE: 'poi', // Proof of Importance (for weather data)
};

// Transaction types
const TransactionType = {
  REGULAR: 'regular', // Standard value transfer
  COMPUTATIONAL: 'computational', // Computational task submission/result
  STORAGE: 'storage', // Data storage request/confirmation
  GOVERNANCE: 'governance', // Network governance voting
  NFT: 'nft', // NFT minting/transfer
  STAKE: 'stake', // Staking tokens for validation
  UNSTAKE: 'unstake', // Unstaking tokens
  DELEGATE: 'delegate', // Delegating stake to validator
  REWARD: 'reward', // Block reward distribution
  SENSOR_DATA: 'sensor_data', // Weather sensor data submission
  FORECAST: 'forecast', // Weather forecast submission
  VERIFICATION: 'verification', // Verification of forecasts and data
  CROSS_CHAIN: 'cross_chain', // Cross-chain transfer
};

// Block types
const BlockType = {
  STANDARD: 'standard', // Standard block with transactions
  EMPTY: 'empty', // Empty block (no transactions)
  CHECKPOINT: 'checkpoint', // Checkpoint block (contains state hash)
  DATA_AWARE: 'data_aware', // Data-aware block with sensor data
  GOVERNANCE: 'governance', // Governance block with voting results
  COMPUTATIONAL: 'computational', // Computational block with results
};

// Validator Reputation Status
const ReputationStatus = {
  EXCELLENT: 'excellent', // Highest reputation
  GOOD: 'good', // Good reputation
  NEUTRAL: 'neutral', // Neutral reputation (new validators)
  PROBATION: 'probation', // On probation (minor issues)
  PENALIZED: 'penalized', // Penalized (serious issues)
};

// Validator node class
class ValidatorNode {
  constructor(options = {}) {
    this.nodeId = options.nodeId || `validator-${Date.now().toString(36)}`;
    this.nodeName = options.nodeName || 'Unnamed Validator Node';
    this.mode = options.mode || ValidatorMode.FULL;
    this.consensusMechanism =
      options.consensusMechanism || ConsensusMechanism.PROOF_OF_STAKE;
    this.operatorAddress = options.operatorAddress || this._generateAddress();
    this.geographicRegion = options.geographicRegion;
    this.geoCoordinates = options.geoCoordinates; // For PoP/PoL validators
    this.geoPrecision = options.geoPrecision || 2; // Precision level of location claims
    this.stake = options.stake || 0;
    this.delegatedStake = options.delegatedStake || 0;
    this.status = options.status || 'online';
    this.version = options.version || '1.0.0';
    this.supportedBlockTypes = options.supportedBlockTypes || [
      BlockType.STANDARD,
      BlockType.EMPTY,
      BlockType.CHECKPOINT,
    ];
    this.supportedTransactionTypes =
      options.supportedTransactionTypes || Object.values(TransactionType);
    this.specializations = options.specializations || [];
    this.uptime = options.uptime || 100;
    this.lastSeen = options.lastSeen || new Date().toISOString();
    this.reputation = options.reputation || {
      score: 1.0,
      status: ReputationStatus.NEUTRAL,
      blocksMined: 0,
      blocksValidated: 0,
      slashingEvents: 0,
      lastUpdated: new Date().toISOString(),
    };
    this.endpoints = options.endpoints || {
      api: `https://api.wrfcoin.net/validator/${this.nodeId}`,
      p2p: `wss://p2p.wrfcoin.net/validator/${this.nodeId}`,
    };
    this.resources = options.resources || {
      cpu: {
        cores: 8,
        utilization: 0,
      },
      memory: {
        totalMB: 16384,
        usedMB: 0,
      },
      storage: {
        totalGB: 1000,
        usedGB: 0,
      },
      bandwidth: {
        maxMbps: 1000,
        usedMbps: 0,
      },
    };

    // Internal state
    this.pendingTransactions = [];
    this.proposedBlocks = [];
    this.validatedBlocks = [];
    this.currentEpoch = options.currentEpoch || 1;
    this.currentSlot = options.currentSlot || 1;
    this.chainHeight = options.chainHeight || 0;
    this.syncStatus = options.syncStatus || {
      isSynced: true,
      currentBlock: 0,
      highestBlock: 0,
      syncStartTime: null,
      syncSpeed: 0, // blocks per second
    };
    this.peers = options.peers || [];
    this.voteHistory = [];
    this.rewardHistory = [];
    this.pendingRewards = 0;
    this.delegators = [];

    // Data-aware block support
    this.dataAwareBlockStorage = {
      totalDataPoints: 0,
      dataTypes: {},
      indexedRegions: {},
    };
  }

  // Internal method to generate a sample address
  _generateAddress() {
    return `wxm${crypto.randomBytes(20).toString('hex')}`;
  }

  // Connect to the blockchain network
  async connect(networkInfo) {
    // Simulate connection process
    await new Promise(resolve => setTimeout(resolve, 500));

    if (!networkInfo.networkId) {
      return {
        success: false,
        error: 'Invalid network information',
      };
    }

    // Update sync status
    this.syncStatus = {
      isSynced: false,
      currentBlock: 0,
      highestBlock: networkInfo.blockHeight || 0,
      syncStartTime: new Date().toISOString(),
      syncSpeed: 0,
    };

    return {
      success: true,
      message: `Connected to Wrfcoin ${networkInfo.networkName} network`,
      networkId: networkInfo.networkId,
    };
  }

  // Synchronize with the blockchain
  async synchronize() {
    if (this.syncStatus.isSynced) {
      return {
        success: true,
        message: 'Node already synchronized',
        blockHeight: this.chainHeight,
      };
    }

    // Simulate sync process
    const blocksToSync =
      this.syncStatus.highestBlock - this.syncStatus.currentBlock;
    const syncTimeMs = Math.min(blocksToSync * 10, 2000); // Faster for simulation

    await new Promise(resolve => setTimeout(resolve, syncTimeMs));

    // Update sync status
    this.chainHeight = this.syncStatus.highestBlock;
    this.syncStatus = {
      isSynced: true,
      currentBlock: this.syncStatus.highestBlock,
      highestBlock: this.syncStatus.highestBlock,
      syncStartTime: this.syncStatus.syncStartTime,
      syncSpeed: blocksToSync / (syncTimeMs / 1000),
    };

    return {
      success: true,
      message: `Synchronized ${blocksToSync} blocks`,
      blockHeight: this.chainHeight,
      syncSpeed: `${this.syncStatus.syncSpeed.toFixed(2)} blocks/second`,
    };
  }

  // Process a new transaction
  async processTransaction(transaction) {
    // Basic validation
    if (!transaction.id || !transaction.type) {
      return {
        success: false,
        error: 'Invalid transaction format',
      };
    }

    // Check if transaction type is supported
    if (!this.supportedTransactionTypes.includes(transaction.type)) {
      return {
        success: false,
        error: `Transaction type '${transaction.type}' not supported by this validator`,
      };
    }

    // Transaction signature verification would happen here

    // Check for double-spend
    const existingTx = this.pendingTransactions.find(
      tx => tx.id === transaction.id
    );
    if (existingTx) {
      return {
        success: false,
        error: 'Transaction already in pending pool',
      };
    }

    // Add to pending transactions
    this.pendingTransactions.push({
      ...transaction,
      receivedAt: new Date().toISOString(),
      status: 'pending',
    });

    return {
      success: true,
      transactionId: transaction.id,
      status: 'pending',
      message: 'Transaction accepted and pending confirmation',
    };
  }

  // Create and propose a new block
  async proposeBlock() {
    // Check if we have pending transactions
    if (this.pendingTransactions.length === 0) {
      return {
        success: false,
        error: 'No pending transactions to include in block',
      };
    }

    // Select transactions for the block (in a real system, we'd optimize this)
    const selectedTransactions = this.pendingTransactions.slice(0, 10);

    // Create block header
    const blockId = `block-${Date.now().toString(36)}`;
    const previousBlockHash = crypto
      .createHash('sha256')
      .update(`block-${this.chainHeight}`)
      .digest('hex');

    // Create block
    const block = {
      blockId,
      blockNumber: this.chainHeight + 1,
      timestamp: new Date().toISOString(),
      type: BlockType.STANDARD,
      previousBlockHash,
      merkleRoot: this._calculateMerkleRoot(selectedTransactions),
      transactions: selectedTransactions,
      transactionCount: selectedTransactions.length,
      validator: this.nodeId,
      signature: this._generateSignature(blockId),
    };

    // Add difficulty and nonce for PoW
    if (this.consensusMechanism === ConsensusMechanism.PROOF_OF_WORK) {
      // In a real implementation, we would actually mine the block
      block.difficulty = 5;
      // Use crypto.randomBytes for PoW nonce — not consensus-deterministic,
      // each miner independently searches for valid nonces.
      block.nonce = crypto.readUInt32BE
        ? crypto.randomBytes(4).readUInt32BE(0) % 1000000
        : parseInt(crypto.randomBytes(4).toString('hex'), 16) % 1000000;
    }

    // Add stake info for PoS
    if (
      this.consensusMechanism === ConsensusMechanism.PROOF_OF_STAKE ||
      this.consensusMechanism === ConsensusMechanism.DELEGATED_POS
    ) {
      block.stake = this.stake + this.delegatedStake;
      // Compute stake age from the validator's join timestamp (days since last proposed block or join)
      const lastProposedTime = this.proposedBlocks.length > 0
        ? new Date(this.proposedBlocks[this.proposedBlocks.length - 1].timestamp).getTime()
        : new Date(this.lastSeen).getTime();
      block.stakeAge = Math.max(0, Math.floor((Date.now() - lastProposedTime) / (24 * 60 * 60 * 1000)));
    }

    // Add location proofs for PoP/PoL
    if (
      this.consensusMechanism === ConsensusMechanism.PROOF_OF_PRESENCE ||
      this.consensusMechanism === ConsensusMechanism.PROOF_OF_LOCATION
    ) {
      block.locationProof = {
        coordinates: this.geoCoordinates,
        timestamp: new Date().toISOString(),
        precision: this.geoPrecision,
        attestation: this._generateLocationAttestation(),
      };
    }

    // Calculate block hash
    block.blockHash = this._calculateBlockHash(block);

    // Add to proposed blocks
    this.proposedBlocks.push(block);

    // Remove the transactions from pending pool
    this.pendingTransactions = this.pendingTransactions.filter(
      tx => !selectedTransactions.some(selected => selected.id === tx.id)
    );

    return {
      success: true,
      blockId: block.blockId,
      blockNumber: block.blockNumber,
      transactionCount: block.transactionCount,
      blockHash: block.blockHash,
    };
  }

  // Create a checkpoint block
  async createCheckpointBlock() {
    if (!this.supportedBlockTypes.includes(BlockType.CHECKPOINT)) {
      return {
        success: false,
        error: 'This validator does not support checkpoint blocks',
      };
    }

    // Create checkpoint block
    const blockId = `checkpoint-${Date.now().toString(36)}`;
    const previousBlockHash = crypto
      .createHash('sha256')
      .update(`block-${this.chainHeight}`)
      .digest('hex');

    // Simulate state root calculation
    const stateRoot = crypto
      .createHash('sha256')
      .update(`state-${this.chainHeight}`)
      .digest('hex');

    // Create block
    const block = {
      blockId,
      blockNumber: this.chainHeight + 1,
      timestamp: new Date().toISOString(),
      type: BlockType.CHECKPOINT,
      previousBlockHash,
      stateRoot,
      checkpointHeight: this.chainHeight + 1,
      validator: this.nodeId,
      signature: this._generateSignature(blockId),
    };

    // Calculate block hash
    block.blockHash = this._calculateBlockHash(block);

    // Add to proposed blocks
    this.proposedBlocks.push(block);

    return {
      success: true,
      blockId: block.blockId,
      blockNumber: block.blockNumber,
      blockType: block.type,
      blockHash: block.blockHash,
    };
  }

  // Create a data-aware block for weather data
  async createDataAwareBlock(dataEntries) {
    if (!this.supportedBlockTypes.includes(BlockType.DATA_AWARE)) {
      return {
        success: false,
        error: 'This validator does not support data-aware blocks',
      };
    }

    if (!dataEntries || dataEntries.length === 0) {
      return {
        success: false,
        error: 'No data entries provided',
      };
    }

    // Create data-aware block
    const blockId = `data-${Date.now().toString(36)}`;
    const previousBlockHash = crypto
      .createHash('sha256')
      .update(`block-${this.chainHeight}`)
      .digest('hex');

    // Process data entries
    const processedEntries = dataEntries.map(entry => {
      // Create data hash
      const dataHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(entry.data))
        .digest('hex');

      // Add data to storage
      this._addDataToStorage(entry);

      return {
        ...entry,
        dataHash,
        validatedAt: new Date().toISOString(),
        validator: this.nodeId,
      };
    });

    // Create data Merkle root
    const dataMerkleRoot = this._calculateMerkleRoot(
      processedEntries.map(e => e.dataHash)
    );

    // Create block
    const block = {
      blockId,
      blockNumber: this.chainHeight + 1,
      timestamp: new Date().toISOString(),
      type: BlockType.DATA_AWARE,
      previousBlockHash,
      dataMerkleRoot,
      dataEntries: processedEntries,
      dataEntryCount: processedEntries.length,
      geoReference: GeoReferenceSystem.WGS84,
      validator: this.nodeId,
      signature: this._generateSignature(blockId),
    };

    // Calculate block hash
    block.blockHash = this._calculateBlockHash(block);

    // Add to proposed blocks
    this.proposedBlocks.push(block);

    return {
      success: true,
      blockId: block.blockId,
      blockNumber: block.blockNumber,
      blockType: block.type,
      dataEntryCount: block.dataEntryCount,
      blockHash: block.blockHash,
    };
  }

  // Add data to internal storage
  _addDataToStorage(dataEntry) {
    this.dataAwareBlockStorage.totalDataPoints++;

    // Track data types
    const dataType = dataEntry.dataType || 'unknown';
    if (!this.dataAwareBlockStorage.dataTypes[dataType]) {
      this.dataAwareBlockStorage.dataTypes[dataType] = 0;
    }
    this.dataAwareBlockStorage.dataTypes[dataType]++;

    // Track geographic regions
    if (dataEntry.geoBounds) {
      const region = JSON.stringify(dataEntry.geoBounds);
      if (!this.dataAwareBlockStorage.indexedRegions[region]) {
        this.dataAwareBlockStorage.indexedRegions[region] = 0;
      }
      this.dataAwareBlockStorage.indexedRegions[region]++;
    }
  }

  // Validate a block proposed by another validator
  async validateBlock(block) {
    // Check if block type is supported
    if (!this.supportedBlockTypes.includes(block.type)) {
      return {
        success: false,
        error: `Block type '${block.type}' not supported by this validator`,
      };
    }

    // Verify previous block hash
    const expectedPrevHash = crypto
      .createHash('sha256')
      .update(`block-${block.blockNumber - 1}`)
      .digest('hex');

    if (block.previousBlockHash !== expectedPrevHash) {
      return {
        success: false,
        error: 'Previous block hash mismatch',
      };
    }

    // Verify transactions if standard block
    if (block.type === BlockType.STANDARD) {
      // Verify transaction Merkle root
      const calculatedMerkleRoot = this._calculateMerkleRoot(
        block.transactions
      );
      if (block.merkleRoot !== calculatedMerkleRoot) {
        return {
          success: false,
          error: 'Transaction Merkle root mismatch',
        };
      }

      // Normally we'd also verify each transaction
    }

    // Verify data if data-aware block
    if (block.type === BlockType.DATA_AWARE) {
      // Verify data Merkle root
      const calculatedMerkleRoot = this._calculateMerkleRoot(
        block.dataEntries.map(e => e.dataHash)
      );
      if (block.dataMerkleRoot !== calculatedMerkleRoot) {
        return {
          success: false,
          error: 'Data Merkle root mismatch',
        };
      }

      // Data validation logic would go here
    }

    // Verify consensus mechanism specific data
    if (this.consensusMechanism === ConsensusMechanism.PROOF_OF_WORK) {
      // Verify PoW work
      // In reality, we'd check the hash meets difficulty target
      if (!block.nonce || !block.difficulty) {
        return {
          success: false,
          error: 'Missing PoW data (nonce or difficulty)',
        };
      }
    }

    if (this.consensusMechanism === ConsensusMechanism.PROOF_OF_STAKE) {
      // Verify stake
      if (!block.stake || block.stake <= 0) {
        return {
          success: false,
          error: 'Invalid stake amount',
        };
      }
    }

    if (this.consensusMechanism === ConsensusMechanism.PROOF_OF_PRESENCE) {
      // Verify location proof
      if (!block.locationProof || !block.locationProof.coordinates) {
        return {
          success: false,
          error: 'Missing location proof',
        };
      }
    }

    // Verify block hash
    const calculatedBlockHash = this._calculateBlockHash(block);
    if (block.blockHash !== calculatedBlockHash) {
      return {
        success: false,
        error: 'Block hash mismatch',
      };
    }

    // Add to validated blocks
    this.validatedBlocks.push(block);
    this.reputation.blocksValidated++;

    // Update chain height if this is the next block
    if (block.blockNumber === this.chainHeight + 1) {
      this.chainHeight = block.blockNumber;
    }

    return {
      success: true,
      blockId: block.blockId,
      blockNumber: block.blockNumber,
      validatedBy: this.nodeId,
      message: 'Block validated successfully',
    };
  }

  // Cast vote for governance proposals
  async castVote(proposalId, vote) {
    const voteRecord = {
      proposalId,
      vote,
      timestamp: new Date().toISOString(),
      validator: this.nodeId,
      stake: this.stake + this.delegatedStake,
      signature: this._generateSignature(`vote-${proposalId}`),
    };

    this.voteHistory.push(voteRecord);

    return {
      success: true,
      proposalId,
      vote,
      weight: this.stake + this.delegatedStake,
    };
  }

  // Delegate stake to another validator (for PoS and DPoS)
  async delegateStake(amount, toValidator) {
    if (amount <= 0 || amount > this.stake) {
      return {
        success: false,
        error: `Invalid delegation amount. Available stake: ${this.stake}`,
      };
    }

    // Reduce own stake and record delegation
    this.stake -= amount;

    const delegation = {
      to: toValidator,
      amount,
      timestamp: new Date().toISOString(),
      signature: this._generateSignature(`delegate-${toValidator}-${amount}`),
    };

    return {
      success: true,
      amount,
      toValidator,
      remainingStake: this.stake,
      delegation,
    };
  }

  // Receive delegation from another validator (for PoS and DPoS)
  async receiveDelegation(fromValidator, amount) {
    if (amount <= 0) {
      return {
        success: false,
        error: 'Invalid delegation amount',
      };
    }

    this.delegatedStake += amount;

    const delegator = {
      from: fromValidator,
      amount,
      receivedAt: new Date().toISOString(),
    };

    this.delegators.push(delegator);

    return {
      success: true,
      fromValidator,
      amount,
      totalDelegatedStake: this.delegatedStake,
    };
  }

  // Claim pending rewards
  async claimRewards() {
    if (this.pendingRewards <= 0) {
      return {
        success: false,
        error: 'No pending rewards to claim',
      };
    }

    const claimedAmount = this.pendingRewards;

    // Create reward record
    const rewardRecord = {
      amount: claimedAmount,
      timestamp: new Date().toISOString(),
      blocksValidated: this.reputation.blocksValidated,
      blocksMined: this.reputation.blocksMined,
    };

    this.rewardHistory.push(rewardRecord);
    this.pendingRewards = 0;

    return {
      success: true,
      amount: claimedAmount,
      message: 'Rewards claimed successfully',
    };
  }

  // Update node reputation
  updateReputation(update) {
    const oldScore = this.reputation.score;
    const oldStatus = this.reputation.status;

    // Apply score change
    if (update.scoreChange) {
      this.reputation.score = Math.max(
        0,
        Math.min(5, this.reputation.score + update.scoreChange)
      );
    }

    // Apply status change
    if (update.status) {
      this.reputation.status = update.status;
    } else {
      // Determine status based on score
      if (this.reputation.score >= 4.5) {
        this.reputation.status = ReputationStatus.EXCELLENT;
      } else if (this.reputation.score >= 3.5) {
        this.reputation.status = ReputationStatus.GOOD;
      } else if (this.reputation.score >= 2.0) {
        this.reputation.status = ReputationStatus.NEUTRAL;
      } else if (this.reputation.score >= 1.0) {
        this.reputation.status = ReputationStatus.PROBATION;
      } else {
        this.reputation.status = ReputationStatus.PENALIZED;
      }
    }

    // Apply slashing event
    if (update.slashEvent) {
      this.reputation.slashingEvents++;

      // Apply stake reduction if this is a slashing event
      if (update.stakeReduction && update.stakeReduction > 0) {
        const reduction = Math.min(this.stake, update.stakeReduction);
        this.stake -= reduction;
      }
    }

    // Update timestamp
    this.reputation.lastUpdated = new Date().toISOString();

    return {
      success: true,
      oldScore,
      newScore: this.reputation.score,
      oldStatus,
      newStatus: this.reputation.status,
    };
  }

  // Get node status
  getStatus() {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      mode: this.mode,
      consensusMechanism: this.consensusMechanism,
      status: this.status,
      version: this.version,
      stake: this.stake,
      delegatedStake: this.delegatedStake,
      chainHeight: this.chainHeight,
      pendingTransactions: this.pendingTransactions.length,
      isSynced: this.syncStatus.isSynced,
      reputation: {
        score: this.reputation.score,
        status: this.reputation.status,
        blocksMined: this.reputation.blocksMined,
        blocksValidated: this.reputation.blocksValidated,
      },
      resources: {
        cpu: `${this.resources.cpu.utilization}/${this.resources.cpu.cores} cores`,
        memory: `${this.resources.memory.usedMB}/${this.resources.memory.totalMB} MB`,
        storage: `${this.resources.storage.usedGB}/${this.resources.storage.totalGB} GB`,
        bandwidth: `${this.resources.bandwidth.usedMbps}/${this.resources.bandwidth.maxMbps} Mbps`,
      },
      dataAwareStorage: {
        totalDataPoints: this.dataAwareBlockStorage.totalDataPoints,
        dataTypeCount: Object.keys(this.dataAwareBlockStorage.dataTypes).length,
        indexedRegions: Object.keys(this.dataAwareBlockStorage.indexedRegions)
          .length,
      },
      uptime: this.uptime,
      lastSeen: this.lastSeen,
      peers: this.peers.length,
    };
  }

  // Helper method to calculate Merkle root
  _calculateMerkleRoot(items) {
    if (!items || items.length === 0) {
      return crypto.createHash('sha256').update('empty').digest('hex');
    }

    // For simplicity, hash all items together
    // In a real implementation, we would build a proper Merkle tree
    const combinedString = items
      .map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object') return JSON.stringify(item);
        return String(item);
      })
      .join('|');

    return crypto.createHash('sha256').update(combinedString).digest('hex');
  }

  // Helper method to calculate block hash
  _calculateBlockHash(block) {
    // Create a copy without the hash field
    const { blockHash, ...blockWithoutHash } = block;

    // Hash the block data
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(blockWithoutHash))
      .digest('hex');
  }

  // Helper method to generate a signature
  _generateSignature(data) {
    // In a real implementation, this would use proper cryptographic signing
    return crypto
      .createHash('sha256')
      .update(`${this.nodeId}|${data}|${Date.now()}`)
      .digest('hex');
  }

  // Helper method to generate location attestation (for PoP/PoL)
  _generateLocationAttestation() {
    // In a real implementation, this would contain cryptographic proof of location
    return {
      timestamp: new Date().toISOString(),
      attestationHash: crypto
        .createHash('sha256')
        .update(`location|${JSON.stringify(this.geoCoordinates)}|${Date.now()}`)
        .digest('hex'),
    };
  }
}

// Validator Network Manager
class ValidatorManager {
  constructor() {
    this.validators = [];
    this.activeValidatorCount = 0;
    this.networkInfo = {
      networkId: 'wxm-testnet',
      networkName: 'Wrfcoin Testnet',
      blockHeight: 1000,
      epoch: 10,
      slot: 42,
    };
    this.blockchainState = {
      lastBlock: null,
      consensusRound: 0,
      quorum: 0,
    };
  }

  // Register a validator with the network
  registerValidator(validator) {
    const existingIndex = this.validators.findIndex(
      v => v.nodeId === validator.nodeId
    );

    if (existingIndex >= 0) {
      this.validators[existingIndex] = validator;

      return {
        success: true,
        message: 'Validator updated',
        nodeId: validator.nodeId,
      };
    } else {
      this.validators.push(validator);

      if (validator.status === 'online') {
        this.activeValidatorCount++;
      }

      return {
        success: true,
        message: 'Validator registered',
        nodeId: validator.nodeId,
        networkInfo: this.networkInfo,
      };
    }
  }

  // Deregister a validator from the network
  deregisterValidator(validatorId) {
    const index = this.validators.findIndex(v => v.nodeId === validatorId);

    if (index < 0) {
      return {
        success: false,
        error: 'Validator not found',
      };
    }

    if (this.validators[index].status === 'online') {
      this.activeValidatorCount--;
    }

    this.validators.splice(index, 1);

    return {
      success: true,
      message: 'Validator deregistered',
      nodeId: validatorId,
    };
  }

  // Update validator status
  updateValidatorStatus(validatorId, newStatus) {
    const validator = this.validators.find(v => v.nodeId === validatorId);

    if (!validator) {
      return {
        success: false,
        error: 'Validator not found',
      };
    }

    const oldStatus = validator.status;
    validator.status = newStatus;
    validator.lastSeen = new Date().toISOString();

    // Update active validator count
    if (oldStatus !== 'online' && newStatus === 'online') {
      this.activeValidatorCount++;
    } else if (oldStatus === 'online' && newStatus !== 'online') {
      this.activeValidatorCount--;
    }

    return {
      success: true,
      nodeId: validatorId,
      oldStatus,
      newStatus,
    };
  }

  // Get validators by consensus mechanism
  getValidatorsByConsensus(consensusMechanism) {
    return this.validators.filter(
      v => v.consensusMechanism === consensusMechanism && v.status === 'online'
    );
  }

  // Get validators by mode
  getValidatorsByMode(mode) {
    return this.validators.filter(
      v => v.mode === mode && v.status === 'online'
    );
  }

  // Get validators by reputation status
  getValidatorsByReputation(status) {
    return this.validators.filter(
      v => v.reputation.status === status && v.status === 'online'
    );
  }

  // Simulate block validation across the network
  async simulateConsensusRound() {
    const activeValidators = this.validators.filter(v => v.status === 'online');

    if (activeValidators.length === 0) {
      return {
        success: false,
        error: 'No active validators',
      };
    }

    // Deterministic stake-weighted proposer selection.
    // Uses hash(previousBlockHash + slot) as seed so every node
    // selects the same proposer for the same slot.
    const proposer = this._selectProposerDeterministic(activeValidators);

    // Propose a block
    const proposalResult = await proposer.proposeBlock();

    if (!proposalResult.success) {
      return {
        success: false,
        error: `Block proposal failed: ${proposalResult.error}`,
      };
    }

    // Find the proposed block
    const proposedBlock = proposer.proposedBlocks.find(
      b => b.blockId === proposalResult.blockId
    );

    if (!proposedBlock) {
      return {
        success: false,
        error: 'Proposed block not found',
      };
    }

    // Simulate validation by other validators
    let validations = 0;
    let validationErrors = 0;

    for (const validator of activeValidators) {
      if (validator.nodeId === proposer.nodeId) continue;

      const validationResult = await validator.validateBlock(proposedBlock);

      if (validationResult.success) {
        validations++;
      } else {
        validationErrors++;
      }
    }

    // Check if consensus was reached
    const consensusThreshold = Math.ceil((activeValidators.length * 2) / 3);
    const consensusReached = validations >= consensusThreshold;

    // Update blockchain state
    if (consensusReached) {
      this.blockchainState.lastBlock = proposedBlock;
      this.networkInfo.blockHeight = proposedBlock.blockNumber;

      // Update proposer reputation and rewards
      proposer.reputation.blocksMined++;
      proposer.pendingRewards += 10; // Example reward amount
      proposer.updateReputation({ scoreChange: 0.01 });

      // Update active validators for successful validation
      for (const validator of activeValidators) {
        if (validator.nodeId !== proposer.nodeId) {
          validator.pendingRewards += 1; // Example reward for validation
        }
      }
    }

    return {
      success: true,
      consensusReached,
      blockId: proposedBlock.blockId,
      blockNumber: proposedBlock.blockNumber,
      proposer: proposer.nodeId,
      validations,
      validationErrors,
      quorum: consensusThreshold,
      message: consensusReached ? 'Consensus reached' : 'Consensus failed',
    };
  }

  /**
   * Deterministic stake-weighted proposer selection.
   *
   * Algorithm:
   *   1. Build a seed from hash(previousBlockHash + slot).
   *   2. Compute an effective weight for each validator:
   *        weight = (stake + delegatedStake) * stakeAgeDays
   *      where stakeAgeDays = days since the validator last proposed a block
   *      (minimum 1 to avoid zero-weight).
   *   3. Sort validators by nodeId for deterministic ordering.
   *   4. Walk the cumulative weight array; the validator whose cumulative
   *      range contains (seedValue mod totalWeight) is selected.
   *
   * This is fully deterministic: identical inputs always yield the same
   * proposer, so all nodes agree without communication.
   */
  _selectProposerDeterministic(activeValidators) {
    // Derive a deterministic seed from the last block hash + current slot.
    const previousBlockHash = this.blockchainState.lastBlock
      ? this.blockchainState.lastBlock.blockHash || ''
      : 'genesis';
    const slot = this.networkInfo.slot || 0;

    const seedHash = crypto
      .createHash('sha256')
      .update(`${previousBlockHash}:${slot}`)
      .digest('hex');

    // Convert first 8 hex chars of seedHash to a number (up to 2^32).
    const seedValue = parseInt(seedHash.substring(0, 8), 16);

    // Sort validators by nodeId for deterministic ordering.
    const sorted = [...activeValidators].sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
    );

    // Compute effective weights.
    const now = Date.now();
    const weights = sorted.map(v => {
      const totalStake = (v.stake || 0) + (v.delegatedStake || 0);
      // Days since last proposal (minimum 1 day to prevent zero-weight).
      let lastProposedTime;
      if (v.proposedBlocks && v.proposedBlocks.length > 0) {
        lastProposedTime = new Date(
          v.proposedBlocks[v.proposedBlocks.length - 1].timestamp
        ).getTime();
      } else {
        lastProposedTime = new Date(v.lastSeen || now).getTime();
      }
      const stakeAgeDays = Math.max(
        1,
        Math.floor((now - lastProposedTime) / (24 * 60 * 60 * 1000))
      );
      // Weight = stake * age. Minimum weight 1 so every validator has a chance.
      return Math.max(1, totalStake * stakeAgeDays);
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const target = seedValue % totalWeight;

    let cumulative = 0;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += weights[i];
      if (target < cumulative) {
        return sorted[i];
      }
    }

    // Fallback (should not happen): return last validator.
    return sorted[sorted.length - 1];
  }

  // Get network statistics
  getNetworkStats() {
    // Calculate total stake
    const totalStake = this.validators.reduce(
      (sum, v) => sum + v.stake + v.delegatedStake,
      0
    );

    // Calculate average reputation
    const avgReputation =
      this.validators.length > 0
        ? this.validators.reduce((sum, v) => sum + v.reputation.score, 0) /
          this.validators.length
        : 0;

    // Count validators by consensus mechanisms
    const consensusCounts = {};
    for (const validator of this.validators) {
      consensusCounts[validator.consensusMechanism] =
        (consensusCounts[validator.consensusMechanism] || 0) + 1;
    }

    // Count validators by mode
    const modeCounts = {};
    for (const validator of this.validators) {
      modeCounts[validator.mode] = (modeCounts[validator.mode] || 0) + 1;
    }

    // Count validators by reputation status
    const reputationCounts = {};
    for (const validator of this.validators) {
      reputationCounts[validator.reputation.status] =
        (reputationCounts[validator.reputation.status] || 0) + 1;
    }

    return {
      totalValidators: this.validators.length,
      activeValidators: this.activeValidatorCount,
      totalStake,
      averageReputation: avgReputation,
      networkInfo: this.networkInfo,
      consensusMechanisms: consensusCounts,
      validatorModes: modeCounts,
      reputationDistribution: reputationCounts,
      blockchainState: {
        latestBlockNumber: this.networkInfo.blockHeight,
        latestBlockTime: this.blockchainState.lastBlock
          ? this.blockchainState.lastBlock.timestamp
          : null,
      },
    };
  }
}

module.exports = {
  ValidatorMode,
  ConsensusMechanism,
  TransactionType,
  BlockType,
  ReputationStatus,
  ValidatorNode,
  ValidatorManager,
};
