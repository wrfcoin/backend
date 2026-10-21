/**
 * Proof of Publishing (PoP) Validator
 *
 * This module provides validation functions for environmental data submissions.
 * It verifies the legitimacy and accuracy of submitted data.
 */

const {
  ENV_DATA_TYPES,
  CONFIDENCE_LEVELS,
  getConfidenceLevel,
} = require('./types');
const logger = require('../../../utils/logger');

// Create dedicated logger
const validatorLogger = logger('pop:validator');

/**
 * Validate a submission based on its data type
 * @param {Object} submission - The submission to validate
 * @returns {Object} Validation result with score and notes
 */
function validateSubmission(submission) {
  validatorLogger.info(
    `Validating submission ${submission.submissionId} of type ${submission.dataType}`
  );

  // Check if submission has required fields
  if (
    !submission.submissionId ||
    !submission.dataType ||
    !submission.location ||
    !submission.measurements
  ) {
    validatorLogger.warn(
      `Submission ${submission.submissionId} missing required fields`
    );
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'Missing required submission fields',
    };
  }

  // Validate based on data type
  switch (submission.dataType) {
    case ENV_DATA_TYPES.WEATHER:
      return validateWeatherData(submission);
    case ENV_DATA_TYPES.AIR_QUALITY:
      return validateAirQualityData(submission);
    case ENV_DATA_TYPES.WATER_QUALITY:
      return validateWaterQualityData(submission);
    case ENV_DATA_TYPES.SOIL:
      return validateSoilData(submission);
    case ENV_DATA_TYPES.CLIMATE:
      return validateClimateData(submission);
    case ENV_DATA_TYPES.BIODIVERSITY:
      return validateBiodiversityData(submission);
    case ENV_DATA_TYPES.ECOSYSTEM:
      return validateEcosystemData(submission);
    default:
      validatorLogger.warn(`Unknown data type ${submission.dataType}`);
      return {
        isValid: false,
        score: 0,
        confidenceLevel: CONFIDENCE_LEVELS.LOW,
        notes: `Unknown data type: ${submission.dataType}`,
      };
  }
}

/**
 * Validate weather data
 * @param {Object} submission - The submission to validate
 * @returns {Object} Validation result
 */
