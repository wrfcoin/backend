/**
 * Transaction Simulation Testing Utilities
 *
 * Tools for simulating and testing blockchain transactions:
 * - Transaction pool simulation
 * - Mempool stress testing
 * - Fee estimation testing
 * - Transaction propagation simulation
 * - Block inclusion probability testing
 */

/**
 * Transaction object for simulation
 */
class SimulatedTransaction {
  /**
   * Create a simulated transaction
   *
   * @param {Object} options - Transaction options
   * @param {string} options.sender - Sender address
   * @param {string} options.recipient - Recipient address
   * @param {number} options.amount - Transaction amount
   * @param {number} options.fee - Transaction fee
   * @param {string} options.type - Transaction type (e.g., 'Regular', 'NFT', 'Governance')
   */
  constructor({
    sender,
    recipient,
    amount,
    fee,
    type = 'Regular',
    data = null,
  }) {
    this.id = this._generateId();
    this.sender = sender;
    this.recipient = recipient;
    this.amount = amount;
    this.fee = fee;
    this.type = type;
    this.data = data;
    this.timestamp = Date.now();
    this.sizeBytes = this._calculateSize();
    this.status = 'pending';
    this.confirmations = 0;
    this.blockHeight = null;
    this.blockTime = null;
    this.propagationData = {
      firstSeen: Date.now(),
      nodes: new Set(),
      propagationTime: null,
    };
  }

  /**
   * Generate a unique transaction ID
   *
   * @returns {string} Transaction ID
   */
  _generateId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const idLength = 8;
    let id = 'tx';

    for (let i = 0; i < idLength; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return id;
  }

  /**
   * Calculate approximate transaction size in bytes
   *
   * @returns {number} Transaction size in bytes
   */
  _calculateSize() {
    // Base transaction size
    let size = 100;

    // Add size for sender and recipient
    size +=
      (this.sender ? this.sender.length : 0) +
      (this.recipient ? this.recipient.length : 0);

    // Add size for data if present
    if (this.data) {
      size +=
        typeof this.data === 'string'
          ? this.data.length
          : JSON.stringify(this.data).length;
    }

    // Different transaction types may have different sizes
    switch (this.type) {
      case 'NFT':
        size += 200; // NFT metadata
        break;
      case 'Governance':
        size += 150; // Governance data
        break;
      case 'Computational':
        size += 500; // Computational payload
        break;
      default:
        break;
    }

    return size;
  }

  /**
   * Get transaction priority based on fee per byte
   *
   * @returns {number} Transaction priority (fee per byte)
   */
  getPriority() {
    return this.fee / this.sizeBytes;
  }

  /**
   * Create a JSON representation of the transaction
   *
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      id: this.id,
      sender: this.sender,
      recipient: this.recipient,
      amount: this.amount,
      fee: this.fee,
      type: this.type,
      timestamp: this.timestamp,
      sizeBytes: this.sizeBytes,
      status: this.status,
      confirmations: this.confirmations,
      blockHeight: this.blockHeight,
    };
  }
}

/**
 * Transaction pool simulator
 */
class TransactionPoolSimulator {
  /**
   * Create a transaction pool simulator
   *
   * @param {Object} options - Configuration options
   * @param {number} options.maxPoolSize - Maximum number of transactions in the pool
   * @param {number} options.maxBlockSize - Maximum block size in bytes
   * @param {number} options.targetBlockTime - Target time between blocks in ms
   */
  constructor(options = {}) {
    this.maxPoolSize = options.maxPoolSize || 10000;
    this.maxBlockSize = options.maxBlockSize || 1000000; // 1MB
    this.targetBlockTime = options.targetBlockTime || 60000; // 1 minute

    this.transactions = new Map();
    this.blocks = [];
    this.currentBlockHeight = 0;
    this.stats = {
      totalTransactions: 0,
      includedInBlocks: 0,
      rejectedTransactions: 0,
      averageConfirmationTime: 0,
    };

    // Event listeners
    this.listeners = {
      'transaction.added': [],
      'transaction.rejected': [],
      'block.created': [],
      'transaction.confirmed': [],
    };
  }

