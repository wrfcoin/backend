/**
 * Mock Wolfram Controller for Testing
 * Provides basic functionality to prevent server startup errors during testing
 */

const mockResponse = (
  message = 'Wolfram integration not available in test mode'
) => ({
  success: false,
  message,
  timestamp: new Date().toISOString(),
});

exports.getStatus = (req, res) => {
  res.json({
    status: 'disabled',
    message: 'Wolfram integration not configured',
    timestamp: new Date().toISOString(),
  });
};

exports.getSettings = (req, res) => {
  res.json({
    apiKey: null,
    enabled: false,
    features: [],
  });
};

exports.updateSettings = (req, res) => {
  res.json(mockResponse());
};

exports.query = (req, res) => {
  res.json(mockResponse('Query not available in test mode'));
};

exports.getShortAnswer = (req, res) => {
  res.json(mockResponse('Short answer not available in test mode'));
};

exports.getFullResults = (req, res) => {
  res.json(mockResponse('Full results not available in test mode'));
};

exports.executeWolframLanguage = (req, res) => {
  res.json(
    mockResponse('Wolfram Language execution not available in test mode')
  );
};

exports.analyzeWeatherData = (req, res) => {
  res.json(mockResponse('Weather analysis not available in test mode'));
};

exports.runClimateModel = (req, res) => {
  res.json(mockResponse('Climate model not available in test mode'));
};

exports.processNaturalLanguage = (req, res) => {
  res.json(
    mockResponse('Natural language processing not available in test mode')
  );
};