function validateWeatherData(submission) {
  validatorLogger.info(
    `Validating weather data for submission ${submission.submissionId}`
  );

  const { measurements } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Required parameters for weather data
  const requiredParams = [
    'temperature',
    'humidity',
    'pressure',
    'windSpeed',
    'windDirection',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Check for plausible values
  const tempMeasurement = measurements.find(m => m.parameter === 'temperature');
  if (tempMeasurement) {
    const tempValue = parseFloat(tempMeasurement.value);
    if (isNaN(tempValue) || tempValue < -100 || tempValue > 100) {
      notes.push('Temperature value outside plausible range');
      score -= 0.2;
    }
  }

  const humidityMeasurement = measurements.find(
    m => m.parameter === 'humidity'
  );
  if (humidityMeasurement) {
    const humidityValue = parseFloat(humidityMeasurement.value);
    if (isNaN(humidityValue) || humidityValue < 0 || humidityValue > 100) {
      notes.push('Humidity value outside plausible range (0-100%)');
      score -= 0.2;
    }
  }

  // Bonus for additional parameters
  const bonusParams = ['precipitation', 'visibility', 'cloudCover', 'uvIndex'];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

/**
 * Validate air quality data
 * @param {Object} submission - The submission to validate
 * @returns {Object} Validation result
 */
function validateAirQualityData(submission) {
  validatorLogger.info(
    `Validating air quality data for submission ${submission.submissionId}`
  );

  const { measurements } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Required parameters for air quality data
  const requiredParams = [
    'pm25',
    'pm10',
    'ozone',
    'nitrogenDioxide',
    'carbonMonoxide',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Check for plausible values
  const pm25Measurement = measurements.find(m => m.parameter === 'pm25');
  if (pm25Measurement) {
    const pm25Value = parseFloat(pm25Measurement.value);
    if (isNaN(pm25Value) || pm25Value < 0 || pm25Value > 1000) {
      notes.push('PM2.5 value outside plausible range');
      score -= 0.2;
    }
  }

  // Bonus for additional parameters
  const bonusParams = ['sulfurDioxide', 'lead', 'ammonia', 'voc'];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

/**
 * Validate water quality data
 * @param {Object} submission - The submission to validate
 * @returns {Object} Validation result
 */
function validateWaterQualityData(submission) {
  validatorLogger.info(
    `Validating water quality data for submission ${submission.submissionId}`
  );

  const { measurements } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Required parameters for water quality data
  const requiredParams = [
    'ph',
    'dissolvedOxygen',
    'temperature',
    'turbidity',
    'conductivity',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Check for plausible values
  const phMeasurement = measurements.find(m => m.parameter === 'ph');
  if (phMeasurement) {
    const phValue = parseFloat(phMeasurement.value);
    if (isNaN(phValue) || phValue < 0 || phValue > 14) {
      notes.push('pH value outside plausible range (0-14)');
      score -= 0.2;
    }
  }

  // Bonus for additional parameters
  const bonusParams = [
    'nitrate',
    'phosphate',
    'chlorophyll',
    'dissolvedSolids',
    'bacteria',
  ];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

/**
 * Validate soil data
 * @param {Object} submission - The submission to validate
 * @returns {Object} Validation result
 */
function validateSoilData(submission) {
  validatorLogger.info(
    `Validating soil data for submission ${submission.submissionId}`
  );

  const { measurements } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Required parameters for soil data
  const requiredParams = [
    'ph',
    'moisture',
    'temperature',
    'nitrogen',
    'phosphorus',
    'potassium',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Bonus for additional parameters
  const bonusParams = [
    'organicMatter',
    'salinity',
    'texture',
    'micronutrients',
    'soilType',
  ];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

function validateClimateData(submission) {
  validatorLogger.info(
    `Validating climate data for submission ${submission.submissionId}`
  );

  const { measurements, timeframe } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Climate data requires timeframe information
  if (!timeframe || !timeframe.start || !timeframe.end) {
    notes.push('Missing or incomplete timeframe data');
    score -= 0.3;
  }

  // Required parameters for climate data
  const requiredParams = [
    'temperatureAnomaly',
    'precipitationAnomaly',
    'greenhouseGasLevels',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Bonus for additional parameters
  const bonusParams = [
    'seaLevelRise',
    'iceExtent',
    'extremeWeatherEvents',
    'carbonFlux',
  ];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

function validateBiodiversityData(submission) {
  validatorLogger.info(
    `Validating biodiversity data for submission ${submission.submissionId}`
  );

  const { measurements, area } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Biodiversity data requires area information
  if (!area || !area.type || !area.coordinates) {
    notes.push('Missing or incomplete area data');
    score -= 0.3;
  }

  // Required parameters for biodiversity data
  const requiredParams = [
    'speciesCount',
    'speciesRichness',
    'speciesDiversity',
    'habitatType',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Bonus for additional parameters
  const bonusParams = [
    'endangeredSpecies',
    'invasiveSpecies',
    'habitatQuality',
    'populationTrends',
  ];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

function validateEcosystemData(submission) {
  validatorLogger.info(
    `Validating ecosystem data for submission ${submission.submissionId}`
  );

  const { measurements, ecosystem } = submission;
  let score = 0.0;
  const notes = [];

  // Check if measurements array exists and has data
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return {
      isValid: false,
      score: 0,
      confidenceLevel: CONFIDENCE_LEVELS.LOW,
      notes: 'No measurements provided',
    };
  }

  // Ecosystem data requires ecosystem information
  if (!ecosystem || !ecosystem.type) {
    notes.push('Missing or incomplete ecosystem data');
    score -= 0.3;
  }

  // Required parameters for ecosystem data
  const requiredParams = [
    'primaryProductivity',
    'ecosystemHealth',
    'biomass',
    'nutrientCycling',
  ];
  const missingParams = requiredParams.filter(
    param => !measurements.some(m => m.parameter === param)
  );

  if (missingParams.length > 0) {
    notes.push(`Missing required parameters: ${missingParams.join(', ')}`);
    score = Math.max(0, 0.5 - missingParams.length * 0.1);
  } else {
    score = 0.8; // Base score if all required parameters exist
  }

  // Bonus for additional parameters
  const bonusParams = [
    'foodWebStructure',
    'energyFlow',
    'disturbanceRegime',
    'ecosystemServices',
  ];
  const bonusCount = bonusParams.filter(param =>
    measurements.some(m => m.parameter === param)
  ).length;

  score += bonusCount * 0.05; // Add 5% per bonus parameter

  // Ensure score is within bounds
  score = Math.max(0, Math.min(1, score));

  return {
    isValid: score >= 0.6, // Require at least 60% score to be valid
    score,
    confidenceLevel: getConfidenceLevel(score),
    notes: notes.length > 0 ? notes.join('; ') : 'All checks passed',
  };
}

module.exports = {
  validateSubmission,
  validateWeatherData,
  validateAirQualityData,
  validateWaterQualityData,
  validateSoilData,
  validateClimateData,
  validateBiodiversityData,
  validateEcosystemData,
};