  /**
   * Add a transaction to the pool
   *
   * @param {SimulatedTransaction} transaction - Transaction to add
   * @returns {boolean} Whether the transaction was accepted
   */
  addTransaction(transaction) {
    // Check if pool is full
    if (this.transactions.size >= this.maxPoolSize) {
      // Reject if this transaction has lower priority than all current txs
      const lowestPriorityTx = this._getLowestPriorityTransaction();

      if (
        lowestPriorityTx &&
        transaction.getPriority() <= lowestPriorityTx.getPriority()
      ) {
        this._emitEvent('transaction.rejected', {
          transaction,
          reason: 'Pool full and priority too low',
        });

        this.stats.rejectedTransactions++;
        return false;
      }

      // Remove lowest priority transaction to make room
      this.transactions.delete(lowestPriorityTx.id);
    }

    // Add to pool
    this.transactions.set(transaction.id, transaction);
    this.stats.totalTransactions++;

    this._emitEvent('transaction.added', { transaction });

    return true;
  }

  /**
   * Get a transaction by ID
   *
   * @param {string} txId - Transaction ID
   * @returns {SimulatedTransaction|undefined} Transaction if found
   */
  getTransaction(txId) {
    return this.transactions.get(txId);
  }

  /**
   * Get all transactions in the pool
   *
   * @returns {SimulatedTransaction[]} Transactions in the pool
   */
  getAllTransactions() {
    return Array.from(this.transactions.values());
  }

  /**
   * Estimate fee for desired inclusion time
   *
   * @param {number} targetConfirmationTimeMs - Target confirmation time in ms
   * @param {number} txSizeBytes - Estimated transaction size in bytes
   * @returns {Object} Fee estimation details
   */
  estimateFee(targetConfirmationTimeMs, txSizeBytes = 250) {
    const txList = this.getAllTransactions();

    // No transactions in pool
    if (txList.length === 0) {
      return {
        minFee: 0.0001,
        recommendedFee: 0.001,
        priorityFee: 0.002,
      };
    }

    // Sort by fee per byte (descending)
    txList.sort((a, b) => b.getPriority() - a.getPriority());

    // Calculate how many blocks until confirmation based on target time
    const targetBlocks = Math.max(
      1,
      Math.ceil(targetConfirmationTimeMs / this.targetBlockTime)
    );

    // Estimate the fee needed for inclusion within target blocks
    let requiredFeePerByte = 0;

    // Use historical data from recent blocks
    if (this.blocks.length > 0) {
      // Take the most recent blocks up to targetBlocks
      const recentBlocks = this.blocks.slice(-targetBlocks);
      const minFeesPerBlock = recentBlocks.map(block =>
        block.transactions.length > 0
          ? Math.min(...block.transactions.map(tx => tx.getPriority()))
          : 0
      );

      // Use the highest minimum fee from these blocks
      requiredFeePerByte = Math.max(...minFeesPerBlock);
    } else {
      // If no blocks yet, look at the mempool
      const percentile = 1 - 1 / targetBlocks;
      const index = Math.min(
        txList.length - 1,
        Math.floor(txList.length * percentile)
      );
      requiredFeePerByte = txList[index].getPriority();
    }

    // Calculate fees for the specified transaction size
    const minFee = requiredFeePerByte * txSizeBytes;
    const recommendedFee = minFee * 1.2; // 20% buffer
    const priorityFee = minFee * 2; // Double for priority

    return {
      minFee: Math.max(0.0001, minFee),
      recommendedFee: Math.max(0.001, recommendedFee),
      priorityFee: Math.max(0.002, priorityFee),
      targetBlocks,
      feePerByte: requiredFeePerByte,
    };
  }

