/**
 * Wrfcoin Storage Keeper Node
 *
 * This module defines the functionality for storage keeper nodes in the
 * Wrfcoin blockchain network. These specialized nodes manage the storage
 * of large meteorological datasets and provide access to these datasets
 * for computational tasks.
 */

const {
  DataBlockType,
  DataStorageProvider,
  GeoReferenceSystem,
} = require('./data-aware-block');
const crypto = require('crypto');

// Storage service types supported by keeper nodes
const StorageServiceType = {
  IPFS: 'ipfs', // InterPlanetary File System
  FILECOIN: 'filecoin', // Filecoin
  ARWEAVE: 'arweave', // Arweave
  STORJ: 'storj', // Storj DCS
  IRYS: 'irys', // Irys (Bundlr)
  CRUST: 'crust', // Crust Network
  SKYNET: 'skynet', // Skynet
  LOCAL: 'local', // Local storage (testnet only)
};

// Data types that can be stored by keeper nodes
const StorageDataType = {
  FORECAST_OUTPUT: 'forecast_output', // Forecast computation results
  OBSERVATION_DATA: 'observation_data', // Weather observation data
  SENSOR_READINGS: 'sensor_readings', // Raw sensor data
  MODEL_WEIGHTS: 'model_weights', // ML model weights
  SATELLITE_IMAGERY: 'satellite_imagery', // Satellite weather imagery
  HISTORICAL_DATA: 'historical_data', // Historical climate data
  VERIFICATION_DATA: 'verification_data', // Data for forecast verification
  METADATA: 'metadata', // Metadata about other stored data
};

// Data reliability levels
const ReliabilityLevel = {
  CRITICAL: 'critical', // Mission-critical data (multi-region, high redundancy)
  HIGH: 'high', // Important data (multiple copies)
  STANDARD: 'standard', // Normal data (standard redundancy)
  ARCHIVAL: 'archival', // Long-term storage (cost-optimized)
};

// Data access patterns
const AccessPattern = {
  FREQUENT: 'frequent', // Accessed multiple times daily
  REGULAR: 'regular', // Accessed several times weekly
  OCCASIONAL: 'occasional', // Accessed a few times monthly
  RARE: 'rare', // Accessed a few times yearly (or less)
};

// Storage requirements
class StorageRequirements {
  constructor(options = {}) {
    this.sizeGB = options.sizeGB || 1;
    this.reliabilityLevel =
      options.reliabilityLevel || ReliabilityLevel.STANDARD;
    this.accessPattern = options.accessPattern || AccessPattern.REGULAR;
    this.retentionPeriodDays = options.retentionPeriodDays || 30;
    this.encryptionRequired = options.encryptionRequired || false;
    this.geoRestriction = options.geoRestriction || null; // Geographic restrictions for data storage
    this.maxLatencyMs = options.maxLatencyMs || 5000; // Maximum access latency
    this.format = options.format || 'parquet'; // Default file format
    this.compression = options.compression || 'gzip'; // Default compression
  }

  // Calculate storage tokens needed based on requirements
  calculateStorageTokens() {
    let tokens = this.sizeGB * 10; // Base cost per GB

    // Reliability multiplier
    const reliabilityMultiplier = {
      [ReliabilityLevel.CRITICAL]: 4.0,
      [ReliabilityLevel.HIGH]: 2.0,
      [ReliabilityLevel.STANDARD]: 1.0,
      [ReliabilityLevel.ARCHIVAL]: 0.5,
    };
    tokens *= reliabilityMultiplier[this.reliabilityLevel] || 1.0;

    // Access pattern multiplier
    const accessMultiplier = {
      [AccessPattern.FREQUENT]: 2.0,
      [AccessPattern.REGULAR]: 1.0,
      [AccessPattern.OCCASIONAL]: 0.7,
      [AccessPattern.RARE]: 0.4,
    };
    tokens *= accessMultiplier[this.accessPattern] || 1.0;

    // Encryption premium
    if (this.encryptionRequired) {
      tokens *= 1.2;
    }

    // Retention period factor (longer = cheaper per day)
    tokens *= Math.sqrt(this.retentionPeriodDays / 30);

    // Latency premium (lower latency = higher cost)
    tokens *= (3000 / Math.max(this.maxLatencyMs, 500)) * 0.5;

    return Math.ceil(tokens);
  }
}

