/**
 * WRFCoin ETL Framework
 * Core framework for building ETL pipelines.
 */

/**
 * Base ETL Pipeline class
 */
class ETLPipeline {
  constructor(options = {}) {
    this.name = options.name || 'default-pipeline';
    this.source = options.source || null;
    this.destination = options.destination || null;
    this.transformers = options.transformers || [];
    this.batchSize = options.batchSize || 1000;
    this.state = {
      status: 'idle',
      processedRecords: 0,
      errors: [],
      startTime: null,
      endTime: null
    };
  }

  /**
   * Add a transformer to the pipeline
   */
  addTransformer(transformer) {
    if (typeof transformer !== 'function') {
      throw new Error('Transformer must be a function');
    }
    this.transformers.push(transformer);
    return this;
  }

  /**
   * Set the data source
   */
  setSource(source) {
    this.source = source;
    return this;
  }

  /**
   * Set the destination
   */
  setDestination(destination) {
    this.destination = destination;
    return this;
  }

  /**
   * Extract data from source
   */
  async extract() {
    if (!this.source) {
      throw new Error('Source not configured');
    }

    if (typeof this.source.extract === 'function') {
      return await this.source.extract();
    }

    if (typeof this.source === 'function') {
      return await this.source();
    }

    return this.source;
  }

  /**
   * Transform data through all transformers
   */
  async transform(data) {
    let result = data;

    for (const transformer of this.transformers) {
      try {
        result = await transformer(result);
      } catch (error) {
        this.state.errors.push({
          stage: 'transform',
          error: error.message,
          timestamp: new Date().toISOString()
        });
        throw error;
      }
    }

    return result;
  }

  /**
   * Load data to destination
   */
  async load(data) {
    if (!this.destination) {
      throw new Error('Destination not configured');
    }

    if (typeof this.destination.load === 'function') {
      return await this.destination.load(data);
    }

    if (typeof this.destination === 'function') {
      return await this.destination(data);
    }

    throw new Error('Destination must have a load method or be a function');
  }

  /**
   * Run the complete ETL pipeline
   */
  async run() {
    this.state.status = 'running';
    this.state.startTime = new Date().toISOString();

    try {
      // Extract
      console.log(`[${this.name}] Starting extraction...`);
      const extractedData = await this.extract();
      console.log(`[${this.name}] Extracted ${Array.isArray(extractedData) ? extractedData.length : 1} records`);

      // Transform
      console.log(`[${this.name}] Starting transformation...`);
      const transformedData = await this.transform(extractedData);
      console.log(`[${this.name}] Transformation complete`);

      // Load
      console.log(`[${this.name}] Starting load...`);
      const loadResult = await this.load(transformedData);
      console.log(`[${this.name}] Load complete`);

      this.state.status = 'completed';
      this.state.endTime = new Date().toISOString();
      this.state.processedRecords = Array.isArray(transformedData) ? transformedData.length : 1;

      return {
        success: true,
        pipeline: this.name,
        processedRecords: this.state.processedRecords,
        duration: new Date(this.state.endTime) - new Date(this.state.startTime),
        result: loadResult
      };
    } catch (error) {
      this.state.status = 'failed';
      this.state.endTime = new Date().toISOString();
      this.state.errors.push({
        stage: 'pipeline',
        error: error.message,
        timestamp: new Date().toISOString()
      });

      return {
        success: false,
        pipeline: this.name,
        error: error.message,
        errors: this.state.errors
      };
    }
  }

  /**
   * Get pipeline state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Reset pipeline state
   */
  reset() {
    this.state = {
      status: 'idle',
      processedRecords: 0,
      errors: [],
      startTime: null,
      endTime: null
    };
    return this;
  }
}

/**
 * Common transformers
 */
const Transformers = {
  /**
   * Filter records based on predicate
   */
  filter: (predicate) => (data) => {
    if (!Array.isArray(data)) return data;
    return data.filter(predicate);
  },

  /**
   * Map records through a function
   */
  map: (mapper) => (data) => {
    if (!Array.isArray(data)) return mapper(data);
    return data.map(mapper);
  },

  /**
   * Normalize numeric fields
   */
  normalize: (fields) => (data) => {
    if (!Array.isArray(data) || data.length === 0) return data;

    const stats = {};
    fields.forEach(field => {
      const values = data.map(d => d[field]).filter(v => typeof v === 'number');
      stats[field] = {
        min: Math.min(...values),
        max: Math.max(...values)
      };
    });

    return data.map(record => {
      const normalized = { ...record };
      fields.forEach(field => {
        if (typeof record[field] === 'number') {
          const { min, max } = stats[field];
          normalized[field] = max !== min ? (record[field] - min) / (max - min) : 0;
        }
      });
      return normalized;
    });
  },

  /**
   * Remove null/undefined values
   */
  removeNulls: () => (data) => {
    if (!Array.isArray(data)) return data;
    return data.filter(record => {
      return Object.values(record).every(v => v !== null && v !== undefined);
    });
  },

  /**
   * Add timestamp to records
   */
  addTimestamp: () => (data) => {
    const timestamp = new Date().toISOString();
    if (!Array.isArray(data)) return { ...data, _processedAt: timestamp };
    return data.map(record => ({ ...record, _processedAt: timestamp }));
  },

  /**
   * Validate records against a schema
   */
  validate: (schema) => (data) => {
    const validate = (record) => {
      for (const [field, rules] of Object.entries(schema)) {
        if (rules.required && (record[field] === null || record[field] === undefined)) {
          throw new Error(`Required field '${field}' is missing`);
        }
        if (rules.type && record[field] !== undefined && typeof record[field] !== rules.type) {
          throw new Error(`Field '${field}' must be of type '${rules.type}'`);
        }
      }
      return record;
    };

    if (!Array.isArray(data)) return validate(data);
    return data.map(validate);
  }
};

/**
 * Create a new pipeline
 */
function createPipeline(options) {
  return new ETLPipeline(options);
}

module.exports = {
  ETLPipeline,
  Transformers,
  createPipeline
};
