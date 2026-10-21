/**
 * Network Simulation Testing Utilities
 *
 * Tools for simulating and testing blockchain network conditions:
 * - Network partition simulation
 * - Node failure testing
 * - Network latency/bandwidth constraints
 * - Consensus protocol validation
 * - Sybil attack simulation
 */

/**
 * Network node for simulation
 */
class SimulatedNode {
  /**
   * Create a simulated network node
   *
   * @param {Object} options - Node options
   * @param {string} options.id - Node identifier
   * @param {string} options.type - Node type (validator, miner, full, light)
   * @param {Object} options.capabilities - Node capabilities
   */
  constructor({ id, type = 'full', capabilities = {} }) {
    this.id = id;
    this.type = type;
    this.capabilities = {
      mining: type === 'miner' || type === 'validator',
      validation: type === 'validator',
      storage: type !== 'light',
      relay: type !== 'light',
      ...capabilities,
    };

    this.peers = new Map();
    this.blockchain = {
      blocks: [],
      transactions: new Map(),
      pendingTransactions: [],
    };

    this.status = 'online';
    this.networkQuality = {
      latency: 100, // ms
      packetLoss: 0.01, // 1%
      bandwidth: 10, // Mbps
    };

    this.recentMessages = [];
    this.metrics = {
      messagesReceived: 0,
      messagesSent: 0,
      blocksProposed: 0,
      blocksValidated: 0,
      failedValidations: 0,
    };
  }

  /**
   * Connect to another node
   *
   * @param {SimulatedNode} node - Node to connect to
   * @param {Object} connectionQuality - Connection quality parameters
   * @returns {boolean} Connection success
   */
  connectTo(node, connectionQuality = {}) {
    if (this.peers.has(node.id)) {
      return false; // Already connected
    }

    const quality = {
      latency:
        connectionQuality.latency ||
        Math.max(
          10,
          (this.networkQuality.latency + node.networkQuality.latency) / 2
        ),
      packetLoss:
        connectionQuality.packetLoss ||
        Math.max(
          0.001,
          (this.networkQuality.packetLoss + node.networkQuality.packetLoss) / 2
        ),
      bandwidth:
        connectionQuality.bandwidth ||
        Math.min(this.networkQuality.bandwidth, node.networkQuality.bandwidth),
    };

    this.peers.set(node.id, {
      node,
      quality,
      status: 'connected',
      lastSeen: Date.now(),
    });

    // Connect in the other direction if not already connected
    if (!node.peers.has(this.id)) {
      node.connectTo(this, quality);
    }

    return true;
  }

  /**
   * Disconnect from a peer
   *
   * @param {string} nodeId - ID of node to disconnect from
   * @returns {boolean} Disconnection success
   */
  disconnectFrom(nodeId) {
    if (!this.peers.has(nodeId)) {
      return false; // Not connected
    }

    const peer = this.peers.get(nodeId).node;
    this.peers.delete(nodeId);

    // Disconnect in the other direction if still connected
    if (peer.peers.has(this.id)) {
      peer.disconnectFrom(this.id);
    }

    return true;
  }