// Storage request definition
class StorageRequest {
  constructor(options = {}) {
    this.id = options.id || `storage-${Date.now().toString(36)}`;
    this.dataType = options.dataType || StorageDataType.FORECAST_OUTPUT;
    this.serviceType = options.serviceType || StorageServiceType.IPFS;
    this.description = options.description || '';
    this.requirements = new StorageRequirements(options.requirements || {});
    this.metadata = options.metadata || {};
    this.geoBounds = options.geoBounds;
    this.geoReference = options.geoReference || GeoReferenceSystem.WGS84;
    this.dataTimestamp = options.dataTimestamp || new Date().toISOString();
    this.expirationTimestamp = options.expirationTimestamp; // When data can be deleted
    this.accessControl = options.accessControl || { public: true }; // Who can access the data
    this.requester = options.requester;
    this.reward = options.reward || this.requirements.calculateStorageTokens();
    this.status = options.status || 'created';
    this.createdAt = options.createdAt || new Date().toISOString();
  }

  // Validate the storage request
  validate() {
    const errors = [];

    if (!this.dataType) errors.push('Data type is required');
    if (!this.serviceType) errors.push('Storage service type is required');
    if (!this.requirements) errors.push('Storage requirements are required');

    // Validate size is positive
    if (this.requirements.sizeGB <= 0) {
      errors.push('Storage size must be positive');
    }

    // Validate retention period
    if (this.requirements.retentionPeriodDays <= 0) {
      errors.push('Retention period must be positive');
    }

    // If expiration is set, check it's after creation
    if (this.expirationTimestamp) {
      const expiration = new Date(this.expirationTimestamp);
      const created = new Date(this.createdAt);
      if (expiration <= created) {
        errors.push('Expiration timestamp must be after creation timestamp');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Prepare storage request for blockchain submission
  prepareForBlockchain() {
    // Generate a unique storage ID based on request parameters
    const requestHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          dataType: this.dataType,
          serviceType: this.serviceType,
          requirements: this.requirements,
          metadata: this.metadata,
          geoBounds: this.geoBounds,
          dataTimestamp: this.dataTimestamp,
          createdAt: this.createdAt,
        })
      )
      .digest('hex');

    return {
      request_id: this.id,
      request_hash: requestHash,
      data_type: this.dataType,
      service_type: this.serviceType,
      size_gb: this.requirements.sizeGB,
      reliability_level: this.requirements.reliabilityLevel,
      access_pattern: this.requirements.accessPattern,
      retention_days: this.requirements.retentionPeriodDays,
      encrypted: this.requirements.encryptionRequired,
      reward: this.reward,
      requester: this.requester,
      status: this.status,
    };
  }
}

// Storage result data structure
class StorageResult {
  constructor(options = {}) {
    this.requestId = options.requestId;
    this.storageNodeId = options.storageNodeId;
    this.resultId = options.resultId || `result-${Date.now().toString(36)}`;
    this.completedAt = options.completedAt || new Date().toISOString();
    this.status = options.status || 'completed';
    this.location = options.location || {
      provider: StorageServiceType.IPFS,
      reference: null, // Will be filled in after data upload
    };
    this.size = options.size || { bytes: 0, formattedSize: '0 B' };
    this.checksums = options.checksums || {
      sha256: null,
      blake2b: null,
    };
    this.encryptionDetails = options.encryptionDetails;
    this.accessMethods = options.accessMethods || [
      {
        type: 'http',
        url: null, // Will be filled in after data upload
      },
    ];
    this.verificationProof = options.verificationProof;
    this.storageDeal = options.storageDeal; // Provider-specific deal information
  }

  // Validate the storage result
  validate() {
    const errors = [];

    if (!this.requestId) errors.push('Request ID is required');
    if (!this.storageNodeId) errors.push('Storage node ID is required');
    if (!this.location.reference)
      errors.push('Storage location reference is required');

    if (!this.checksums.sha256) {
      errors.push('SHA-256 checksum is required');
    }

    if (!this.size.bytes || this.size.bytes <= 0) {
      errors.push('Storage size must be positive');
    }

    if (this.status === 'completed' && !this.accessMethods.some(m => m.url)) {
      errors.push(
        'At least one access method with URL is required for completed storage'
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Prepare storage result for blockchain submission
  prepareForBlockchain() {
    // Generate a unique result hash for verification
    const resultHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          requestId: this.requestId,
          storageNodeId: this.storageNodeId,
          completedAt: this.completedAt,
          location: this.location,
          checksums: this.checksums,
        })
      )
      .digest('hex');

    return {
      request_id: this.requestId,
      result_id: this.resultId,
      result_hash: resultHash,
      storage_node_id: this.storageNodeId,
      completed_at: this.completedAt,
      status: this.status,
      location: this.location,
      size_bytes: this.size.bytes,
      sha256_checksum: this.checksums.sha256,
      verification_proof: this.verificationProof,
    };
  }
}

