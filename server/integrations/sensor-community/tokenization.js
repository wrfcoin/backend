/**
 * Sensor.Community Tokenization System
 *
 * This module handles the tokenization and rewards for Sensor.Community
 * operators. It calculates rewards based on data quality, consistency,
 * and geographic distribution of sensors.
 */

const { QUALITY_LEVELS } = require('./data-validator');
const logger = require('../../utils/logger')('sensor-community:tokenization');

// Token reward constants
const REWARD_CONSTANTS = {
  // Base reward for each data submission (in WRF tokens)
  BASE_REWARD: 0.01,

  // Quality multipliers
  QUALITY_MULTIPLIERS: {
    [QUALITY_LEVELS.HIGH]: 1.0,
    [QUALITY_LEVELS.MEDIUM]: 0.5,
    [QUALITY_LEVELS.LOW]: 0.1,
    [QUALITY_LEVELS.INVALID]: 0,
  },

  // Geographic distribution bonus (for sensors in underrepresented areas)
  GEO_BONUS_MAX: 2.0,

  // Consistency bonus (for sensors with regular data submission)
  CONSISTENCY_BONUS_MAX: 1.5,

  // Special event bonus (e.g., during air quality emergencies)
  SPECIAL_EVENT_BONUS: 3.0,

  // Data diversity bonus (for sensors that provide multiple measurement types)
  DIVERSITY_BONUS_PER_TYPE: 0.1,

  // Maximum data types considered for diversity bonus
  MAX_DIVERSITY_TYPES: 5,
};

class SensorCommunityTokenizer {
  constructor(options = {}) {
    this.options = {
      enableSpecialEvents: false,
      geographicBonusMap: null, // Map of geographic areas to bonus multipliers
      ...options,
    };

    logger.info('Initializing Sensor.Community tokenization system');
  }

  /**
   * Calculate rewards for a sensor data submission
   * @param {Object} sensorData - The sensor data in Wrfcoin format
   * @param {Object} validationResult - Validation results for this data
   * @param {Object} sensorHistory - Historical data and metadata for this sensor
   * @returns {Object} - The calculated reward information
   */
  calculateReward(sensorData, validationResult, sensorHistory = {}) {
    if (!sensorData || !validationResult) {
      return {
        totalReward: 0,
        components: {},
        reasons: ['Invalid data or validation result'],
      };
    }

    // Start with base reward
    let reward = REWARD_CONSTANTS.BASE_REWARD;
    const components = { base: REWARD_CONSTANTS.BASE_REWARD };
    const reasons = [];

    // Apply quality multiplier
    const qualityMultiplier =
      REWARD_CONSTANTS.QUALITY_MULTIPLIERS[validationResult.qualityLevel] || 0;
    reward *= qualityMultiplier;
    components.quality =
      REWARD_CONSTANTS.BASE_REWARD * qualityMultiplier -
      REWARD_CONSTANTS.BASE_REWARD;

    if (qualityMultiplier <= 0) {
      return {
        totalReward: 0,
        components,
        reasons: ['Data quality too low for reward'],
      };
    }

    // Apply geographic distribution bonus if we have a bonus map
    let geoBonus = 0;
    if (this.options.geographicBonusMap && sensorData.location) {
      geoBonus = this._calculateGeographicBonus(sensorData.location);
      reward += geoBonus;
      components.geographic = geoBonus;

      if (geoBonus > 0) {
        reasons.push(
          `Sensor in underrepresented geographic area: +${geoBonus.toFixed(4)} WRF`
        );
      }
    }

    // Apply consistency bonus if we have history
    let consistencyBonus = 0;
    if (sensorHistory.submissions) {
      consistencyBonus = this._calculateConsistencyBonus(
        sensorHistory.submissions
      );
      reward += consistencyBonus;
      components.consistency = consistencyBonus;

      if (consistencyBonus > 0) {
        reasons.push(
          `Consistent data submissions: +${consistencyBonus.toFixed(4)} WRF`
        );
      }
    }

    // Apply data diversity bonus
    const diversityTypes = sensorData.measurements
      ? Object.keys(sensorData.measurements)
      : [];
    let diversityBonus = 0;

    if (diversityTypes.length > 1) {
      // Cap at the maximum number of types we reward for
      const bonusTypes = Math.min(
        diversityTypes.length,
        REWARD_CONSTANTS.MAX_DIVERSITY_TYPES
      );
      diversityBonus =
        (bonusTypes - 1) * REWARD_CONSTANTS.DIVERSITY_BONUS_PER_TYPE;
      reward += diversityBonus;
      components.diversity = diversityBonus;

      reasons.push(
        `Multiple measurement types (${diversityTypes.join(', ')}): +${diversityBonus.toFixed(4)} WRF`
      );
    }

    // Apply special event bonus if enabled and applicable
    let specialEventBonus = 0;
    if (
      this.options.enableSpecialEvents &&
      this._isInSpecialEvent(sensorData)
    ) {
      specialEventBonus = REWARD_CONSTANTS.SPECIAL_EVENT_BONUS;
      reward += specialEventBonus;
      components.specialEvent = specialEventBonus;

      reasons.push(`Special event bonus: +${specialEventBonus.toFixed(4)} WRF`);
    }

    logger.debug(`Calculated reward for sensor ${sensorData.sourceId}`, {
      totalReward: reward,
      components,
    });

    return {
      totalReward: parseFloat(reward.toFixed(6)),
      components,
      reasons,
    };
  }

