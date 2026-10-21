/**
 * Proximity-Based Incentives System for Wrfcoin
 *
 * providing higher rewards for computational tasks executed in proximity to the data source
 * or target region.
 */

const crypto = require('crypto');

// Earth's radius in km
const EARTH_RADIUS_KM = 6371;

// Incentive scaling factors
const SCALING_FACTORS = {
  DISTANCE: {
    // Distance scaling tiers (in kilometers)
    LOCAL: 10, // Within 10km - full bonus (1.5x)
    REGIONAL: 100, // Within 100km - reduced bonus (1.3x)
    DISTANT: 1000, // Within 1000km - minimal bonus (1.1x)
    REMOTE: Number.MAX_SAFE_INTEGER, // Beyond 1000km - no bonus (1.0x)
  },
  NETWORK_CONGESTION: {
    LOW: 1.2, // Low congestion bonus
    MEDIUM: 1.1, // Medium congestion bonus
    HIGH: 1.0, // High congestion (no bonus)
  },
  TIME_SENSITIVITY: {
    URGENT: 1.5, // Urgent data (high bonus)
    STANDARD: 1.2, // Standard time sensitivity
    RELAXED: 1.0, // No time sensitivity (no bonus)
  },
  DATA_QUALITY: {
    SENSOR_DENSITY: 0.2, // Bonus multiplier for sensor density
    UPDATE_FREQUENCY: 0.2, // Bonus multiplier for data update frequency
    ACCURACY: 0.2, // Bonus multiplier for accuracy
  },
};

// Bonus factors based on distance tiers
const DISTANCE_BONUS_FACTORS = {
  LOCAL: 1.5,
  REGIONAL: 1.3,
  DISTANT: 1.1,
  REMOTE: 1.0,
};

/**
 * ProximityIncentiveCalculator class
 * Handles calculation of incentives based on proximity and other factors
 */
class ProximityIncentiveCalculator {
  /**
   * Calculate the Haversine distance between two points on Earth
   *
   * @param {number} lat1 - Latitude of point 1 in degrees
   * @param {number} lon1 - Longitude of point 1 in degrees
   * @param {number} lat2 - Latitude of point 2 in degrees
   * @param {number} lon2 - Longitude of point 2 in degrees
   * @returns {number} - Distance in kilometers
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    // Convert latitude and longitude from degrees to radians
    const toRadians = degree => degree * (Math.PI / 180);

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    // Haversine formula
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = EARTH_RADIUS_KM * c;

    return distance;
  }

  /**
   * Determine the distance tier for a given distance
   *
   * @param {number} distance - Distance in kilometers
   * @returns {string} - Distance tier (LOCAL, REGIONAL, DISTANT, REMOTE)
   */
  getDistanceTier(distance) {
    if (distance <= SCALING_FACTORS.DISTANCE.LOCAL) {
      return 'LOCAL';
    } else if (distance <= SCALING_FACTORS.DISTANCE.REGIONAL) {
      return 'REGIONAL';
    } else if (distance <= SCALING_FACTORS.DISTANCE.DISTANT) {
      return 'DISTANT';
    } else {
      return 'REMOTE';
    }
  }

  /**
   * Calculate the distance multiplier based on distance between nodes
   *
   * @param {number} distance - Distance in kilometers
   * @returns {number} - Distance multiplier (1.0 - 1.5)
   */
  calculateDistanceMultiplier(distance) {
    const tier = this.getDistanceTier(distance);
    return DISTANCE_BONUS_FACTORS[tier];
  }

  /**
   * Calculate the network congestion multiplier
   *
   * @param {Object} networkState - Current network state
   * @returns {number} - Network congestion multiplier
   */
  calculateNetworkCongestionMultiplier(networkState) {
    if (!networkState) return SCALING_FACTORS.NETWORK_CONGESTION.MEDIUM;

    // Determine congestion level based on transaction backlog and node saturation
    const { pendingTransactions, nodeUsage, transactionThroughput } =
      networkState;

    if (pendingTransactions < 5 && nodeUsage < 0.5) {
      return SCALING_FACTORS.NETWORK_CONGESTION.LOW;
    } else if (pendingTransactions > 20 || nodeUsage > 0.8) {
      return SCALING_FACTORS.NETWORK_CONGESTION.HIGH;
    } else {
      return SCALING_FACTORS.NETWORK_CONGESTION.MEDIUM;
    }
  }