  /**
   * Mine a new block from pending transactions
   *
   * @returns {Object} Newly mined block
   */
  mineBlock() {
    const currentTime = Date.now();

    // Sort transactions by fee per byte (highest first)
    const sortedTransactions = this.getAllTransactions().sort(
      (a, b) => b.getPriority() - a.getPriority()
    );

    const blockTransactions = [];
    let blockSize = 0;
    const maxBlockSize = this.maxBlockSize;

    // Fill block up to max size
    for (const tx of sortedTransactions) {
      if (blockSize + tx.sizeBytes <= maxBlockSize) {
        blockTransactions.push(tx);
        blockSize += tx.sizeBytes;
      } else {
        // Block is full
        break;
      }
    }

    // Create new block
    this.currentBlockHeight++;
    const newBlock = {
      height: this.currentBlockHeight,
      timestamp: currentTime,
      transactions: blockTransactions,
      size: blockSize,
      txCount: blockTransactions.length,
    };

    // Update transactions and remove from pool
    for (const tx of blockTransactions) {
      tx.status = 'confirmed';
      tx.confirmations = 1;
      tx.blockHeight = newBlock.height;
      tx.blockTime = currentTime;

      // Calculate confirmation time
      const confirmationTime = currentTime - tx.timestamp;
      this.stats.averageConfirmationTime =
        (this.stats.averageConfirmationTime * this.stats.includedInBlocks +
          confirmationTime) /
        (this.stats.includedInBlocks + 1);

      this.stats.includedInBlocks++;

      // Remove from pool
      this.transactions.delete(tx.id);

      this._emitEvent('transaction.confirmed', {
        transaction: tx,
        block: newBlock,
      });
    }

    // Add block to chain
    this.blocks.push(newBlock);

    this._emitEvent('block.created', { block: newBlock });

    return newBlock;
  }

  /**
   * Get the lowest priority transaction in the pool
   *
   * @returns {SimulatedTransaction} Lowest priority transaction
   */
  _getLowestPriorityTransaction() {
    let lowestPriority = Infinity;
    let lowestTx = null;

    for (const tx of this.transactions.values()) {
      const priority = tx.getPriority();
      if (priority < lowestPriority) {
        lowestPriority = priority;
        lowestTx = tx;
      }
    }

    return lowestTx;
  }

  /**
   * Calculate inclusion probability for a transaction
   *
   * @param {SimulatedTransaction} transaction - Transaction to check
   * @param {number} blockCount - Number of blocks to consider
   * @returns {Object} Inclusion probability statistics
   */
  calculateInclusionProbability(transaction, blockCount = 6) {
    const txList = this.getAllTransactions();
    txList.push(transaction);

    // Sort by fee per byte (descending)
    txList.sort((a, b) => b.getPriority() - a.getPriority());

    // Find position of this transaction
    const position = txList.findIndex(tx => tx.id === transaction.id);

    // Estimate transactions per block based on history
    const avgTxPerBlock =
      this.blocks.length > 0
        ? this.blocks.reduce((sum, block) => sum + block.txCount, 0) /
          this.blocks.length
        : Math.min(100, Math.floor(this.maxBlockSize / 250)); // Assume average tx size of 250 bytes

    // Calculate probability of inclusion in each block
    const probabilities = [];
    let remainingTx = position;
    let cumulativeProbability = 0;

    for (let i = 0; i < blockCount && cumulativeProbability < 0.99; i++) {
      const blockProb = Math.min(1, avgTxPerBlock / Math.max(1, remainingTx));
      const adjustedProb = blockProb * (1 - cumulativeProbability);

      probabilities.push({
        block: i + 1,
        probability: adjustedProb,
      });

      cumulativeProbability += adjustedProb;
      remainingTx = Math.max(0, remainingTx - avgTxPerBlock);
    }

    return {
      position,
      totalTransactions: txList.length,
      estimatedBlocksUntilConfirmation: Math.ceil(position / avgTxPerBlock),
      estimatedTimeUntilConfirmation:
        Math.ceil(position / avgTxPerBlock) * this.targetBlockTime,
      probabilityByBlock: probabilities,
      cumulativeProbability,
    };
  }