  /**
   * Get the current node state
   *
   * @returns {Object} Node state
   */
  getState() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      peerCount: this.peers.size,
      blockHeight: this.blockchain.blocks.length,
      transactionCount: this.blockchain.transactions.size,
      pendingTransactions: this.blockchain.pendingTransactions.length,
      capabilities: this.capabilities,
      metrics: this.metrics,
    };
  }

  /**
   * Send a message to a peer
   *
   * @param {string} peerId - Peer ID
   * @param {Object} message - Message to send
   * @returns {boolean} Sending success
   */
  sendMessage(peerId, message) {
    if (!this.peers.has(peerId) || this.status !== 'online') {
      return false;
    }

    const peer = this.peers.get(peerId);
    if (peer.status !== 'connected') {
      return false;
    }

    // Apply network quality constraints
    const packetLoss = peer.quality.packetLoss;

    // Simulate packet loss
    if (Math.random() < packetLoss) {
      return false;
    }

    // Calculate delay based on latency and message size
    const msgSize = JSON.stringify(message).length;
    const latency = peer.quality.latency;
    const bandwidth = (peer.quality.bandwidth * 1024 * 1024) / 8; // Convert Mbps to bytes/sec

    const transmissionTime = (msgSize / bandwidth) * 1000; // ms
    const totalDelay = latency + transmissionTime;

    // Track metrics
    this.metrics.messagesSent++;

    // Schedule message delivery
    setTimeout(() => {
      peer.node.receiveMessage(this.id, message);
    }, totalDelay);

    return true;
  }

  /**
   * Broadcast a message to all peers
   *
   * @param {Object} message - Message to broadcast
   * @returns {number} Number of peers message was sent to
   */
  broadcastMessage(message) {
    let successCount = 0;

    for (const peerId of this.peers.keys()) {
      if (this.sendMessage(peerId, message)) {
        successCount++;
      }
    }

    return successCount;
  }

  /**
   * Receive a message from a peer
   *
   * @param {string} peerId - Peer who sent the message
   * @param {Object} message - Message received
   */
  receiveMessage(peerId, message) {
    // Check if we're online and connected to this peer
    if (this.status !== 'online' || !this.peers.has(peerId)) {
      return;
    }

    // Update last seen timestamp
    const peer = this.peers.get(peerId);
    peer.lastSeen = Date.now();

    // Track metrics
    this.metrics.messagesReceived++;

    // Store in recent messages
    this.recentMessages.push({
      from: peerId,
      message,
      receivedAt: Date.now(),
    });

    // Trim recent messages to last 100
    if (this.recentMessages.length > 100) {
      this.recentMessages.shift();
    }

    // Process message based on type
    switch (message.type) {
      case 'block':
        this._handleBlockMessage(peerId, message);
        break;
      case 'transaction':
        this._handleTransactionMessage(peerId, message);
        break;
      case 'consensus':
        this._handleConsensusMessage(peerId, message);
        break;
      case 'status':
        this._handleStatusMessage(peerId, message);
        break;
      default:
        // Unknown message type, ignore
        break;
    }
  }

  /**
   * Handle a block message
   *
   * @param {string} peerId - Peer who sent the message
   * @param {Object} message - Block message
   */
  _handleBlockMessage(peerId, message) {
    const block = message.data;

    // Simple implementation - could be expanded for full validation
    if (this.capabilities.validation) {
      // Validator nodes validate blocks
      const isValid = this._validateBlock(block);

      if (isValid) {
        this.metrics.blocksValidated++;

        // Add to blockchain
        this.blockchain.blocks.push(block);

        // Relay to peers
        this._relayMessage(message, peerId);
      } else {
        this.metrics.failedValidations++;
      }
    } else {
      // Non-validator nodes just accept and relay
      this.blockchain.blocks.push(block);
      this._relayMessage(message, peerId);
    }
  }

  /**
   * Validate a block (simplified)
   *
   * @param {Object} block - Block to validate
   * @returns {boolean} Validation result
   */
  _validateBlock(block) {
    // Simplified validation logic
    // In a real implementation, this would check:
    // - Block hash correctness
    // - Transaction validity
    // - Consensus rules
    // - etc.

    // For simulation, randomly fail 5% of validations for non-validators
    if (this.type !== 'validator' && Math.random() < 0.05) {
      return false;
    }

    return true;
  }

  /**
   * Handle a transaction message
   *
   * @param {string} peerId - Peer who sent the message
   * @param {Object} message - Transaction message
   */
  _handleTransactionMessage(peerId, message) {
    const transaction = message.data;

    // Check if we already have this transaction
    if (this.blockchain.transactions.has(transaction.id)) {
      return;
    }

    // Add to pending transactions
    this.blockchain.pendingTransactions.push(transaction);
    this.blockchain.transactions.set(transaction.id, transaction);

    // Relay to peers if we're a relay node
    if (this.capabilities.relay) {
      this._relayMessage(message, peerId);
    }
  }

  /**
   * Handle a consensus message
   *
   * @param {string} peerId - Peer who sent the message
   * @param {Object} message - Consensus message
   */
  _handleConsensusMessage(peerId, message) {
    // Only validators process consensus messages
    if (!this.capabilities.validation) {
      return;
    }

    // Process consensus message (implementation depends on consensus algorithm)
    // For simulation, just log it
    console.log(
      `Node ${this.id} received consensus message from ${peerId}:`,
      message.data
    );
  }

  /**
   * Handle a status message
   *
   * @param {string} peerId - Peer who sent the message
   * @param {Object} message - Status message
   */
  _handleStatusMessage(peerId, message) {
    // Update peer state
    const peer = this.peers.get(peerId);
    peer.state = message.data;
  }

  /**
   * Relay a message to peers (excluding the source)
   *
   * @param {Object} message - Message to relay
   * @param {string} sourceId - Source peer ID to exclude
   */
  _relayMessage(message, sourceId) {
    for (const [peerId, peer] of this.peers.entries()) {
      // Don't relay back to source
      if (peerId === sourceId) {
        continue;
      }

      // Only relay if connection is good
      if (peer.status === 'connected') {
        this.sendMessage(peerId, message);
      }
    }
  }

  /**
   * Generate a new block (for mining nodes)
   *
   * @returns {Object|null} Generated block or null if can't mine
   */
  mineBlock() {
    if (!this.capabilities.mining || this.status !== 'online') {
      return null;
    }

    // Create a new block with pending transactions
    const blockHeight = this.blockchain.blocks.length;
    const transactions = this.blockchain.pendingTransactions.slice(0, 100);

    const block = {
      height: blockHeight,
      previousHash:
        blockHeight > 0 ? this.blockchain.blocks[blockHeight - 1].hash : '0',
      timestamp: Date.now(),
      transactions,
      hash: this._generateBlockHash(blockHeight, transactions),
      miner: this.id,
    };

    // Add to our blockchain
    this.blockchain.blocks.push(block);

    // Remove included transactions from pending
    this.blockchain.pendingTransactions =
      this.blockchain.pendingTransactions.slice(100);

    // Track metrics
    this.metrics.blocksProposed++;

    // Broadcast the new block to peers
    this.broadcastMessage({
      type: 'block',
      data: block,
    });

    return block;
  }

  /**
   * Generate a simple hash for a block (for simulation only)
   *
   * @param {number} height - Block height
   * @param {Array} transactions - Transactions in the block
   * @returns {string} Block hash
   */
  _generateBlockHash(height, transactions) {
    const txIds = transactions.map(tx => tx.id).join('');
    const data = `${height}-${txIds}-${Date.now()}`;

    // Simple hashing for simulation (not cryptographically secure)
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Take the node offline
   */
  goOffline() {
    this.status = 'offline';
  }

  /**
   * Bring the node back online
   */
  goOnline() {
    this.status = 'online';
  }

  /**
   * Degrade network quality
   *
   * @param {Object} degradation - Quality degradation parameters
   */
  degradeNetworkQuality(degradation) {
    this.networkQuality = {
      latency:
        this.networkQuality.latency * (1 + (degradation.latencyFactor || 0)),
      packetLoss:
        this.networkQuality.packetLoss + (degradation.packetLossFactor || 0),
      bandwidth:
        this.networkQuality.bandwidth / (degradation.bandwidthFactor || 1),
    };
  }

  /**
   * Reset network quality to original values
   */
  resetNetworkQuality() {
    this.networkQuality = {
      latency: 100,
      packetLoss: 0.01,
      bandwidth: 10,
    };
  }
}

