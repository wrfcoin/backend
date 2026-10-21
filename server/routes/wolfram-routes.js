/**
 * Wolfram Alpha & Language Integration Routes
 *
 * This file defines all API routes for the Wolfram Alpha & Wolfram Language
 * integration in the Wrfcoin Core platform.
 */

const express = require('express');
const router = express.Router();
const wolframController = require('../controllers/wolframController');

// Get integration status
router.get('/status', wolframController.getStatus);

// Get settings
router.get('/settings', wolframController.getSettings);

// Update settings
router.put('/settings', wolframController.updateSettings);

// Query Wolfram Alpha
router.post('/query', wolframController.query);

// Get short answer from Wolfram Alpha
router.post('/short-answer', wolframController.getShortAnswer);

// Get full results from Wolfram Alpha
router.post('/full-results', wolframController.getFullResults);

// Execute Wolfram Language code
router.post('/execute', wolframController.executeWolframLanguage);

// Analyze weather data using Wolfram computational intelligence
router.post('/analyze-weather', wolframController.analyzeWeatherData);

// Run a climate model using Wolfram
router.post('/run-climate-model', wolframController.runClimateModel);

// Process natural language with Wolfram
router.post(
  '/process-natural-language',
  wolframController.processNaturalLanguage
);

module.exports = router;