// Storage node class
class StorageKeeperNode {
  constructor(options = {}) {
    this.nodeId = options.nodeId || `node-${Date.now().toString(36)}`;
    this.nodeName = options.nodeName || 'Unnamed Storage Keeper Node';
    this.capacity = options.capacity || {
      totalGB: 1000,
      availableGB: 1000,
    };
    this.supportedServices = options.supportedServices || [
      StorageServiceType.IPFS,
    ];
    this.geographicRegion = options.geographicRegion; // Physical region of the node
    this.operatorAddress = options.operatorAddress;
    this.status = options.status || 'online';
    this.endpoints = options.endpoints || {
      api: `http://storage-api.wrfcoin.net/node/${this.nodeId}`,
      gateway: `http://gateway.wrfcoin.net/node/${this.nodeId}`,
    };
    this.requestQueue = [];
    this.completedRequests = [];
    this.reputation = options.reputation || 1.0;
    this.lastSeen = options.lastSeen || new Date().toISOString();
    this.totalStoredItems = options.totalStoredItems || 0;
    this.successfulRetrievals = options.successfulRetrievals || 0;
    this.dataAvailability = options.dataAvailability || 0.999; // 99.9% default availability
    this.storedDataMap = new Map(); // Map of stored data references
  }

  // Queue a new storage request
  queueRequest(request) {
    // Check if service is supported
    if (!this.supportedServices.includes(request.serviceType)) {
      return {
        success: false,
        error: `Service ${request.serviceType} not supported by this node`,
      };
    }

    // Check if enough capacity is available
    if (request.requirements.sizeGB > this.capacity.availableGB) {
      return {
        success: false,
        error: `Insufficient storage capacity. Requested: ${request.requirements.sizeGB}GB, Available: ${this.capacity.availableGB}GB`,
      };
    }

    // Add to queue
    this.requestQueue.push({
      request,
      queuedAt: new Date().toISOString(),
      status: 'queued',
    });

    return {
      success: true,
      queuePosition: this.requestQueue.length,
      estimatedStartTime: this._calculateEstimatedStartTime(
        this.requestQueue.length - 1
      ),
    };
  }

  // Calculate estimated start time for a request at given queue position
  _calculateEstimatedStartTime(queuePosition) {
    // Simple estimation based on queue position and average processing time
    const averageProcessingMinutes = 5; // minutes per GB
    const requestSize =
      this.requestQueue[queuePosition]?.request.requirements.sizeGB || 1;
    const delay = queuePosition * averageProcessingMinutes * requestSize;

    const startTime = new Date();
    startTime.setMinutes(startTime.getMinutes() + delay);

    return startTime.toISOString();
  }

  // Process the next request in queue
  async processNextRequest() {
    if (this.requestQueue.length === 0) {
      return {
        success: false,
        error: 'No requests in queue',
      };
    }

    const requestEntry = this.requestQueue.shift();
    requestEntry.status = 'processing';
    requestEntry.startedAt = new Date().toISOString();

    try {
      // Simulate storage process
      const result = await this._simulateStorage(requestEntry.request);

      // Update capacity
      this.capacity.availableGB -= requestEntry.request.requirements.sizeGB;

      // Record successful completion
      this.totalStoredItems++;
      this.completedRequests.push({
        request: requestEntry.request,
        result,
        completedAt: new Date().toISOString(),
      });

      // Add to stored data map
      this.storedDataMap.set(result.resultId, {
        requestId: requestEntry.request.id,
        reference: result.location.reference,
        size: result.size.bytes,
        dataType: requestEntry.request.dataType,
        storedAt: result.completedAt,
      });

      // Update reputation
      this._updateReputation(true);

      return {
        success: true,
        requestId: requestEntry.request.id,
        resultId: result.resultId,
      };
    } catch (error) {
      // Update reputation on failure
      this._updateReputation(false);

      return {
        success: false,
        requestId: requestEntry.request.id,
        error: error.message,
      };
    }
  }