  /**
   * Register an event listener
   *
   * @param {string} event - Event name
   * @param {Function} callback - Event callback
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  /**
   * Emit an event to registered listeners
   *
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  _emitEvent(event, data) {
    if (this.listeners[event]) {
      for (const callback of this.listeners[event]) {
        callback(data);
      }
    }
  }

  /**
   * Get pool statistics
   *
   * @returns {Object} Pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentPoolSize: this.transactions.size,
      blockCount: this.blocks.length,
      averageBlockSize:
        this.blocks.length > 0
          ? this.blocks.reduce((sum, block) => sum + block.size, 0) /
            this.blocks.length
          : 0,
      averageTransactionsPerBlock:
        this.blocks.length > 0
          ? this.blocks.reduce((sum, block) => sum + block.txCount, 0) /
            this.blocks.length
          : 0,
      currentBlockHeight: this.currentBlockHeight,
    };
  }

  /**
   * Reset simulation to initial state
   */
  reset() {
    this.transactions.clear();
    this.blocks = [];
    this.currentBlockHeight = 0;
    this.stats = {
      totalTransactions: 0,
      includedInBlocks: 0,
      rejectedTransactions: 0,
      averageConfirmationTime: 0,
    };
  }
}

/**
 * Network propagation simulator
 */
class NetworkPropagationSimulator {
  /**
   * Create a network propagation simulator
   *
   * @param {Object} options - Configuration options
   * @param {number} options.nodeCount - Number of nodes in the network
   * @param {number} options.avgPropagationDelay - Average delay between nodes in ms
   * @param {number} options.networkReliability - Reliability of network connections (0-1)
   */
  constructor(options = {}) {
    this.nodeCount = options.nodeCount || 100;
    this.avgPropagationDelay = options.avgPropagationDelay || 100;
    this.networkReliability = options.networkReliability || 0.98;

    // Create network topology
    this.nodes = new Map();
    this.connections = [];

    this._setupNetwork();
  }

  /**
   * Set up the simulated network
   */
  _setupNetwork() {
    // Create nodes
    for (let i = 0; i < this.nodeCount; i++) {
      const nodeId = `node-${i}`;
      this.nodes.set(nodeId, {
        id: nodeId,
        connections: [],
        transactions: new Map(),
        firstSeen: new Map(),
      });
    }

    // Create connections (simplified P2P network)
    const nodeIds = Array.from(this.nodes.keys());

    // Each node connects to ~10% of other nodes on average
    const connectionsPerNode = Math.max(3, Math.floor(this.nodeCount * 0.1));

    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      const otherNodes = nodeIds.filter(id => id !== nodeId);

      // Randomly select connections
      const connectionCount = Math.floor(
        connectionsPerNode * (0.7 + Math.random() * 0.6)
      );
      const shuffled = this._shuffleArray([...otherNodes]);
      const selectedConnections = shuffled.slice(0, connectionCount);

      for (const connectedNodeId of selectedConnections) {
        const latency = this._generateLatency();

        node.connections.push({
          nodeId: connectedNodeId,
          latency,
        });

        // Add the connection to the global list
        this.connections.push({
          from: nodeId,
          to: connectedNodeId,
          latency,
        });
      }
    }
  }

  /**
   * Generate a random latency for a connection
   *
   * @returns {number} Latency in milliseconds
   */
  _generateLatency() {
    // Log-normal distribution for realistic network latency
    const mu = Math.log(this.avgPropagationDelay);
    const sigma = 0.5;

    const X = Math.log(Math.random() * 9 + 1); // Uniform between log(1) and log(10)
    const Y = Math.log(Math.random() * 9 + 1);

    const Z =
      Math.sqrt(-2 * Math.log(Math.random())) *
      Math.cos(2 * Math.PI * Math.random());

    return Math.exp(mu + sigma * Z);
  }