  /**
   * Calculate bonus for sensors in underrepresented areas
   * @private
   * @param {Object} location - The sensor location { latitude, longitude }
   * @returns {number} - The geographic bonus amount
   */
  _calculateGeographicBonus(location) {
    if (
      !this.options.geographicBonusMap ||
      !location ||
      !location.latitude ||
      !location.longitude
    ) {
      return 0;
    }

    // Simple implementation: check if the location falls within any bonus regions
    for (const region of this.options.geographicBonusMap) {
      if (this._isLocationInRegion(location, region)) {
        return REWARD_CONSTANTS.BASE_REWARD * region.bonusMultiplier;
      }
    }

    return 0;
  }

  /**
   * Check if a location falls within a defined region
   * @private
   * @param {Object} location - The sensor location { latitude, longitude }
   * @param {Object} region - The region definition { bounds, bonusMultiplier }
   * @returns {boolean} - True if the location is in the region
   */
  _isLocationInRegion(location, region) {
    const { bounds } = region;

    // Simple bounding box check
    return (
      location.latitude >= bounds.south &&
      location.latitude <= bounds.north &&
      location.longitude >= bounds.west &&
      location.longitude <= bounds.east
    );
  }

  /**
   * Calculate bonus for sensors with consistent data submission
   * @private
   * @param {Array} submissions - Array of submission records with timestamps
   * @returns {number} - The consistency bonus amount
   */
  _calculateConsistencyBonus(submissions) {
    if (!submissions || submissions.length < 3) {
      return 0;
    }

    // Calculate the average time between submissions
    const intervals = [];
    for (let i = 1; i < submissions.length; i++) {
      const current = new Date(submissions[i].timestamp).getTime();
      const previous = new Date(submissions[i - 1].timestamp).getTime();
      intervals.push(current - previous);
    }

    // Calculate the standard deviation of intervals
    const avgInterval =
      intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const variances = intervals.map(interval =>
      Math.pow(interval - avgInterval, 2)
    );
    const stdDev = Math.sqrt(
      variances.reduce((sum, val) => sum + val, 0) / variances.length
    );

    // Calculate consistency score (lower stdDev means more consistent)
    // Normalize to a value between 0 and 1
    const maxExpectedStdDev = avgInterval; // If stdDev equals the average, it's very inconsistent
    const consistencyScore = Math.max(0, 1 - stdDev / maxExpectedStdDev);

    // Apply bonus based on consistency score
    return (
      REWARD_CONSTANTS.BASE_REWARD *
      consistencyScore *
      REWARD_CONSTANTS.CONSISTENCY_BONUS_MAX
    );
  }

  /**
   * Check if the sensor data was submitted during a special event
   * @private
   * @param {Object} sensorData - The sensor data
   * @returns {boolean} - True if the data was submitted during a special event
   */
  _isInSpecialEvent(sensorData) {
    if (!this.options.enableSpecialEvents || !this.options.specialEvents) {
      return false;
    }

    const timestamp = new Date(sensorData.timestamp).getTime();

    // Check if the timestamp falls within any special event period
    for (const event of this.options.specialEvents) {
      const start = new Date(event.startDate).getTime();
      const end = new Date(event.endDate).getTime();

      if (timestamp >= start && timestamp <= end) {
        // If the event has geographic restrictions, check those too
        if (event.geographicRestriction && sensorData.location) {
          if (
            this._isLocationInRegion(sensorData.location, {
              bounds: event.geographicRestriction,
            })
          ) {
            return true;
          }
        } else {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Set the geographic bonus map
   * @param {Array} bonusMap - Array of geographic regions with bonus multipliers
   */
  setGeographicBonusMap(bonusMap) {
    this.options.geographicBonusMap = bonusMap;
    logger.info(`Set geographic bonus map with ${bonusMap.length} regions`);
  }

  /**
   * Set special events
   * @param {Array} events - Array of special events
   */
  setSpecialEvents(events) {
    this.options.specialEvents = events;
    this.options.enableSpecialEvents = true;
    logger.info(`Set ${events.length} special events`);
  }

  /**
   * Disable special events
   */
  disableSpecialEvents() {
    this.options.enableSpecialEvents = false;
    logger.info('Disabled special events');
  }
}

module.exports = {
  SensorCommunityTokenizer,
  REWARD_CONSTANTS,
};