/**
 * Network simulator for blockchain networks
 */
class NetworkSimulator {
  /**
   * Create a network simulator
   *
   * @param {Object} options - Simulator options
   */
  constructor(options = {}) {
    this.nodes = new Map();
    this.partitions = new Map();
    this.consensusProtocol = options.consensusProtocol || 'pow';
    this.blockTime = options.blockTime || 10000; // ms

    this.metrics = {
      messageCount: 0,
      totalBlocks: 0,
      partitionEvents: 0,
      nodeFailures: 0,
    };

    this.running = false;
    this.simulationIntervals = [];
  }

  /**
   * Add a node to the network
   *
   * @param {Object} nodeOptions - Node options
   * @returns {SimulatedNode} Created node
   */
  addNode(nodeOptions) {
    const id = nodeOptions.id || `node-${this.nodes.size + 1}`;

    if (this.nodes.has(id)) {
      throw new Error(`Node with ID ${id} already exists`);
    }

    const node = new SimulatedNode({ ...nodeOptions, id });
    this.nodes.set(id, node);

    // Initially add to default partition
    if (!this.partitions.has('default')) {
      this.partitions.set('default', new Set());
    }
    this.partitions.get('default').add(id);

    return node;
  }

  /**
   * Get a node by ID
   *
   * @param {string} nodeId - Node ID
   * @returns {SimulatedNode} Node
   */
  getNode(nodeId) {
    return this.nodes.get(nodeId);
  }

  /**
   * Create an initial network topology
   *
   * @param {string} topology - Topology type (random, ring, star, fully_connected)
   */
  createTopology(topology = 'random') {
    const nodeIds = Array.from(this.nodes.keys());

    switch (topology) {
      case 'ring':
        this._createRingTopology(nodeIds);
        break;
      case 'star':
        this._createStarTopology(nodeIds);
        break;
      case 'fully_connected':
        this._createFullyConnectedTopology(nodeIds);
        break;
      case 'random':
      default:
        this._createRandomTopology(nodeIds);
        break;
    }
  }

  /**
   * Create a ring network topology
   *
   * @param {string[]} nodeIds - Node IDs
   */
  _createRingTopology(nodeIds) {
    // Each node connects to its adjacent nodes in a ring
    for (let i = 0; i < nodeIds.length; i++) {
      const node = this.nodes.get(nodeIds[i]);
      const nextIndex = (i + 1) % nodeIds.length;
      const prevIndex = (i - 1 + nodeIds.length) % nodeIds.length;

      node.connectTo(this.nodes.get(nodeIds[nextIndex]));
      node.connectTo(this.nodes.get(nodeIds[prevIndex]));
    }
  }

  /**
   * Create a star network topology
   *
   * @param {string[]} nodeIds - Node IDs
   */
  _createStarTopology(nodeIds) {
    if (nodeIds.length < 2) return;

    // First node is the center, all others connect to it
    const centerNodeId = nodeIds[0];
    const centerNode = this.nodes.get(centerNodeId);

    for (let i = 1; i < nodeIds.length; i++) {
      this.nodes.get(nodeIds[i]).connectTo(centerNode);
    }
  }

  /**
   * Create a fully connected network topology
   *
   * @param {string[]} nodeIds - Node IDs
   */
  _createFullyConnectedTopology(nodeIds) {
    // Every node connects to every other node
    for (let i = 0; i < nodeIds.length; i++) {
      const node = this.nodes.get(nodeIds[i]);

      for (let j = 0; j < nodeIds.length; j++) {
        if (i !== j) {
          node.connectTo(this.nodes.get(nodeIds[j]));
        }
      }
    }
  }

  /**
   * Create a random network topology
   *
   * @param {string[]} nodeIds - Node IDs
   */
  _createRandomTopology(nodeIds) {
    // Each node connects to ~20% of other nodes randomly
    const connectionsPerNode = Math.max(2, Math.floor(nodeIds.length * 0.2));

    for (let i = 0; i < nodeIds.length; i++) {
      const node = this.nodes.get(nodeIds[i]);
      const otherNodes = nodeIds.filter(id => id !== nodeIds[i]);
      const shuffled = this._shuffleArray([...otherNodes]);

      // Connect to random subset
      for (
        let j = 0;
        j < Math.min(connectionsPerNode, otherNodes.length);
        j++
      ) {
        node.connectTo(this.nodes.get(shuffled[j]));
      }
    }
  }