  /**
   * Calculate time sensitivity multiplier based on data age and urgency
   *
   * @param {Object} taskData - Task data with time sensitivity information
   * @returns {number} - Time sensitivity multiplier
   */
  calculateTimeSensitivityMultiplier(taskData) {
    if (!taskData) return SCALING_FACTORS.TIME_SENSITIVITY.STANDARD;

    // Determine time sensitivity based on task priority and deadlines
    const { priority, deadline, createdAt } = taskData;

    if (!priority || !deadline)
      return SCALING_FACTORS.TIME_SENSITIVITY.STANDARD;

    const now = Date.now();
    const creationTime = createdAt || now;
    const deadlineTime = new Date(deadline).getTime();

    // Calculate how much time remains before deadline as a percentage of total allowed time
    const totalAllowedTime = deadlineTime - creationTime;
    const remainingTime = deadlineTime - now;
    const remainingPercentage = remainingTime / totalAllowedTime;

    if (priority === 'high' || remainingPercentage < 0.2) {
      return SCALING_FACTORS.TIME_SENSITIVITY.URGENT;
    } else if (priority === 'low' && remainingPercentage > 0.5) {
      return SCALING_FACTORS.TIME_SENSITIVITY.RELAXED;
    } else {
      return SCALING_FACTORS.TIME_SENSITIVITY.STANDARD;
    }
  }

  /**
   * Calculate a data quality multiplier based on various quality metrics
   *
   * @param {Object} dataMetrics - Metrics regarding data quality
   * @returns {number} - Data quality multiplier
   */
  calculateDataQualityMultiplier(dataMetrics) {
    if (!dataMetrics) return 1.0;

    let qualityScore = 1.0;

    // Add bonuses for sensor density if applicable
    if (dataMetrics.sensorDensity) {
      const densityFactor = Math.min(dataMetrics.sensorDensity / 10, 1);
      qualityScore +=
        SCALING_FACTORS.DATA_QUALITY.SENSOR_DENSITY * densityFactor;
    }

    // Add bonuses for update frequency if applicable
    if (dataMetrics.updateFrequencyMinutes) {
      // Lower is better for update frequency
      const frequencyFactor = Math.min(
        60 / dataMetrics.updateFrequencyMinutes,
        1
      );
      qualityScore +=
        SCALING_FACTORS.DATA_QUALITY.UPDATE_FREQUENCY * frequencyFactor;
    }

    // Add bonuses for accuracy if applicable
    if (dataMetrics.accuracyScore) {
      const accuracyFactor = dataMetrics.accuracyScore;
      qualityScore += SCALING_FACTORS.DATA_QUALITY.ACCURACY * accuracyFactor;
    }

    return qualityScore;
  }

