/**
 * API Endpoint Validator for Wrfcoin Backend
 * Implements comprehensive input validation and sanitization
 */

const validator = require('validator');

class ApiEndpointValidator {
  constructor() {
    this.validationRules = new Map();
    this.sanitizationPipeline = new Map();
    this.customValidators = new Map();

    // Setup default validation rules
    this.setupDefaultRules();
  }

  setupDefaultRules() {
    // Wallet endpoints
    this.addValidationRule('/api/wallet/generate-mnemonic', {
      method: 'POST',
      body: {
        strength: { type: 'number', min: 128, max: 256, optional: true },
        language: {
          type: 'string',
          enum: ['english', 'japanese', 'chinese_simplified'],
          optional: true,
        },
      },
    });

    this.addValidationRule('/api/wallet/validate-mnemonic', {
      method: 'POST',
      body: {
        mnemonic: {
          type: 'string',
          required: true,
          minLength: 10,
          maxLength: 500,
        },
      },
    });

    // Governance endpoints
    this.addValidationRule('/api/governance/proposals', {
      method: 'POST',
      body: {
        title: { type: 'string', required: true, minLength: 5, maxLength: 200 },
        description: {
          type: 'string',
          required: true,
          minLength: 20,
          maxLength: 5000,
        },
        category: {
          type: 'string',
          enum: ['protocol', 'economic', 'governance', 'technical'],
        },
        votingPeriod: { type: 'number', min: 86400, max: 2592000 }, // 1 day to 30 days
      },
    });

    this.addValidationRule('/api/governance/vote', {
      method: 'POST',
      body: {
        proposalId: {
          type: 'string',
          required: true,
          pattern: /^[a-zA-Z0-9_-]+$/,
        },
        vote: { type: 'string', enum: ['yes', 'no', 'abstain'] },
        delegateVote: { type: 'boolean', optional: true },
      },
    });

    // Mining endpoints
    this.addValidationRule('/api/mining/config', {
      method: 'POST',
      body: {
        algorithm: {
          type: 'string',
          enum: ['sha256d', 'scrypt', 'x11', 'equihash'],
        },
        intensity: { type: 'number', min: 1, max: 31 },
        poolUrl: { type: 'string', required: true, isURL: true },
        workerName: {
          type: 'string',
          required: true,
          pattern: /^[a-zA-Z0-9_-]+$/,
        },
      },
    });

    // Weather endpoints
    this.addValidationRule('/api/weather/submit', {
      method: 'POST',
      body: {
        stationId: {
          type: 'string',
          required: true,
          pattern: /^[A-Z0-9]{8,16}$/,
        },
        temperature: { type: 'number', min: -100, max: 100 },
        humidity: { type: 'number', min: 0, max: 100 },
        pressure: { type: 'number', min: 800, max: 1200 },
        timestamp: { type: 'string', isISO8601: true },
      },
    });

    // Computational NFT endpoints
    this.addValidationRule('/api/computational/create', {
      method: 'POST',
      body: {
        name: { type: 'string', required: true, minLength: 3, maxLength: 100 },
        computationalPower: {
          type: 'string',
          required: true,
          pattern: /^\d+(\.\d+)?\s*(GH\/s|TH\/s|PH\/s)$/,
        },
        efficiency: { type: 'number', min: 0, max: 100 },
        metadata: { type: 'object', optional: true },
      },
    });
  }

  addValidationRule(endpoint, rule) {
    this.validationRules.set(endpoint, rule);
  }

  addCustomValidator(name, validatorFunction) {
    this.customValidators.set(name, validatorFunction);
  }