  /**
   * Shuffle an array
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
   * Create a network partition
   *
   * @param {string} partitionName - Partition name
   * @param {string[]} nodeIds - Node IDs in the partition
   */
  createPartition(partitionName, nodeIds) {
    if (this.partitions.has(partitionName)) {
      throw new Error(`Partition ${partitionName} already exists`);
    }

    const partition = new Set(nodeIds);
    this.partitions.set(partitionName, partition);

    // Disconnect nodes between partitions
    this._applyPartitions();

    this.metrics.partitionEvents++;

    return partition;
  }

  /**
   * Move a node to a different partition
   *
   * @param {string} nodeId - Node ID to move
   * @param {string} targetPartition - Target partition name
   * @returns {boolean} Success status
   */
  moveNodeToPartition(nodeId, targetPartition) {
    if (!this.nodes.has(nodeId)) {
      return false;
    }

    if (!this.partitions.has(targetPartition)) {
      return false;
    }

    // Find current partition
    let currentPartition = null;
    for (const [name, nodes] of this.partitions.entries()) {
      if (nodes.has(nodeId)) {
        currentPartition = name;
        break;
      }
    }

    if (currentPartition === targetPartition) {
      return true; // Already in the target partition
    }

    // Remove from current partition
    if (currentPartition) {
      this.partitions.get(currentPartition).delete(nodeId);
    }

    // Add to target partition
    this.partitions.get(targetPartition).add(nodeId);

    // Update connections
    this._applyPartitions();

    return true;
  }

  /**
   * Apply network partitions by disconnecting nodes between partitions
   */
  _applyPartitions() {
    // Disconnect nodes that are in different partitions
    for (const [nodeId, node] of this.nodes.entries()) {
      // Find which partition this node is in
      let nodePartition = null;
      for (const [name, nodes] of this.partitions.entries()) {
        if (nodes.has(nodeId)) {
          nodePartition = name;
          break;
        }
      }

      if (!nodePartition) continue;

      // Check all peers
      for (const peerId of node.peers.keys()) {
        // Find which partition the peer is in
        let peerPartition = null;
        for (const [name, nodes] of this.partitions.entries()) {
          if (nodes.has(peerId)) {
            peerPartition = name;
            break;
          }
        }

        // Disconnect if in different partitions
        if (peerPartition && peerPartition !== nodePartition) {
          node.disconnectFrom(peerId);
        }
      }
    }
  }

  /**
   * Heal all network partitions
   */
  healPartitions() {
    // Move all nodes to the default partition
    const defaultPartition = new Set();

    for (const nodeId of this.nodes.keys()) {
      defaultPartition.add(nodeId);
    }

    // Clear existing partitions
    this.partitions.clear();
    this.partitions.set('default', defaultPartition);

    // Recreate original topology
    this.createTopology('random');
  }

  /**
   * Simulate node failure
   *
   * @param {string} nodeId - Node ID to fail
   * @returns {boolean} Success status
   */
  failNode(nodeId) {
    if (!this.nodes.has(nodeId)) {
      return false;
    }

    const node = this.nodes.get(nodeId);
    node.goOffline();

    this.metrics.nodeFailures++;

    return true;
  }

  /**
   * Recover a failed node
   *
   * @param {string} nodeId - Node ID to recover
   * @returns {boolean} Success status
   */
  recoverNode(nodeId) {
    if (!this.nodes.has(nodeId)) {
      return false;
    }

    const node = this.nodes.get(nodeId);
    node.goOnline();

    return true;
  }

  /**
   * Degrade network quality for a node
   *
   * @param {string} nodeId - Node ID
   * @param {Object} degradation - Quality degradation parameters
   * @returns {boolean} Success status
   */
  degradeNodeNetwork(nodeId, degradation) {
    if (!this.nodes.has(nodeId)) {
      return false;
    }

    const node = this.nodes.get(nodeId);
    node.degradeNetworkQuality(degradation);

    return true;
  }

  /**
   * Start simulating blockchain mining
   *
   * @returns {boolean} Success status
   */
  startMining() {
    if (this.running) {
      return false;
    }

    this.running = true;

    // Find mining nodes
    const miningNodes = Array.from(this.nodes.values()).filter(
      node => node.capabilities.mining
    );

    if (miningNodes.length === 0) {
      console.warn('No mining nodes in the network');
      return false;
    }

    // Start mining simulation
    const miningInterval = setInterval(() => {
      // Choose a random mining node to produce the next block
      // In a real implementation, this would be based on hash power, stake, etc.
      const onlineMiners = miningNodes.filter(node => node.status === 'online');

      if (onlineMiners.length === 0) {
        return;
      }

      // Simple probability-based selection (could be more sophisticated)
      let selectedMiner;

      if (this.consensusProtocol === 'pos') {
        // For PoS, select based on "stake" (for simulation, just use node ID)
        const totalStake = onlineMiners.reduce(
          (sum, miner) => sum + this._getNodeStake(miner),
          0
        );

        let cumulativeProbability = 0;
        const r = Math.random();

        for (const miner of onlineMiners) {
          cumulativeProbability += this._getNodeStake(miner) / totalStake;

          if (r <= cumulativeProbability) {
            selectedMiner = miner;
            break;
          }
        }
      } else {
        // For PoW, just use random selection
        const index = Math.floor(Math.random() * onlineMiners.length);
        selectedMiner = onlineMiners[index];
      }

      // Mine a block
      const block = selectedMiner.mineBlock();

      if (block) {
        this.metrics.totalBlocks++;
      }
    }, this.blockTime);

    this.simulationIntervals.push(miningInterval);

    return true;
  }

