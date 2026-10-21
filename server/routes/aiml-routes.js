/**
 * AI/ML Networks Routes
 * Handles machine learning inference and model management
 */

const express = require('express');
const router = express.Router();
const {
  sanitizeObject,
  detectXSS,
  validateEnum,
  validateNumericRange,
} = require('../../shared/utils/input-sanitizer');
const { requireAuth } = require('../middleware/authMiddleware');

// Valid model names for inference
const VALID_MODELS = ['Weather Prediction', 'Price Forecasting', 'Risk Assessment'];

// Valid model types for training
const VALID_MODEL_TYPES = ['weather', 'price', 'risk', 'custom'];

// Validation middleware for POST requests
const validatePostBody = (req, res, next) => {
  // Check for XSS in the entire body
  if (req.body && detectXSS(JSON.stringify(req.body))) {
    return res.status(400).json({
      success: false,
      error: 'Invalid characters detected in request body',
    });
  }
  next();
};

// AI/ML inference endpoint
// SECURITY: Requires authentication - inference has associated costs
router.post('/inference', requireAuth, validatePostBody, (req, res) => {
  const { model, input_data, prediction_horizon } = req.body;

  // Validate required fields
  if (!model || !input_data) {
    return res
      .status(400)
      .json({ success: false, error: 'Model and input_data required' });
  }

  // Validate model is a string
  if (typeof model !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'Model must be a string' });
  }

  // Validate model name
  if (!VALID_MODELS.includes(model)) {
    return res.status(400).json({
      success: false,
      error: `Invalid model. Must be one of: ${VALID_MODELS.join(', ')}`,
    });
  }

  // Validate input_data is an object
  if (typeof input_data !== 'object' || input_data === null || Array.isArray(input_data)) {
    return res
      .status(400)
      .json({ success: false, error: 'input_data must be an object' });
  }

  // Validate prediction_horizon if provided
  if (prediction_horizon !== undefined && typeof prediction_horizon !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'prediction_horizon must be a string' });
  }

  // Validate prediction_horizon format (e.g., "24h", "7d", "1w")
  if (prediction_horizon !== undefined && !/^\d+[hdwm]$/i.test(prediction_horizon)) {
    return res
      .status(400)
      .json({ success: false, error: 'prediction_horizon must be in format like "24h", "7d", "1w"' });
  }

  // Sanitize inputs
  const sanitizedModel = sanitizeObject(model);
  const sanitizedInputData = sanitizeObject(input_data);
  const sanitizedPredictionHorizon = prediction_horizon ? sanitizeObject(prediction_horizon) : undefined;

  // Generate a deterministic-looking prediction based on model and input
  const now = new Date();
  const requestId = `inf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Build model-specific mock predictions
  const predictions = {
    'Weather Prediction': () => {
      const temp = sanitizedInputData.temperature ?? 20;
      const humidity = sanitizedInputData.humidity ?? 50;
      return {
        predicted_temperature: +(temp + (Math.random() * 4 - 2)).toFixed(1),
        predicted_humidity: +Math.min(100, Math.max(0, humidity + (Math.random() * 10 - 5))).toFixed(1),
        predicted_pressure: +(1013.25 + (Math.random() * 10 - 5)).toFixed(2),
        precipitation_probability: +(Math.random() * 0.6).toFixed(3),
        condition: ['clear', 'partly_cloudy', 'cloudy', 'rain', 'storm'][Math.floor(Math.random() * 5)],
      };
    },
    'Price Forecasting': () => {
      const basePrice = sanitizedInputData.current_price ?? sanitizedInputData.price ?? 1.0;
      const change = (Math.random() * 0.2 - 0.1);
      return {
        predicted_price: +(basePrice * (1 + change)).toFixed(4),
        price_change_pct: +(change * 100).toFixed(2),
        support_level: +(basePrice * 0.92).toFixed(4),
        resistance_level: +(basePrice * 1.08).toFixed(4),
        trend: change > 0.03 ? 'bullish' : change < -0.03 ? 'bearish' : 'neutral',
      };
    },
    'Risk Assessment': () => {
      const riskScore = +(Math.random() * 0.7 + 0.1).toFixed(3);
      return {
        risk_score: riskScore,
        risk_level: riskScore > 0.6 ? 'high' : riskScore > 0.3 ? 'medium' : 'low',
        factors: [
          { name: 'market_volatility', weight: +(Math.random() * 0.5).toFixed(3) },
          { name: 'liquidity_risk', weight: +(Math.random() * 0.4).toFixed(3) },
          { name: 'credit_exposure', weight: +(Math.random() * 0.3).toFixed(3) },
        ],
        recommendation: riskScore > 0.6 ? 'reduce_exposure' : riskScore > 0.3 ? 'monitor' : 'acceptable',
      };
    },
  };

  const predictionFn = predictions[sanitizedModel];
  const result = predictionFn ? predictionFn() : {};

  return res.status(200).json({
    success: true,
    request_id: requestId,
    model: sanitizedModel,
    prediction_horizon: sanitizedPredictionHorizon || '24h',
    prediction: result,
    confidence: +(0.75 + Math.random() * 0.2).toFixed(3),
    model_version: '1.0.0',
    computed_at: now.toISOString(),
    latency_ms: Math.floor(Math.random() * 150 + 50),
  });
});

// Get available AI/ML models
router.get('/models', (req, res) => {
  res.json({
    success: true,
    total: 3,
    models: [
      {
        id: 'model-weather-v1',
        name: 'Weather Prediction',
        type: 'weather',
        version: '1.2.0',
        status: 'active',
        description:
          'Advanced weather forecasting using satellite and ground station data',
        input_schema: {
          required: ['temperature', 'humidity'],
          optional: ['pressure', 'wind_speed', 'wind_direction', 'cloud_cover'],
          types: {
            temperature: 'number',
            humidity: 'number',
            pressure: 'number',
            wind_speed: 'number',
            wind_direction: 'number',
            cloud_cover: 'number',
          },
        },
        metrics: {
          accuracy: 0.942,
          precision: 0.938,
          recall: 0.945,
          f1_score: 0.941,
        },
        cost_per_inference: '0.05 WRF',
        training_data_size: 1250000,
        created_at: '2025-09-15T08:00:00Z',
        updated_at: '2026-02-20T14:30:00Z',
      },
      {
        id: 'model-price-v1',
        name: 'Price Forecasting',
        type: 'price',
        version: '2.0.1',
        status: 'active',
        description: 'Cryptocurrency and commodity price prediction using market indicators',
        input_schema: {
          required: ['historical_prices', 'volume'],
          optional: ['market_indicators', 'sentiment_score', 'current_price', 'price'],
          types: {
            historical_prices: 'array<number>',
            volume: 'number',
            market_indicators: 'object',
            sentiment_score: 'number',
            current_price: 'number',
            price: 'number',
          },
        },
        metrics: {
          accuracy: 0.876,
          precision: 0.881,
          recall: 0.870,
          f1_score: 0.875,
        },
        cost_per_inference: '0.08 WRF',
        training_data_size: 890000,
        created_at: '2025-10-01T12:00:00Z',
        updated_at: '2026-03-10T09:15:00Z',
      },
      {
        id: 'model-risk-v1',
        name: 'Risk Assessment',
        type: 'risk',
        version: '1.1.0',
        status: 'active',
        description: 'Financial and environmental risk analysis for portfolio management',
        input_schema: {
          required: ['risk_factors'],
          optional: ['historical_data', 'market_conditions', 'exposure_amount'],
          types: {
            risk_factors: 'array<object>',
            historical_data: 'object',
            market_conditions: 'object',
            exposure_amount: 'number',
          },
        },
        metrics: {
          accuracy: 0.891,
          precision: 0.895,
          recall: 0.887,
          f1_score: 0.891,
        },
        cost_per_inference: '0.06 WRF',
        training_data_size: 620000,
        created_at: '2025-11-20T10:00:00Z',
        updated_at: '2026-01-28T16:45:00Z',
      },
    ],
  });
});

// Model training endpoint
// SECURITY: Requires authentication - training has significant associated costs
router.post('/training', requireAuth, validatePostBody, (req, res) => {
  const { model_type, training_data, parameters } = req.body;

  // Validate required fields
  if (!model_type || !training_data) {
    return res
      .status(400)
      .json({ success: false, error: 'Model type and training data required' });
  }

  // Validate model_type is a string
  if (typeof model_type !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'model_type must be a string' });
  }

  // Validate model_type value
  if (!VALID_MODEL_TYPES.includes(model_type.toLowerCase())) {
    return res.status(400).json({
      success: false,
      error: `Invalid model_type. Must be one of: ${VALID_MODEL_TYPES.join(', ')}`,
    });
  }

  // Validate training_data is an object or array
  if (typeof training_data !== 'object' || training_data === null) {
    return res
      .status(400)
      .json({ success: false, error: 'training_data must be an object or array' });
  }

  // Validate parameters if provided
  if (parameters !== undefined && (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters))) {
    return res
      .status(400)
      .json({ success: false, error: 'parameters must be an object' });
  }

  // Validate training data has minimum required entries
  const dataEntries = Array.isArray(training_data) ? training_data.length : Object.keys(training_data).length;
  if (dataEntries < 1) {
    return res
      .status(400)
      .json({ success: false, error: 'training_data must contain at least one entry' });
  }

  // Limit training data size
  if (dataEntries > 10000) {
    return res
      .status(400)
      .json({ success: false, error: 'training_data exceeds maximum allowed size of 10000 entries' });
  }

  // Sanitize inputs
  const sanitizedModelType = sanitizeObject(model_type);
  const sanitizedTrainingData = sanitizeObject(training_data);
  const sanitizedParameters = parameters ? sanitizeObject(parameters) : {};

  const now = new Date();
  const jobId = `train-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Estimate training time based on data size and parameters
  const epochs = sanitizedParameters.epochs ?? 10;
  const estimatedMinutes = Math.ceil(dataEntries * epochs * 0.002);

  return res.status(202).json({
    success: true,
    job_id: jobId,
    status: 'queued',
    model_type: sanitizedModelType.toLowerCase(),
    config: {
      epochs,
      learning_rate: sanitizedParameters.learning_rate ?? 0.001,
      batch_size: sanitizedParameters.batch_size ?? 32,
      validation_split: sanitizedParameters.validation_split ?? 0.2,
    },
    training_data_entries: dataEntries,
    estimated_duration_minutes: estimatedMinutes,
    queue_position: Math.floor(Math.random() * 5) + 1,
    created_at: now.toISOString(),
    estimated_completion: new Date(now.getTime() + estimatedMinutes * 60000).toISOString(),
    status_url: `/aiml/training/${jobId}/status`,
  });
});

module.exports = router;