  // Simulate storage process
  async _simulateStorage(request) {
    // For simulation, create a realistic duration based on request complexity
    const processingTimeSeconds = request.requirements.sizeGB * 2;

    // Simulate the actual storage with a delay
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(2000, processingTimeSeconds * 100))
    );

    // Calculate realistic size in bytes
    const sizeBytes = request.requirements.sizeGB * 1024 * 1024 * 1024;
    const formattedSize = this._formatSize(sizeBytes);

    // Generate SHA-256 checksum
    const sha256Checksum = crypto
      .createHash('sha256')
      .update(request.id + Date.now().toString())
      .digest('hex');

    // Generate BLAKE2b checksum (often used in IPFS and Filecoin)
    const blake2bChecksum = crypto
      .createHash('blake2b512')
      .update(request.id + Date.now().toString())
      .digest('hex');

    // Generate reference based on storage service
    let reference, url;
    switch (request.serviceType) {
      case StorageServiceType.IPFS:
        reference = `ipfs://Qm${crypto.randomBytes(16).toString('hex')}`;
        url = `https://ipfs.wrfcoin.net/ipfs/${reference.substring(7)}`;
        break;
      case StorageServiceType.FILECOIN:
        reference = `filecoin://${crypto.randomBytes(20).toString('hex')}`;
        url = `https://filecoin.wrfcoin.net/filecoin/${reference.substring(11)}`;
        break;
      case StorageServiceType.ARWEAVE:
        reference = `ar://${crypto.randomBytes(20).toString('hex')}`;
        url = `https://arweave.wrfcoin.net/tx/${reference.substring(5)}`;
        break;
      case StorageServiceType.STORJ:
        reference = `storj://${crypto.randomBytes(20).toString('hex')}`;
        url = `https://link.storjshare.io/s/${reference.substring(8)}`;
        break;
      default:
        reference = `${request.serviceType}://${crypto.randomBytes(16).toString('hex')}`;
        url = `https://${request.serviceType}.wrfcoin.net/${reference.substring(request.serviceType.length + 3)}`;
    }

    // Prepare result
    const result = new StorageResult({
      requestId: request.id,
      storageNodeId: this.nodeId,
      completedAt: new Date().toISOString(),
      status: 'completed',
      location: {
        provider: request.serviceType,
        reference,
      },
      size: {
        bytes: sizeBytes,
        formattedSize,
      },
      checksums: {
        sha256: sha256Checksum,
        blake2b: blake2bChecksum,
      },
      accessMethods: [
        {
          type: 'http',
          url,
        },
      ],
    });

    // If encryption was requested, add details
    if (request.requirements.encryptionRequired) {
      result.encryptionDetails = {
        algorithm: 'AES-256-GCM',
        keyDerivation: 'PBKDF2',
        encryptedKey: crypto.randomBytes(16).toString('hex'),
      };
    }

    // Add provider-specific deal information
    if (request.serviceType === StorageServiceType.FILECOIN) {
      result.storageDeal = {
        dealId: `f0${Math.floor(Math.random() * 1000000)}`,
        startEpoch: Math.floor(Date.now() / 1000),
        endEpoch:
          Math.floor(Date.now() / 1000) +
          request.requirements.retentionPeriodDays * 86400,
        minerAddress: `f0${Math.floor(Math.random() * 100000)}`,
        price: `${Math.floor(Math.random() * 1000)} attoFIL`,
      };
    }

    return result;
  }

  // Format size in human-readable format
  _formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // Update node reputation based on success or failure
  _updateReputation(success) {
    if (success) {
      // Slowly increase reputation for successful storage
      this.reputation = Math.min(5.0, this.reputation + 0.01);
    } else {
      // More severely punish failures
      this.reputation = Math.max(0, this.reputation - 0.05);
    }
    return this.reputation;
  }

  // Retrieve data by reference
  async retrieveData(reference) {
    // Check if we have this data
    const dataEntry = Array.from(this.storedDataMap.values()).find(
      entry => entry.reference === reference
    );

    if (!dataEntry) {
      return {
        success: false,
        error: `Data with reference ${reference} not found`,
      };
    }

    // Simulate retrieval process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Update stats
    this.successfulRetrievals++;

    return {
      success: true,
      dataType: dataEntry.dataType,
      size: {
        bytes: dataEntry.size,
        formattedSize: this._formatSize(dataEntry.size),
      },
      storedAt: dataEntry.storedAt,
      accessMethods: [
        {
          type: 'http',
          url: `https://${this.nodeId}.gateway.wrfcoin.net/${reference.substring(reference.indexOf('://') + 3)}`,
        },
      ],
    };
  }

  // Get node status and statistics
  getStatus() {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      status: this.status,
      capacity: {
        totalGB: this.capacity.totalGB,
        availableGB: this.capacity.availableGB,
        usedGB: this.capacity.totalGB - this.capacity.availableGB,
        usedPercentage:
          ((this.capacity.totalGB - this.capacity.availableGB) /
            this.capacity.totalGB) *
          100,
      },
      supportedServices: this.supportedServices,
      queueLength: this.requestQueue.length,
      reputation: this.reputation,
      dataAvailability: this.dataAvailability,
      storedItems: this.totalStoredItems,
      retrievals: this.successfulRetrievals,
      endpoints: this.endpoints,
    };
  }
}