  /**
   * Get a node's stake for PoS simulation
   *
   * @param {SimulatedNode} node - Node to check
   * @returns {number} Node's stake
   */
  _getNodeStake(node) {
    // For simulation, derive stake from node ID
    // In a real system, this would be based on actual staked tokens
    const idNumber = parseInt(node.id.replace(/\D/g, ''), 10) || 1;
    return Math.max(1, idNumber % 100);
  }

  /**
   * Stop the simulation
   */
  stop() {
    this.running = false;

    // Clear all intervals
    for (const interval of this.simulationIntervals) {
      clearInterval(interval);
    }

    this.simulationIntervals = [];
  }

  /**
   * Run a Sybil attack simulation
   *
   * @param {number} sybilCount - Number of Sybil nodes to create
   * @param {Object} attackOptions - Attack configuration
   * @returns {Object} Attack results
   */
  runSybilAttack(sybilCount, attackOptions = {}) {
    const attackResults = {
      sybilNodes: [],
      networkInfluence: 0,
      connectionsEstablished: 0,
      totalConnections: 0,
    };

    // Create Sybil nodes
    for (let i = 0; i < sybilCount; i++) {
      const nodeId = `sybil-${i + 1}`;
      const node = this.addNode({
        id: nodeId,
        type: 'full',
        capabilities: {
          mining: false,
          relay: true,
        },
      });

      attackResults.sybilNodes.push(nodeId);
    }

    // Connect Sybil nodes to the network
    const honeypotRatio = attackOptions.honeypotRatio || 0.7;
    const targetNodes = Array.from(this.nodes.entries())
      .filter(([id]) => !id.startsWith('sybil-'))
      .map(([, node]) => node);

    // Sort by "importance" (for simulation, just use peer count)
    targetNodes.sort((a, b) => b.peers.size - a.peers.size);

    // Target the most important nodes (honeypot ratio)
    const topTargets = targetNodes.slice(
      0,
      Math.ceil(targetNodes.length * honeypotRatio)
    );

    // Connect each Sybil node to top targets
    for (const sybilId of attackResults.sybilNodes) {
      const sybilNode = this.nodes.get(sybilId);

      for (const target of topTargets) {
        if (sybilNode.connectTo(target)) {
          attackResults.connectionsEstablished++;
        }
      }
    }

    // Calculate total connections in the network
    for (const node of this.nodes.values()) {
      attackResults.totalConnections += node.peers.size;
    }

    // Calculate network influence
    attackResults.networkInfluence =
      attackResults.connectionsEstablished / attackResults.totalConnections;

    return attackResults;
  }

  /**
   * Get network consensus status
   *
   * @returns {Object} Consensus status
   */
  getConsensusStatus() {
    const blocks = new Map();
    const blockHeights = [];

    // Collect block data from each node
    for (const [nodeId, node] of this.nodes.entries()) {
      const height = node.blockchain.blocks.length;
      blockHeights.push(height);

      // Collect the hashes at each height
      for (let i = 0; i < height; i++) {
        if (!blocks.has(i)) {
          blocks.set(i, new Map());
        }

        const blockHash = node.blockchain.blocks[i].hash;
        if (!blocks.get(i).has(blockHash)) {
          blocks.get(i).set(blockHash, 0);
        }

        blocks.get(i).set(blockHash, blocks.get(i).get(blockHash) + 1);
      }
    }

    // Calculate statistics
    const avgBlockHeight =
      blockHeights.reduce((sum, h) => sum + h, 0) /
      Math.max(1, this.nodes.size);

    const medianBlockHeight = this._calculateMedian(blockHeights);

    // Check for forks
    const forks = [];
    for (const [height, hashes] of blocks.entries()) {
      if (hashes.size > 1) {
        forks.push({
          height,
          variants: Array.from(hashes.entries()).map(([hash, count]) => ({
            hash,
            count,
            share: count / this.nodes.size,
          })),
        });
      }
    }

    // Calculate consensus percentage
    let consensusPercentage = 0;
    if (blocks.has(medianBlockHeight - 1)) {
      const hashesAtMedian = blocks.get(medianBlockHeight - 1);
      const maxCount = Math.max(...hashesAtMedian.values());
      consensusPercentage = (maxCount / this.nodes.size) * 100;
    }

    return {
      averageBlockHeight: avgBlockHeight,
      medianBlockHeight,
      forks,
      consensusPercentage,
      nodesInConsensus: (consensusPercentage / 100) * this.nodes.size,
    };
  }