  /**
   * Shuffle an array using Fisher-Yates algorithm
   *
   * @param {Array} array - Array to shuffle
   * @returns {Array} Shuffled array
   */
  _shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Simulate transaction propagation through the network
   *
   * @param {SimulatedTransaction} transaction - Transaction to propagate
   * @param {string} startingNodeId - ID of the node where transaction originates
   * @returns {Object} Propagation results
   */
  simulatePropagation(transaction, startingNodeId = null) {
    // If no starting node specified, pick a random one
    if (!startingNodeId) {
      const nodeIds = Array.from(this.nodes.keys());
      startingNodeId = nodeIds[Math.floor(Math.random() * nodeIds.length)];
    }

    // Check if starting node exists
    if (!this.nodes.has(startingNodeId)) {
      throw new Error(`Starting node ${startingNodeId} not found in network`);
    }

    const startTime = Date.now();
    const propagationQueue = [];
    const seenNodes = new Set();
    const propagationTimes = new Map();
    let maxPropagationTime = 0;

    // Start at the initial node
    seenNodes.add(startingNodeId);
    propagationTimes.set(startingNodeId, 0);

    const startingNode = this.nodes.get(startingNodeId);
    startingNode.transactions.set(transaction.id, transaction);
    startingNode.firstSeen.set(transaction.id, startTime);

    // Queue up initial propagations
    for (const connection of startingNode.connections) {
      propagationQueue.push({
        fromNode: startingNodeId,
        toNode: connection.nodeId,
        transaction: transaction,
        delay: connection.latency,
        arrivalTime: startTime + connection.latency,
      });
    }

    // Process propagation queue
    while (propagationQueue.length > 0) {
      // Sort by arrival time
      propagationQueue.sort((a, b) => a.arrivalTime - b.arrivalTime);

      // Process the next propagation
      const propagation = propagationQueue.shift();

      // Check if node has already seen this transaction
      if (seenNodes.has(propagation.toNode)) {
        continue;
      }

      // Check if transmission fails due to network reliability
      if (Math.random() > this.networkReliability) {
        // Transmission failed, retry with additional delay
        propagation.delay += this._generateLatency();
        propagation.arrivalTime = startTime + propagation.delay;
        propagationQueue.push(propagation);
        continue;
      }

      // Transmission successful
      seenNodes.add(propagation.toNode);
      propagationTimes.set(propagation.toNode, propagation.delay);
      maxPropagationTime = Math.max(maxPropagationTime, propagation.delay);

      // Node receives the transaction
      const node = this.nodes.get(propagation.toNode);
      node.transactions.set(transaction.id, transaction);
      node.firstSeen.set(transaction.id, startTime + propagation.delay);

      // Propagate to connections
      for (const connection of node.connections) {
        // Don't propagate back or to nodes that have already seen it
        if (
          connection.nodeId === propagation.fromNode ||
          seenNodes.has(connection.nodeId)
        ) {
          continue;
        }

        // Queue up this propagation
        propagationQueue.push({
          fromNode: propagation.toNode,
          toNode: connection.nodeId,
          transaction: transaction,
          delay: propagation.delay + connection.latency,
          arrivalTime: startTime + propagation.delay + connection.latency,
        });
      }
    }

    // Update transaction with propagation data
    transaction.propagationData = {
      firstSeen: startTime,
      originNode: startingNodeId,
      nodesReached: seenNodes.size,
      coveragePercent: (seenNodes.size / this.nodeCount) * 100,
      maxPropagationTime,
      medianPropagationTime: this._calculateMedian(
        Array.from(propagationTimes.values())
      ),
      nodePropagationTimes: Object.fromEntries(propagationTimes),
    };

    return {
      transaction: transaction.id,
      nodesReached: seenNodes.size,
      totalNodes: this.nodeCount,
      coverage: (seenNodes.size / this.nodeCount) * 100,
      maxPropagationTime,
      medianPropagationTime: this._calculateMedian(
        Array.from(propagationTimes.values())
      ),
      unreachedNodes: this.nodeCount - seenNodes.size,
    };
  }