// Storage Keeper Network Manager
class StorageKeeperManager {
  constructor() {
    this.nodes = [];
    this.requests = [];
    this.pendingRequests = [];
    this.completedRequests = [];
    this.failedRequests = [];
    this.storagePolicies = {
      defaultReplication: 2,
      minReliabilityScore: 0.95,
      servicePreferences: [
        StorageServiceType.IPFS,
        StorageServiceType.FILECOIN,
      ],
    };
  }

  // Register a new storage node
  registerNode(node) {
    const existingIndex = this.nodes.findIndex(n => n.nodeId === node.nodeId);
    if (existingIndex >= 0) {
      this.nodes[existingIndex] = node;
      return {
        success: true,
        message: 'Node updated',
        nodeId: node.nodeId,
      };
    } else {
      this.nodes.push(node);
      return {
        success: true,
        message: 'Node registered',
        nodeId: node.nodeId,
      };
    }
  }

  // Submit a new storage request
  submitRequest(request) {
    const validation = request.validate();
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    this.requests.push(request);
    this.pendingRequests.push(request);

    // Attempt to assign the request to suitable nodes
    const assignedNodes = this._assignRequestToNodes(request);

    return {
      success: true,
      requestId: request.id,
      assignedNodes,
      message: 'Storage request submitted',
    };
  }

  // Match and assign requests to suitable nodes
  _assignRequestToNodes(request) {
    // Determine replication factor based on reliability level
    let replicationFactor = this.storagePolicies.defaultReplication;
    if (request.requirements.reliabilityLevel === ReliabilityLevel.CRITICAL) {
      replicationFactor = 3;
    } else if (
      request.requirements.reliabilityLevel === ReliabilityLevel.HIGH
    ) {
      replicationFactor = 2;
    } else if (
      request.requirements.reliabilityLevel === ReliabilityLevel.ARCHIVAL
    ) {
      replicationFactor = 1;
    }

    // Find eligible nodes that can handle this request
    let eligibleNodes = this.nodes.filter(node => {
      // Check if online
      if (node.status !== 'online') return false;

      // Check service support
      if (!node.supportedServices.includes(request.serviceType)) return false;

      // Check capacity
      if (node.capacity.availableGB < request.requirements.sizeGB) return false;

      // Check geographic restrictions if applicable
      if (request.requirements.geoRestriction && node.geographicRegion) {
        if (
          !request.requirements.geoRestriction.includes(node.geographicRegion)
        ) {
          return false;
        }
      }

      // Check data availability against requirements (assuming lower latency needs higher availability)
      const requiredAvailability =
        1 - request.requirements.maxLatencyMs / 10000;
      if (node.dataAvailability < requiredAvailability) return false;

      return true;
    });

    if (eligibleNodes.length === 0) {
      // No eligible nodes, keep in pending
      return [];
    }

    // Sort eligible nodes by reputation and available capacity
    eligibleNodes.sort((a, b) => {
      // First prioritize by reputation
      const reputationDiff = b.reputation - a.reputation;
      if (Math.abs(reputationDiff) > 0.5) return reputationDiff;

      // Then prioritize by available capacity percentage
      const aAvailPercent = a.capacity.availableGB / a.capacity.totalGB;
      const bAvailPercent = b.capacity.availableGB / b.capacity.totalGB;
      return bAvailPercent - aAvailPercent;
    });

    // Take only the top nodes based on replication factor
    eligibleNodes = eligibleNodes.slice(0, replicationFactor);

    // Assign to selected nodes
    const assignedNodeIds = [];
    for (const node of eligibleNodes) {
      const result = node.queueRequest(request);

      if (result.success) {
        assignedNodeIds.push(node.nodeId);
      }
    }

    if (assignedNodeIds.length > 0) {
      // Update request status
      request.status = 'assigned';

      // Remove from pending
      const pendingIndex = this.pendingRequests.findIndex(
        r => r.id === request.id
      );
      if (pendingIndex >= 0) {
        this.pendingRequests.splice(pendingIndex, 1);
      }
    }

    return assignedNodeIds;
  }