  /**
   * Calculate median of an array of numbers
   *
   * @param {number[]} values - Array of numbers
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
   * Get network topology statistics
   *
   * @returns {Object} Network topology stats
   */
  getNetworkStats() {
    const nodeCount = this.nodes.size;
    const connectionCounts = [];
    const latencies = [];
    const partitionSizes = [];

    // Collect connection data
    for (const node of this.nodes.values()) {
      connectionCounts.push(node.peers.size);

      for (const peer of node.peers.values()) {
        latencies.push(peer.quality.latency);
      }
    }

    // Collect partition sizes
    for (const partition of this.partitions.values()) {
      partitionSizes.push(partition.size);
    }

    return {
      nodeCount,
      activeNodes: Array.from(this.nodes.values()).filter(
        n => n.status === 'online'
      ).length,
      avgConnections:
        connectionCounts.reduce((sum, c) => sum + c, 0) /
        Math.max(1, nodeCount),
      minConnections: Math.min(...connectionCounts) || 0,
      maxConnections: Math.max(...connectionCounts) || 0,
      avgLatency:
        latencies.reduce((sum, l) => sum + l, 0) /
        Math.max(1, latencies.length),
      partitionCount: this.partitions.size,
      largestPartitionSize: Math.max(...partitionSizes) || 0,
      messageCount: this.metrics.messageCount,
      totalBlocks: this.metrics.totalBlocks,
    };
  }

  /**
   * Clear all simulation data and reset
   */
  reset() {
    this.stop();
    this.nodes.clear();
    this.partitions.clear();
    this.partitions.set('default', new Set());

    this.metrics = {
      messageCount: 0,
      totalBlocks: 0,
      partitionEvents: 0,
      nodeFailures: 0,
    };
  }
}

/**
 * Byzantine Fault Tolerance (BFT) simulator
 */
class ByzantineSimulator {
  /**
   * Create a BFT simulator
   *
   * @param {NetworkSimulator} networkSim - Network simulator instance
   */
  constructor(networkSim) {
    this.networkSim = networkSim;
    this.byzantineNodes = new Set();

    // Behavior strategies
    this.behaviors = {
      equivocating: (node, message) =>
        this._equivocatingBehavior(node, message),
      withholding: (node, message) => this._withholdingBehavior(node, message),
      delaying: (node, message) => this._delayingBehavior(node, message),
      random: (node, message) => this._randomBehavior(node, message),
    };
  }

  /**
   * Make a node byzantine with specified behavior
   *
   * @param {string} nodeId - Node to make byzantine
   * @param {string} behavior - Byzantine behavior type
   * @returns {boolean} Success status
   */
  makeByzantine(nodeId, behavior = 'random') {
    if (!this.networkSim.nodes.has(nodeId)) {
      return false;
    }

    if (!this.behaviors[behavior]) {
      return false;
    }

    const node = this.networkSim.nodes.get(nodeId);

    // Store original receive message method
    if (!node._originalReceiveMessage) {
      node._originalReceiveMessage = node.receiveMessage;
    }

    // Replace with byzantine behavior
    node.receiveMessage = (peerId, message) => {
      return this.behaviors[behavior](node, { peerId, message });
    };

    this.byzantineNodes.add(nodeId);

    return true;
  }

  /**
   * Equivocating behavior - sends different messages to different peers
   *
   * @param {SimulatedNode} node - Byzantine node
   * @param {Object} params - Message parameters
   * @returns {*} Method result
   */
  _equivocatingBehavior(node, { peerId, message }) {
    // First process the message normally
    const result = node._originalReceiveMessage(peerId, message);

    // If this is a consensus message, send contradictory messages to different peers
    if (message.type === 'consensus' || message.type === 'block') {
      // Split peers into two groups
      const peers = Array.from(node.peers.keys()).filter(id => id !== peerId);
      const midpoint = Math.floor(peers.length / 2);

      if (peers.length > 1) {
        // Send original message to first group
        for (let i = 0; i < midpoint; i++) {
          node.sendMessage(peers[i], message);
        }

        // Send modified message to second group
        const modifiedMessage = JSON.parse(JSON.stringify(message));

        if (message.type === 'consensus') {
          // Modify consensus data (e.g., flip a vote)
          if (modifiedMessage.data.vote) {
            modifiedMessage.data.vote =
              modifiedMessage.data.vote === 'yes' ? 'no' : 'yes';
          }
        } else if (message.type === 'block') {
          // Modify block data (e.g., change timestamp)
          modifiedMessage.data.timestamp = Date.now() - 1000;
          modifiedMessage.data.hash = `modified-${modifiedMessage.data.hash}`;
        }

        for (let i = midpoint; i < peers.length; i++) {
          node.sendMessage(peers[i], modifiedMessage);
        }
      }
    }

    return result;
  }

  /**
   * Withholding behavior - doesn't relay messages
   *
   * @param {SimulatedNode} node - Byzantine node
   * @param {Object} params - Message parameters
   * @returns {*} Method result
   */
  _withholdingBehavior(node, { peerId, message }) {
    // Process message but don't relay
    return node._originalReceiveMessage(peerId, message);
  }

  /**
   * Delaying behavior - adds extra delay to messages
   *
   * @param {SimulatedNode} node - Byzantine node
   * @param {Object} params - Message parameters
   * @returns {*} Method result
   */
  _delayingBehavior(node, { peerId, message }) {
    // Add random delay then process
    setTimeout(() => {
      node._originalReceiveMessage(peerId, message);
    }, Math.random() * 5000); // 0-5 second delay

    return null;
  }