  /**
   * Calculate median value of an array
   *
   * @param {Array<number>} values - Array of values
   * @returns {number} Median value
   */
  _calculateMedian(values) {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    } else {
      return sorted[middle];
    }
  }

  /**
   * Create a transaction and propagate it through the network
   *
   * @param {Object} txOptions - Transaction options
   * @returns {Object} Propagation results and transaction
   */
  createAndPropagate(txOptions) {
    const transaction = new SimulatedTransaction(txOptions);
    const result = this.simulatePropagation(transaction);

    return {
      transaction,
      propagationResult: result,
    };
  }

  /**
   * Get transaction propagation map
   *
   * @param {string} txId - Transaction ID
   * @returns {Map<string, number>} Map of node IDs to first seen times
   */
  getTransactionPropagationMap(txId) {
    const result = new Map();

    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.firstSeen.has(txId)) {
        result.set(nodeId, node.firstSeen.get(txId));
      }
    }

    return result;
  }

  /**
   * Get network topology information
   *
   * @returns {Object} Network topology details
   */
  getNetworkTopology() {
    const nodeConnections = {};

    for (const [nodeId, node] of this.nodes.entries()) {
      nodeConnections[nodeId] = {
        connections: node.connections.length,
        averageLatency:
          node.connections.reduce((sum, conn) => sum + conn.latency, 0) /
          (node.connections.length || 1),
      };
    }

    return {
      nodeCount: this.nodeCount,
      totalConnections: this.connections.length,
      averageConnectionsPerNode: this.connections.length / this.nodeCount,
      nodeConnections,
      networkDiameter: this._calculateNetworkDiameter(),
      averageLatency:
        this.connections.reduce((sum, conn) => sum + conn.latency, 0) /
        (this.connections.length || 1),
    };
  }

  /**
   * Calculate the network diameter (longest shortest path)
   *
   * @returns {number} Network diameter in hops
   */
  _calculateNetworkDiameter() {
    // Simplified Floyd-Warshall algorithm for demonstration
    const nodeIds = Array.from(this.nodes.keys());
    const n = nodeIds.length;

    // Initialize distance matrix
    const dist = Array(n)
      .fill()
      .map(() => Array(n).fill(Infinity));

    // Set up initial distances
    for (let i = 0; i < n; i++) {
      dist[i][i] = 0; // Distance to self = 0
    }

    // Set up direct connections
    for (const connection of this.connections) {
      const fromIndex = nodeIds.indexOf(connection.from);
      const toIndex = nodeIds.indexOf(connection.to);
      dist[fromIndex][toIndex] = 1; // One hop
    }

    // Floyd-Warshall algorithm
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (dist[i][k] + dist[k][j] < dist[i][j]) {
            dist[i][j] = dist[i][k] + dist[k][j];
          }
        }
      }
    }

    // Find maximum finite distance (diameter)
    let diameter = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (dist[i][j] !== Infinity && dist[i][j] > diameter) {
          diameter = dist[i][j];
        }
      }
    }

    return diameter;
  }
}

/**
 * Transaction generator for load testing
 */
class TransactionGenerator {
  /**
   * Create a transaction generator
   *
   * @param {Object} options - Generator options
   * @param {number} options.addressCount - Number of unique addresses to generate
   * @param {string[]} options.transactionTypes - Available transaction types
   */
  constructor(options = {}) {
    this.addressCount = options.addressCount || 100;
    this.transactionTypes = options.transactionTypes || [
      'Regular',
      'NFT',
      'Governance',
      'Computational',
    ];

    // Generate addresses
    this.addresses = [];
    for (let i = 0; i < this.addressCount; i++) {
      this.addresses.push(this._generateAddress());
    }
  }