  // Process results submitted by storage nodes
  processResult(result) {
    const validation = result.validate();
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    // Find the original request
    const requestIndex = this.requests.findIndex(
      r => r.id === result.requestId
    );
    if (requestIndex < 0) {
      return {
        success: false,
        error: 'Request not found',
      };
    }

    const request = this.requests[requestIndex];
    request.status = 'completed';

    // Add to completed requests
    this.completedRequests.push({
      request,
      result,
      processedAt: new Date().toISOString(),
    });

    // Prepare for blockchain
    const blockchainData = result.prepareForBlockchain();

    return {
      success: true,
      requestId: request.id,
      resultId: result.resultId,
      blockchainData,
    };
  }

  // Find storage locations for a data reference
  async findDataLocations(reference) {
    const locations = [];

    // Search through all nodes
    for (const node of this.nodes) {
      if (node.status !== 'online') continue;

      // Check node's stored data
      const hasData = Array.from(node.storedDataMap.values()).some(
        entry => entry.reference === reference
      );

      if (hasData) {
        locations.push({
          nodeId: node.nodeId,
          nodeName: node.nodeName,
          reputation: node.reputation,
          dataAvailability: node.dataAvailability,
          accessEndpoint: node.endpoints.gateway,
        });
      }
    }

    return {
      reference,
      locationsFound: locations.length,
      locations,
    };
  }

  // Get network status and statistics
  getNetworkStatus() {
    // Calculate total network capacity
    const capacity = this.nodes.reduce(
      (total, node) => {
        if (node.status === 'online') {
          total.totalGB += node.capacity.totalGB;
          total.availableGB += node.capacity.availableGB;
        }
        return total;
      },
      { totalGB: 0, availableGB: 0 }
    );

    // Calculate average node reputation
    const avgReputation =
      this.nodes.length > 0
        ? this.nodes.reduce((sum, node) => sum + node.reputation, 0) /
          this.nodes.length
        : 0;

    // Calculate service distribution
    const serviceDistribution = {};
    for (const node of this.nodes) {
      for (const service of node.supportedServices) {
        serviceDistribution[service] = (serviceDistribution[service] || 0) + 1;
      }
    }

    // Calculate stored data by type
    const dataTypeDistribution = {};
    for (const node of this.nodes) {
      for (const data of node.storedDataMap.values()) {
        dataTypeDistribution[data.dataType] =
          (dataTypeDistribution[data.dataType] || 0) + data.size;
      }
    }

    return {
      activeNodes: this.nodes.filter(n => n.status === 'online').length,
      totalNodes: this.nodes.length,
      capacity: {
        totalGB: capacity.totalGB,
        availableGB: capacity.availableGB,
        usedGB: capacity.totalGB - capacity.availableGB,
        usedPercentage:
          capacity.totalGB > 0
            ? ((capacity.totalGB - capacity.availableGB) / capacity.totalGB) *
              100
            : 0,
      },
      pendingRequests: this.pendingRequests.length,
      completedRequests: this.completedRequests.length,
      failedRequests: this.failedRequests.length,
      averageNodeReputation: avgReputation,
      serviceDistribution,
      dataTypeDistribution,
    };
  }
}

module.exports = {
  StorageServiceType,
  StorageDataType,
  ReliabilityLevel,
  AccessPattern,
  StorageRequirements,
  StorageRequest,
  StorageResult,
  StorageKeeperNode,
  StorageKeeperManager,
};