  /**
   * Random behavior - randomly chooses between other behaviors
   *
   * @param {SimulatedNode} node - Byzantine node
   * @param {Object} params - Message parameters
   * @returns {*} Method result
   */
  _randomBehavior(node, params) {
    const behaviors = ['equivocating', 'withholding', 'delaying'];
    const behavior = behaviors[Math.floor(Math.random() * behaviors.length)];

    return this.behaviors[behavior](node, params);
  }

  /**
   * Restore a byzantine node to honest behavior
   *
   * @param {string} nodeId - Node to restore
   * @returns {boolean} Success status
   */
  restoreNode(nodeId) {
    if (
      !this.byzantineNodes.has(nodeId) ||
      !this.networkSim.nodes.has(nodeId)
    ) {
      return false;
    }

    const node = this.networkSim.nodes.get(nodeId);

    // Restore original behavior
    if (node._originalReceiveMessage) {
      node.receiveMessage = node._originalReceiveMessage;
      node._originalReceiveMessage = null;
    }

    this.byzantineNodes.delete(nodeId);

    return true;
  }

  /**
   * Run a Byzantine tolerance test
   *
   * @param {number} faultyRatio - Ratio of Byzantine nodes (0-1)
   * @param {string} behavior - Byzantine behavior to use
   * @returns {Object} Test results
   */
  runByzantineTest(faultyRatio, behavior = 'random') {
    const nodeIds = Array.from(this.networkSim.nodes.keys());
    const faultyCount = Math.floor(nodeIds.length * faultyRatio);

    // Make nodes Byzantine
    const byzantineIds = [];
    const shuffled = this._shuffleArray([...nodeIds]);

    for (let i = 0; i < faultyCount; i++) {
      const nodeId = shuffled[i];
      if (this.makeByzantine(nodeId, behavior)) {
        byzantineIds.push(nodeId);
      }
    }

    // Start mining to generate blocks
    this.networkSim.startMining();

    // Run for a period of time
    const testDuration = 10 * this.networkSim.blockTime;

    // Return a promise that resolves when the test is complete
    return new Promise(resolve => {
      setTimeout(() => {
        // Get consensus status
        const consensus = this.networkSim.getConsensusStatus();

        // Stop mining
        this.networkSim.stop();

        // Restore nodes
        for (const nodeId of byzantineIds) {
          this.restoreNode(nodeId);
        }

        // Calculate if Byzantine tolerance held
        const toleranceHeld = consensus.consensusPercentage > 66;

        resolve({
          byzantineNodes: byzantineIds.length,
          totalNodes: nodeIds.length,
          byzantineRatio: byzantineIds.length / nodeIds.length,
          consensusPercentage: consensus.consensusPercentage,
          toleranceHeld,
          behavior,
          forks: consensus.forks.length,
        });
      }, testDuration);
    });
  }

  /**
   * Shuffle an array
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
}

/**
 * Chain split simulation
 */
class ChainSplitSimulator {
  /**
   * Create a chain split simulator
   *
   * @param {NetworkSimulator} networkSim - Network simulator instance
   */
  constructor(networkSim) {
    this.networkSim = networkSim;
    this.splitActive = false;
    this.partitionNames = [];
  }

  /**
   * Simulate a chain split by creating network partitions
   *
   * @param {number} partitionCount - Number of partitions to create (default: 2)
   * @param {Object} options - Split options
   * @returns {Object} Split results
   */
  createChainSplit(partitionCount = 2, options = {}) {
    if (this.splitActive) {
      return { success: false, message: 'Split already active' };
    }

    const nodeIds = Array.from(this.networkSim.nodes.keys());

    // Not enough nodes
    if (nodeIds.length < partitionCount) {
      return {
        success: false,
        message: `Not enough nodes (${nodeIds.length}) for ${partitionCount} partitions`,
      };
    }

    // Distribute nodes evenly across partitions
    const partitions = Array(partitionCount)
      .fill()
      .map(() => []);

    // Distribute mining nodes first if requested
    if (options.distributeMiningNodes) {
      const miningNodes = [];
      const nonMiningNodes = [];

      for (const nodeId of nodeIds) {
        const node = this.networkSim.getNode(nodeId);
        if (node.capabilities.mining) {
          miningNodes.push(nodeId);
        } else {
          nonMiningNodes.push(nodeId);
        }
      }

      // Distribute mining nodes evenly
      for (let i = 0; i < miningNodes.length; i++) {
        partitions[i % partitionCount].push(miningNodes[i]);
      }

      // Then distribute non-mining nodes
      for (let i = 0; i < nonMiningNodes.length; i++) {
        partitions[i % partitionCount].push(nonMiningNodes[i]);
      }
    } else {
      // Simple distribution
      for (let i = 0; i < nodeIds.length; i++) {
        partitions[i % partitionCount].push(nodeIds[i]);
      }
    }

    // Create partitions in the network simulator
    this.partitionNames = [];
    for (let i = 0; i < partitionCount; i++) {
      const partitionName = `split-${i + 1}`;
      this.networkSim.createPartition(partitionName, partitions[i]);
      this.partitionNames.push(partitionName);
    }

    this.splitActive = true;

    return {
      success: true,
      partitionCount,
      partitions: partitions.map((nodes, i) => ({
        name: this.partitionNames[i],
        nodes,
        size: nodes.length,
        miningNodes: nodes.filter(
          id => this.networkSim.getNode(id).capabilities.mining
        ).length,
      })),
    };
  }