  /**
   * Generate a random blockchain address
   *
   * @returns {string} Blockchain address
   */
  _generateAddress() {
    const prefix = 'Wrf';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = 34;

    let address = prefix;
    for (let i = 0; i < length - prefix.length; i++) {
      address += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return address;
  }

  /**
   * Generate a random transaction
   *
   * @param {Object} options - Generation options
   * @param {boolean} options.randomizeAll - Randomize all fields
   * @param {number} options.amount - Transaction amount (optional)
   * @param {number} options.fee - Transaction fee (optional)
   * @returns {SimulatedTransaction} Generated transaction
   */
  generateTransaction(options = {}) {
    const randomizeAll = options.randomizeAll !== false;

    // Select random sender and recipient
    const sender =
      this.addresses[Math.floor(Math.random() * this.addresses.length)];
    let recipient =
      this.addresses[Math.floor(Math.random() * this.addresses.length)];

    // Ensure sender != recipient
    while (recipient === sender) {
      recipient =
        this.addresses[Math.floor(Math.random() * this.addresses.length)];
    }

    // Select transaction type
    const type = randomizeAll
      ? this.transactionTypes[
          Math.floor(Math.random() * this.transactionTypes.length)
        ]
      : options.type || 'Regular';

    // Generate amount and fee
    const amount = options.amount || Math.floor(Math.random() * 1000) + 1;
    const fee = options.fee || this._generateFee(type);

    // Generate data field for certain transaction types
    let data = null;
    if (type === 'NFT') {
      data = {
        tokenId: `NFT-${Math.floor(Math.random() * 10000)}`,
        metadata: {
          name: `Asset ${Math.floor(Math.random() * 100)}`,
          description: 'Generated test NFT',
          attributes: [],
        },
      };
    } else if (type === 'Governance') {
      data = {
        proposalId: `PROP-${Math.floor(Math.random() * 1000)}`,
        vote: ['yes', 'no', 'abstain'][Math.floor(Math.random() * 3)],
      };
    } else if (type === 'Computational') {
      data = {
        jobId: `JOB-${Math.floor(Math.random() * 10000)}`,
        computeUnits: Math.floor(Math.random() * 100) + 1,
      };
    }

    return new SimulatedTransaction({
      sender,
      recipient,
      amount,
      fee,
      type,
      data,
    });
  }

  /**
   * Generate a reasonable fee for a transaction type
   *
   * @param {string} type - Transaction type
   * @returns {number} Generated fee
   */
  _generateFee(type) {
    // Base fee
    let baseFee = 0.001 + Math.random() * 0.01;

    // Adjust by transaction type
    switch (type) {
      case 'NFT':
        baseFee *= 1.5;
        break;
      case 'Governance':
        baseFee *= 1.2;
        break;
      case 'Computational':
        baseFee *= 2.0;
        break;
      default:
        break;
    }

    // Round to 4 decimal places
    return Math.round(baseFee * 10000) / 10000;
  }

  /**
   * Generate a batch of transactions
   *
   * @param {number} count - Number of transactions to generate
   * @param {Object} options - Generation options
   * @returns {SimulatedTransaction[]} Generated transactions
   */
  generateBatch(count, options = {}) {
    const transactions = [];

    for (let i = 0; i < count; i++) {
      transactions.push(this.generateTransaction(options));
    }

    return transactions;
  }

  /**
   * Generate transactions with specific fee distribution
   *
   * @param {number} count - Number of transactions to generate
   * @param {string} distribution - Fee distribution type ('uniform', 'normal', 'pareto')
   * @returns {SimulatedTransaction[]} Generated transactions
   */
  generateWithFeeDistribution(count, distribution = 'normal') {
    const transactions = [];

    for (let i = 0; i < count; i++) {
      let fee;

      switch (distribution) {
        case 'uniform':
          // Uniform distribution between 0.001 and 0.02
          fee = 0.001 + Math.random() * 0.019;
          break;

        case 'normal': {
          // Normal-like distribution around 0.005
          let sum = 0;
          for (let j = 0; j < 6; j++) {
            // Sum of 6 uniform gives approximate normal
            sum += Math.random();
          }
          fee = 0.001 + (sum - 3) * 0.005;
          fee = Math.max(0.0001, fee);
          break;
        }

        case 'pareto': {
          // Long-tail distribution - most transactions pay low fees, a few pay high fees
          const alpha = 1.5;
          const xm = 0.001;
          const u = Math.random();
          fee = xm / Math.pow(1 - u, 1 / alpha);
          fee = Math.min(fee, 0.1); // Cap at reasonable maximum
          break;
        }

        default:
          fee = 0.001 + Math.random() * 0.019;
      }

      // Round to 4 decimal places
      fee = Math.round(fee * 10000) / 10000;

      transactions.push(
        this.generateTransaction({
          randomizeAll: true,
          fee,
        })
      );
    }

    return transactions;
  }
}

module.exports = {
  SimulatedTransaction,
  TransactionPoolSimulator,
  NetworkPropagationSimulator,
  TransactionGenerator,
};