  /**
   * Calculate the final proximity incentive for a computational task
   *
   * @param {Object} task - Task details including coordinates and requirements
   * @param {Object} node - Node details including coordinates and capabilities
   * @param {Object} networkState - Current network state
   * @returns {Object} - The calculated incentive details
   */
  calculateProximityIncentive(task, node, networkState) {
    // Calculate base distance between task region and node
    const distance = this.calculateDistance(
      task.latitude,
      task.longitude,
      node.latitude,
      node.longitude
    );

    // Calculate the distance multiplier
    const distanceMultiplier = this.calculateDistanceMultiplier(distance);

    // Calculate other multipliers
    const networkCongestionMultiplier =
      this.calculateNetworkCongestionMultiplier(networkState);
    const timeSensitivityMultiplier =
      this.calculateTimeSensitivityMultiplier(task);
    const dataQualityMultiplier = this.calculateDataQualityMultiplier(
      task.dataMetrics
    );

    // Calculate the total multiplier (capped at maximum 3.0)
    let totalMultiplier =
      distanceMultiplier *
      networkCongestionMultiplier *
      timeSensitivityMultiplier *
      dataQualityMultiplier;

    // Cap the maximum multiplier
    totalMultiplier = Math.min(totalMultiplier, 3.0);

    // Base reward in WRFC tokens
    const baseReward = task.baseReward || 10;

    // Calculate final reward
    const finalReward = baseReward * totalMultiplier;

    // Generate a unique incentive ID for tracking
    const incentiveId = crypto
      .createHash('sha256')
      .update(`${task.id}-${node.id}-${Date.now()}`)
      .digest('hex');

    // Return detailed incentive information
    return {
      incentiveId,
      taskId: task.id,
      nodeId: node.id,
      timestamp: Date.now(),
      baseReward,
      finalReward,
      multipliers: {
        distance: distanceMultiplier,
        networkCongestion: networkCongestionMultiplier,
        timeSensitivity: timeSensitivityMultiplier,
        dataQuality: dataQualityMultiplier,
        total: totalMultiplier,
      },
      metrics: {
        distanceKm: distance,
        distanceTier: this.getDistanceTier(distance),
        timeSensitivity: task.priority || 'standard',
      },
    };
  }

  /**
   * Calculate optimal node selection based on proximity and capabilities
   *
   * @param {Object} task - Task details
   * @param {Array<Object>} availableNodes - List of available nodes
   * @param {Object} networkState - Current network state
   * @returns {Array<Object>} - Sorted list of nodes with incentives
   */
  selectOptimalNodes(task, availableNodes, networkState) {
    if (!task || !availableNodes || availableNodes.length === 0) {
      return [];
    }

    // Calculate incentives for each node
    const nodesWithIncentives = availableNodes.map(node => {
      const incentive = this.calculateProximityIncentive(
        task,
        node,
        networkState
      );
      return {
        ...node,
        incentive,
        // Calculate a combined score based on proximity, capabilities, and reliability
        // 20% weight on capability match
        score:
          incentive.multipliers.total * 0.6 + // 60% weight on proximity/incentive factors
          (node.reliability || 0.5) * 0.2 + // 20% weight on node reliability
          (node.capabilityScore || 0.5) * 0.2,
      };
    });

    // Sort nodes by score (descending)
    return nodesWithIncentives.sort((a, b) => b.score - a.score);
  }

  /**
   * Create incentive distribution for a multi-node task
   * This is used for tasks that require multiple nodes to collaborate
   *
   * @param {Object} task - Task details
   * @param {Array<Object>} selectedNodes - Selected nodes for the task
   * @param {Object} networkState - Current network state
   * @returns {Object} - Incentive distribution details
   */
  createIncentiveDistribution(task, selectedNodes, networkState) {
    if (!task || !selectedNodes || selectedNodes.length === 0) {
      return null;
    }

    const totalBaseReward = task.baseReward || 10;
    let totalWeight = 0;

    // Calculate the total weight based on node scores
    selectedNodes.forEach(node => {
      totalWeight += node.score || 1;
    });

    // Calculate individual rewards based on proportional contribution
    const nodeRewards = selectedNodes.map(node => {
      const weight = node.score || 1;
      const proportion = weight / totalWeight;
      const reward = totalBaseReward * proportion;

      return {
        nodeId: node.id,
        weight,
        proportion,
        reward,
      };
    });

    // Generate a unique distribution ID
    const distributionId = crypto
      .createHash('sha256')
      .update(`${task.id}-distribution-${Date.now()}`)
      .digest('hex');

    return {
      distributionId,
      taskId: task.id,
      timestamp: Date.now(),
      totalReward: totalBaseReward,
      totalWeight,
      nodeRewards,
      verificationRequired: task.requiresVerification || false,
    };
  }
}

// Export as singleton
const proximityIncentiveCalculator = new ProximityIncentiveCalculator();
module.exports = { proximityIncentiveCalculator };