  /**
   * Heal the chain split
   *
   * @returns {Object} Healing results
   */
  healChainSplit() {
    if (!this.splitActive) {
      return { success: false, message: 'No active split to heal' };
    }

    // Get consensus state before healing
    const beforeConsensus = this.networkSim.getConsensusStatus();

    // Heal partitions
    this.networkSim.healPartitions();

    // Wait for consensus to stabilize
    return new Promise(resolve => {
      // Start mining if not already running
      const wasMining = this.networkSim.running;
      if (!wasMining) {
        this.networkSim.startMining();
      }

      // Check consensus after 5 block times
      setTimeout(() => {
        const afterConsensus = this.networkSim.getConsensusStatus();

        // Stop mining if we started it
        if (!wasMining) {
          this.networkSim.stop();
        }

        this.splitActive = false;
        this.partitionNames = [];

        resolve({
          success: true,
          forksResolved:
            beforeConsensus.forks.length > afterConsensus.forks.length,
          consensusBefore: beforeConsensus.consensusPercentage,
          consensusAfter: afterConsensus.consensusPercentage,
          remainingForks: afterConsensus.forks,
        });
      }, this.networkSim.blockTime * 5);
    });
  }

  /**
   * Run a chain split test with analysis
   *
   * @param {number} duration - Test duration in ms
   * @param {Object} options - Test options
   * @returns {Object} Test results and analysis
   */
  async runChainSplitTest(duration, options = {}) {
    // Create the split
    const splitResult = this.createChainSplit(
      options.partitionCount || 2,
      options
    );

    if (!splitResult.success) {
      return splitResult;
    }

    // Ensure mining is active
    const wasMining = this.networkSim.running;
    if (!wasMining) {
      this.networkSim.startMining();
    }

    // Wait for the specified duration
    await new Promise(resolve => setTimeout(resolve, duration));

    // Analyze the chain state in each partition
    const partitionStates = [];

    for (const partitionName of this.partitionNames) {
      const nodeIds = Array.from(this.networkSim.partitions.get(partitionName));
      const blockHeights = [];
      const blockHashes = new Map();

      // Collect blockchain data from each node in the partition
      for (const nodeId of nodeIds) {
        const node = this.networkSim.getNode(nodeId);
        const height = node.blockchain.blocks.length;
        blockHeights.push(height);

        // Track hashes at each height
        for (let i = 0; i < height; i++) {
          if (!blockHashes.has(i)) {
            blockHashes.set(i, new Map());
          }

          const hash = node.blockchain.blocks[i].hash;
          if (!blockHashes.get(i).has(hash)) {
            blockHashes.get(i).set(hash, 0);
          }

          blockHashes.get(i).set(hash, blockHashes.get(i).get(hash) + 1);
        }
      }

      // Calculate partition consensus
      const maxHeight = Math.max(...blockHeights);
      const divergenceHeight = this._findDivergenceHeight(blockHashes);

      partitionStates.push({
        partitionName,
        nodeCount: nodeIds.length,
        averageHeight:
          blockHeights.reduce((sum, h) => sum + h, 0) / nodeIds.length,
        maxHeight,
        minHeight: Math.min(...blockHeights),
        divergenceHeight,
        consensusPercentage: this._calculatePartitionConsensus(
          blockHashes,
          nodeIds.length
        ),
      });
    }

    // Heal the split if requested
    let healingResult = null;
    if (options.healAfterTest) {
      healingResult = await this.healChainSplit();
    }

    // Stop mining if we started it
    if (!wasMining) {
      this.networkSim.stop();
    }

    return {
      splitResult,
      partitionStates,
      diverged: partitionStates.some(p => p.divergenceHeight !== null),
      healingResult,
      duration,
    };
  }

  /**
   * Find the height at which chains diverged
   *
   * @param {Map} blockHashes - Map of block heights to hash counts
   * @returns {number|null} Divergence height or null if no divergence
   */
  _findDivergenceHeight(blockHashes) {
    let height = 0;

    while (blockHashes.has(height)) {
      if (blockHashes.get(height).size > 1) {
        return height;
      }
      height++;
    }

    return null;
  }

  /**
   * Calculate consensus percentage within a partition
   *
   * @param {Map} blockHashes - Map of block heights to hash counts
   * @param {number} nodeCount - Number of nodes in the partition
   * @returns {number} Consensus percentage
   */
  _calculatePartitionConsensus(blockHashes, nodeCount) {
    if (blockHashes.size === 0) return 0;

    // For each height, find the most common hash
    const consensusRatios = [];
    for (const [, hashes] of blockHashes.entries()) {
      const maxCount = Math.max(...hashes.values());
      consensusRatios.push(maxCount / nodeCount);
    }

    // Average consensus across all heights
    return (
      (consensusRatios.reduce((sum, r) => sum + r, 0) /
        consensusRatios.length) *
      100
    );
  }
}

module.exports = {
  SimulatedNode,
  NetworkSimulator,
  ByzantineSimulator,
  ChainSplitSimulator,
};
