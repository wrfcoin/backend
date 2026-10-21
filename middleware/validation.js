/**
 * Input Validation Middleware
 * Validates and sanitizes user inputs
 */

const { body, param, query, validationResult } = require('express-validator');
const DOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const window = new JSDOM('').window;
const purify = DOMPurify(window);

// Common validation rules
const validateAddress = body('address')
  .isLength({ min: 42, max: 42 })
  .matches(/^0x[a-fA-F0-9]{40}$/)
  .withMessage('Invalid Ethereum address format');

const validateAmount = body('amount')
  .isFloat({ min: 0.0001, max: 1000000 })
  .withMessage('Amount must be between 0.0001 and 1,000,000');

const validateChain = body('chain')
  .isIn(['ethereum', 'polygon', 'bsc', 'avalanche', 'arbitrum', 'optimism'])
  .withMessage('Unsupported blockchain network');

// Sanitization middleware
const sanitizeInput = (req, res, next) => {
  // Sanitize string inputs
  for (const key in req.body) {
    if (typeof req.body[key] === 'string') {
      req.body[key] = purify.sanitize(req.body[key]);
    }
  }
  next();
};

// Error handling for validation
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
};

module.exports = {
  validateAddress,
  validateAmount,
  validateChain,
  sanitizeInput,
  handleValidationErrors,
};