  // Main validation middleware
  middleware() {
    return (req, res, next) => {
      try {
        const endpoint = this.normalizeEndpoint(req.path);
        const rule = this.validationRules.get(endpoint);

        if (!rule) {
          // No specific validation rule - apply basic sanitization
          this.applySanitization(req);
          return next();
        }

        // Check HTTP method
        if (rule.method && req.method !== rule.method) {
          return this.validationError(
            res,
            `Method ${req.method} not allowed for ${endpoint}`
          );
        }

        // Validate request body
        if (rule.body && req.method !== 'GET') {
          const bodyValidation = this.validateObject(
            req.body || {},
            rule.body,
            'body'
          );
          if (!bodyValidation.valid) {
            return this.validationError(res, bodyValidation.errors);
          }
        }

        // Validate query parameters
        if (rule.query) {
          const queryValidation = this.validateObject(
            req.query || {},
            rule.query,
            'query'
          );
          if (!queryValidation.valid) {
            return this.validationError(res, queryValidation.errors);
          }
        }

        // Validate path parameters
        if (rule.params) {
          const paramsValidation = this.validateObject(
            req.params || {},
            rule.params,
            'params'
          );
          if (!paramsValidation.valid) {
            return this.validationError(res, paramsValidation.errors);
          }
        }

        // Apply sanitization
        this.applySanitization(req);

        // Validation passed
        next();
      } catch (error) {
        console.error('Validation middleware error:', error);
        return res.status(500).json({
          error: 'Validation processing failed',
          message: error.message,
        });
      }
    };
  }

  validateObject(obj, rules, context) {
    const errors = [];

    // Check required fields
    for (const [field, rule] of Object.entries(rules)) {
      if (rule.required && !(field in obj)) {
        errors.push(`${context}.${field} is required`);
        continue;
      }

      if (field in obj) {
        const fieldErrors = this.validateField(
          obj[field],
          rule,
          `${context}.${field}`
        );
        errors.push(...fieldErrors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  validateField(value, rule, fieldPath) {
    const errors = [];

    // Type validation
    if (rule.type) {
      if (!this.validateType(value, rule.type)) {
        errors.push(`${fieldPath} must be of type ${rule.type}`);
        return errors; // Don't continue if type is wrong
      }
    }

    // String validations
    if (rule.type === 'string' && typeof value === 'string') {
      if (rule.minLength && value.length < rule.minLength) {
        errors.push(
          `${fieldPath} must be at least ${rule.minLength} characters`
        );
      }
      if (rule.maxLength && value.length > rule.maxLength) {
        errors.push(
          `${fieldPath} must be at most ${rule.maxLength} characters`
        );
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push(`${fieldPath} format is invalid`);
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`${fieldPath} must be one of: ${rule.enum.join(', ')}`);
      }
      if (rule.isEmail && !validator.isEmail(value)) {
        errors.push(`${fieldPath} must be a valid email`);
      }
      if (rule.isURL && !validator.isURL(value)) {
        errors.push(`${fieldPath} must be a valid URL`);
      }
      if (rule.isISO8601 && !validator.isISO8601(value)) {
        errors.push(`${fieldPath} must be a valid ISO8601 date`);
      }
    }

    // Number validations
    if (rule.type === 'number' && typeof value === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${fieldPath} must be at least ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${fieldPath} must be at most ${rule.max}`);
      }
      if (rule.integer && !Number.isInteger(value)) {
        errors.push(`${fieldPath} must be an integer`);
      }
    }

    // Custom validation
    if (rule.custom && this.customValidators.has(rule.custom)) {
      const customValidator = this.customValidators.get(rule.custom);
      const customResult = customValidator(value);
      if (!customResult.valid) {
        errors.push(`${fieldPath} ${customResult.message}`);
      }
    }

    return errors;
  }

  validateType(value, expectedType) {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return (
          typeof value === 'object' && value !== null && !Array.isArray(value)
        );
      case 'array':
        return Array.isArray(value);
      default:
        return true;
    }
  }

  applySanitization(req) {
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
      req.body = this.sanitizeObject(req.body);
    }

    // Sanitize query
    if (req.query && typeof req.query === 'object') {
      req.query = this.sanitizeObject(req.query);
    }
  }

  sanitizeObject(obj) {
    const sanitized = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        // Basic XSS prevention
        sanitized[key] = validator.escape(value.trim());
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  normalizeEndpoint(path) {
    // Remove trailing slashes and normalize paths
    return path.replace(/\/+$/, '') || '/';
  }

  validationError(res, errors) {
    return res.status(400).json({
      error: 'Validation failed',
      details: Array.isArray(errors) ? errors : [errors],
      timestamp: new Date().toISOString(),
    });
  }

  // Get validation statistics
  getValidationStats() {
    return {
      totalRules: this.validationRules.size,
      customValidators: this.customValidators.size,
      endpoints: Array.from(this.validationRules.keys()),
      lastUpdated: new Date().toISOString(),
    };
  }
}

module.exports = ApiEndpointValidator;
