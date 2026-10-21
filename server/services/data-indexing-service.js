/**
 * Data Indexing and Querying Service
 *
 * Advanced indexing and querying mechanisms for weather data and model outputs.
 * Provides high-performance search, spatial queries, and real-time data access.
 *
 * Features:
 * - Multi-dimensional indexing (temporal, spatial, quality)
 * - Advanced query optimization
 * - Caching strategies for frequently accessed data
 * - Real-time data streaming queries
 * - Full-text search capabilities
 * - Geospatial query support
 * - Aggregation and analytics queries
 * - Query performance monitoring and optimization
 */

const Logger = require('../utils/logger');
const { LRUCache } = require('lru-cache');

class DataIndexingService {
  constructor(options = {}) {
    this.options = {
      // Cache configuration
      cacheSize: options.cacheSize || 10000,
      cacheTTL: options.cacheTTL || 300000, // 5 minutes

      // Query optimization
      enableQueryCache: options.enableQueryCache !== false,
      enableQueryOptimization: options.enableQueryOptimization !== false,
      queryTimeoutMs: options.queryTimeoutMs || 30000,

      // Index configuration
      enableSpatialIndexes: options.enableSpatialIndexes !== false,
      enableFullTextSearch: options.enableFullTextSearch !== false,

      // Performance settings
      maxQueryComplexity: options.maxQueryComplexity || 1000,
      defaultPageSize: options.defaultPageSize || 100,
      maxPageSize: options.maxPageSize || 10000,

      // Aggregation settings
      enableAggregationCache: options.enableAggregationCache !== false,
      aggregationCacheTTL: options.aggregationCacheTTL || 600000, // 10 minutes

      ...options,
    };

    this.logger = Logger;
    this.storageManager = null; // Will be injected

    // Query cache
    this.queryCache = new LRUCache({
      max: this.options.cacheSize,
      ttl: this.options.cacheTTL,
    });

    // Aggregation cache
    this.aggregationCache = new LRUCache({
      max: Math.floor(this.options.cacheSize / 4),
      ttl: this.options.aggregationCacheTTL,
    });

    // Query performance metrics
    this.metrics = {
      totalQueries: 0,
      cachedQueries: 0,
      averageQueryTime: 0,
      slowQueries: 0,
      failedQueries: 0,
      indexUsage: {},
      popularQueries: new Map(),
    };

    // Index definitions
    this.indexDefinitions = {
      temporal: [
        {
          name: 'idx_weather_timestamp_btree',
          table: 'weather_data_timeseries',
          columns: ['timestamp'],
          type: 'btree',
          description: 'Primary temporal index for weather data',
        },
        {
          name: 'idx_weather_time_station',
          table: 'weather_data_timeseries',
          columns: ['timestamp', 'station_id'],
          type: 'btree',
          description: 'Composite temporal-station index',
        },
        {
          name: 'idx_model_execution_time',
          table: 'climate_model_outputs',
          columns: ['execution_timestamp'],
          type: 'btree',
          description: 'Model execution timeline index',
        },
      ],
      spatial: [
        {
          name: 'idx_weather_location_spatial',
          table: 'weather_data_timeseries',
          columns: ['location'],
          type: 'gist',
          description: 'Spatial index for geographic queries',
        },
        {
          name: 'idx_weather_coordinates',
          table: 'weather_data_timeseries',
          expression:
            "(((location->'latitude')::text)::double precision, ((location->'longitude')::text)::double precision)",
          type: 'gist',
          description: 'Coordinate-based spatial index',
        },
      ],
      quality: [
        {
          name: 'idx_weather_quality_score',
          table: 'weather_data_timeseries',
          columns: ['quality_score'],
          type: 'btree',
          description: 'Data quality filtering index',
        },
        {
          name: 'idx_quality_metrics_score',
          table: 'data_quality_metrics',
          columns: ['quality_score', 'data_type'],
          type: 'btree',
          description: 'Quality assessment index',
        },
      ],
      content: [
        {
          name: 'idx_weather_measurements_gin',
          table: 'weather_data_timeseries',
          columns: ['measurements'],
          type: 'gin',
          description: 'JSON content search index',
        },
        {
          name: 'idx_model_output_gin',
          table: 'climate_model_outputs',
          columns: ['output_data'],
          type: 'gin',
          description: 'Model output content index',
        },
      ],
    };

    // Query templates for common operations
    this.queryTemplates = {
      weatherByTimeRange: `
                SELECT * FROM weather_data_timeseries 
                WHERE timestamp BETWEEN $1 AND $2 
                ORDER BY timestamp DESC 
                LIMIT $3 OFFSET $4
            `,
      weatherByLocation: `
                SELECT * FROM weather_data_timeseries 
                WHERE ST_DWithin(
                    ST_Point(
                        (location->>'longitude')::double precision,
                        (location->>'latitude')::double precision
                    ),
                    ST_Point($1, $2),
                    $3
                )
                ORDER BY timestamp DESC 
                LIMIT $4 OFFSET $5
            `,
      weatherAggregation: `
                SELECT 
                    DATE_TRUNC($1, timestamp) as period,
                    station_id,
                    COUNT(*) as record_count,
                    AVG((measurements->>'temperature')::double precision) as avg_temperature,
                    AVG((measurements->>'humidity')::double precision) as avg_humidity,
                    AVG(quality_score) as avg_quality
                FROM weather_data_timeseries 
                WHERE timestamp BETWEEN $2 AND $3
                GROUP BY period, station_id
                ORDER BY period DESC
            `,
      modelOutputsByType: `
                SELECT * FROM climate_model_outputs 
                WHERE model_type = $1 
                AND execution_timestamp BETWEEN $2 AND $3
                ORDER BY execution_timestamp DESC
                LIMIT $4 OFFSET $5
            `,
    };
  }

  /**
   * Initialize the indexing service
   */
  async initialize(storageManager) {
    try {
      this.storageManager = storageManager;

      // Create performance indexes
      await this.createPerformanceIndexes();

      // Initialize spatial extension if needed
      if (this.options.enableSpatialIndexes) {
        await this.initializeSpatialExtensions();
      }

      // Setup full-text search if enabled
      if (this.options.enableFullTextSearch) {
        await this.setupFullTextSearch();
      }

      // Analyze and update query statistics
      await this.updateQueryStatistics();

      this.logger.info('Data Indexing Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Data Indexing Service:', error);
      throw error;
    }
  }

  /**
   * Create performance indexes based on definitions
   */
  async createPerformanceIndexes() {
    const allIndexes = [
      ...this.indexDefinitions.temporal,
      ...this.indexDefinitions.spatial,
      ...this.indexDefinitions.quality,
      ...this.indexDefinitions.content,
    ];

    for (const index of allIndexes) {
      try {
        await this.createIndex(index);
        this.logger.debug(`Index created: ${index.name}`);
      } catch (error) {
        this.logger.warn(
          `Failed to create index ${index.name}:`,
          error.message
        );
      }
    }
  }

  /**
   * Create individual index
   */
  async createIndex(indexDef) {
    let sql;

    if (indexDef.expression) {
      // Expression-based index
      sql = `
                CREATE INDEX IF NOT EXISTS ${indexDef.name}
                ON ${indexDef.table} USING ${indexDef.type || 'btree'}
                (${indexDef.expression})
            `;
    } else {
      // Column-based index
      sql = `
                CREATE INDEX IF NOT EXISTS ${indexDef.name}
                ON ${indexDef.table} USING ${indexDef.type || 'btree'}
                (${indexDef.columns.join(', ')})
            `;
    }

    await this.storageManager.pool.query(sql);
  }

  /**
   * Initialize spatial extensions
   */
  async initializeSpatialExtensions() {
    try {
      // Enable PostGIS extension for spatial queries
      await this.storageManager.pool.query(
        'CREATE EXTENSION IF NOT EXISTS postgis'
      );

      this.logger.info('PostGIS extension enabled for spatial queries');
    } catch (error) {
      this.logger.warn(
        'PostGIS extension not available, falling back to basic spatial queries:',
        error.message
      );
      this.options.enableSpatialIndexes = false;
    }
  }

  /**
   * Setup full-text search capabilities
   */
  async setupFullTextSearch() {
    try {
      // Create text search configuration
      await this.storageManager.pool.query(`
                CREATE TEXT SEARCH CONFIGURATION IF NOT EXISTS weather_search (COPY = english)
            `);

      // Create full-text search indexes
      const searchIndexes = [
        {
          table: 'weather_data_timeseries',
          columns: ['station_id', 'metadata'],
          name: 'idx_weather_fulltext',
        },
        {
          table: 'climate_model_outputs',
          columns: ['model_type', 'output_data'],
          name: 'idx_model_fulltext',
        },
      ];

      for (const searchIndex of searchIndexes) {
        await this.storageManager.pool.query(`
                    CREATE INDEX IF NOT EXISTS ${searchIndex.name}
                    ON ${searchIndex.table} USING gin(
                        to_tsvector('weather_search', 
                            COALESCE(${searchIndex.columns.join("::text, '') || COALESCE(")}, '')
                        )
                    )
                `);
      }

      this.logger.info('Full-text search indexes created');
    } catch (error) {
      this.logger.warn('Full-text search setup failed:', error.message);
      this.options.enableFullTextSearch = false;
    }
  }

  /**
   * Execute optimized query with caching
   */
  async executeQuery(queryKey, queryFn, cacheOptions = {}) {
    const startTime = Date.now();

    try {
      // Check cache first
      if (this.options.enableQueryCache) {
        const cached = this.queryCache.get(queryKey);
        if (cached) {
          this.metrics.cachedQueries++;
          this.updateQueryMetrics(Date.now() - startTime, true, true);
          return cached;
        }
      }

      // Execute query
      const result = await queryFn();

      // Cache result if enabled
      if (this.options.enableQueryCache && cacheOptions.cache !== false) {
        const ttl = cacheOptions.ttl || this.options.cacheTTL;
        this.queryCache.set(queryKey, result, { ttl });
      }

      this.updateQueryMetrics(Date.now() - startTime, true, false);
      this.trackPopularQuery(queryKey);

      return result;
    } catch (error) {
      this.updateQueryMetrics(Date.now() - startTime, false, false);
      this.logger.error(`Query failed: ${queryKey}`, error);
      throw error;
    }
  }

  /**
   * Query weather data by time range
   */
  async queryWeatherByTimeRange(startTime, endTime, options = {}) {
    const {
      limit = this.options.defaultPageSize,
      offset = 0,
      stationId = null,
      qualityThreshold = null,
      includeMetadata = false,
    } = options;

    const queryKey = `weather_time_${startTime}_${endTime}_${limit}_${offset}_${stationId}_${qualityThreshold}`;

    return await this.executeQuery(queryKey, async () => {
      let query = this.queryTemplates.weatherByTimeRange;
      const params = [
        startTime,
        endTime,
        Math.min(limit, this.options.maxPageSize),
        offset,
      ];

      // Add station filter if specified
      if (stationId) {
        query = query.replace(
          'WHERE timestamp BETWEEN $1 AND $2',
          'WHERE timestamp BETWEEN $1 AND $2 AND station_id = $5'
        );
        params.push(stationId);
      }

      // Add quality filter if specified
      if (qualityThreshold !== null) {
        const whereClause = stationId
          ? 'WHERE timestamp BETWEEN $1 AND $2 AND station_id = $5 AND quality_score >= $6'
          : 'WHERE timestamp BETWEEN $1 AND $2 AND quality_score >= $5';

        query = query.replace(/WHERE.*?(?=ORDER)/, whereClause);
        params.push(qualityThreshold);
      }

      const result = await this.storageManager.pool.query(query, params);

      return {
        data: result.rows,
        pagination: {
          limit,
          offset,
          total: await this.getWeatherDataCount(startTime, endTime, {
            stationId,
            qualityThreshold,
          }),
        },
      };
    });
  }

  /**
   * Query weather data by geographic location
   */
  async queryWeatherByLocation(latitude, longitude, radiusKm, options = {}) {
    const {
      limit = this.options.defaultPageSize,
      offset = 0,
      timeRange = null,
    } = options;

    const queryKey = `weather_location_${latitude}_${longitude}_${radiusKm}_${limit}_${offset}_${timeRange?.start}_${timeRange?.end}`;

    return await this.executeQuery(queryKey, async () => {
      let query = this.queryTemplates.weatherByLocation;
      const params = [
        longitude,
        latitude,
        radiusKm * 1000,
        Math.min(limit, this.options.maxPageSize),
        offset,
      ]; // Convert km to meters

      // Add time range filter if specified
      if (timeRange) {
        query = query.replace(
          /WHERE\s+ST_DWithin.*?\)/,
          `WHERE ST_DWithin(
                        ST_Point(
                            (location->>'longitude')::double precision,
                            (location->>'latitude')::double precision
                        ),
                        ST_Point($1, $2),
                        $3
                    ) AND timestamp BETWEEN $6 AND $7`
        );
        params.push(timeRange.start, timeRange.end);
      }

      const result = await this.storageManager.pool.query(query, params);

      return {
        data: result.rows,
        pagination: {
          limit,
          offset,
          total: await this.getLocationDataCount(
            latitude,
            longitude,
            radiusKm,
            timeRange
          ),
        },
      };
    });
  }

  /**
   * Execute aggregation queries with caching
   */
  async queryAggregatedWeatherData(aggregationType, timeRange, options = {}) {
    const {
      groupBy = 'day',
      stationId = null,
      includeQuality = true,
    } = options;

    const queryKey = `weather_agg_${aggregationType}_${groupBy}_${timeRange.start}_${timeRange.end}_${stationId}`;

    // Check aggregation cache
    if (this.options.enableAggregationCache) {
      const cached = this.aggregationCache.get(queryKey);
      if (cached) {
        return cached;
      }
    }

    try {
      let query = this.queryTemplates.weatherAggregation;
      const params = [groupBy, timeRange.start, timeRange.end];

      // Add station filter if specified
      if (stationId) {
        query = query.replace(
          'WHERE timestamp BETWEEN $2 AND $3',
          'WHERE timestamp BETWEEN $2 AND $3 AND station_id = $4'
        );
        params.push(stationId);
      }

      const result = await this.storageManager.pool.query(query, params);

      const aggregatedData = {
        aggregationType,
        groupBy,
        timeRange,
        data: result.rows,
        generatedAt: new Date(),
      };

      // Cache the result
      if (this.options.enableAggregationCache) {
        this.aggregationCache.set(queryKey, aggregatedData);
      }

      return aggregatedData;
    } catch (error) {
      this.logger.error('Aggregation query failed:', error);
      throw error;
    }
  }

  /**
   * Query climate model outputs
   */
  async queryModelOutputs(modelType, timeRange, options = {}) {
    const {
      limit = this.options.defaultPageSize,
      offset = 0,
      version = null,
      includeOutputData = false,
    } = options;

    const queryKey = `model_${modelType}_${timeRange.start}_${timeRange.end}_${limit}_${offset}_${version}`;

    return await this.executeQuery(queryKey, async () => {
      let query = this.queryTemplates.modelOutputsByType;
      const params = [
        modelType,
        timeRange.start,
        timeRange.end,
        Math.min(limit, this.options.maxPageSize),
        offset,
      ];

      // Add version filter if specified
      if (version) {
        query = query.replace(
          'WHERE model_type = $1',
          'WHERE model_type = $1 AND model_version = $6'
        );
        params.push(version);
      }

      // Exclude large output data by default
      if (!includeOutputData) {
        query = query.replace(
          'SELECT *',
          `SELECT 
                        id, model_run_id, model_type, model_version, execution_timestamp,
                        input_data_hash, output_file_path, output_format, file_size_bytes,
                        processing_time_ms, grid_resolution, forecast_horizon_hours,
                        quality_assessment, validation_metrics, created_at, data_version
                    `
        );
      }

      const result = await this.storageManager.pool.query(query, params);

      return {
        data: result.rows,
        pagination: {
          limit,
          offset,
          total: await this.getModelOutputCount(modelType, timeRange, version),
        },
      };
    });
  }

  /**
   * Execute full-text search
   */
  async searchWeatherData(searchText, options = {}) {
    if (!this.options.enableFullTextSearch) {
      throw new Error('Full-text search is not enabled');
    }

    const {
      limit = this.options.defaultPageSize,
      offset = 0,
      timeRange = null,
    } = options;

    const queryKey = `search_${searchText}_${limit}_${offset}_${timeRange?.start}_${timeRange?.end}`;

    return await this.executeQuery(queryKey, async () => {
      let query = `
                SELECT 
                    *,
                    ts_rank(
                        to_tsvector('weather_search', 
                            COALESCE(station_id, '') || ' ' || COALESCE(metadata::text, '')
                        ),
                        plainto_tsquery('weather_search', $1)
                    ) AS rank
                FROM weather_data_timeseries
                WHERE to_tsvector('weather_search', 
                    COALESCE(station_id, '') || ' ' || COALESCE(metadata::text, '')
                ) @@ plainto_tsquery('weather_search', $1)
            `;

      const params = [searchText];

      // Add time range filter if specified
      if (timeRange) {
        query += ' AND timestamp BETWEEN $4 AND $5';
        params.push(timeRange.start, timeRange.end);
      }

      query += ' ORDER BY rank DESC, timestamp DESC LIMIT $2 OFFSET $3';
      params.splice(1, 0, Math.min(limit, this.options.maxPageSize), offset);

      const result = await this.storageManager.pool.query(query, params);

      return {
        data: result.rows,
        searchText,
        pagination: {
          limit,
          offset,
          total: await this.getSearchResultCount(searchText, timeRange),
        },
      };
    });
  }

  /**
   * Get real-time data stream
   */
  async getRealtimeDataStream(stationId, options = {}) {
    const {
      maxAge = 300000, // 5 minutes
      includeQuality = true,
    } = options;
    const rawLimit = Number(options.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), this.options.maxPageSize)
        : Math.min(500, this.options.maxPageSize);

    const cutoffTime = new Date(Date.now() - maxAge);

    try {
      let query = `
                SELECT * FROM weather_data_timeseries
                WHERE station_id = $1 AND timestamp >= $2
                ORDER BY timestamp DESC
                LIMIT $3
            `;

      const params = [stationId, cutoffTime, limit];

      // Add quality filter if requested
      if (includeQuality) {
        query = `
                    SELECT
                        w.*,
                        q.quality_score as detailed_quality_score,
                        q.completeness_ratio,
                        q.accuracy_assessment,
                        q.physics_validation
                    FROM weather_data_timeseries w
                    LEFT JOIN data_quality_metrics q ON w.id = q.data_reference_id
                    WHERE w.station_id = $1 AND w.timestamp >= $2
                    ORDER BY w.timestamp DESC
                    LIMIT $3
                `;
      }

      const result = await this.storageManager.pool.query(query, params);

      return {
        stationId,
        dataPoints: result.rows,
        truncated: result.rows.length === limit,
        timestamp: new Date(),
        maxAge,
      };
    } catch (error) {
      this.logger.error('Real-time data stream query failed:', error);
      throw error;
    }
  }

  /**
   * Advanced spatial queries
   */
  async querySpatialWeatherData(spatialQuery, options = {}) {
    if (!this.options.enableSpatialIndexes) {
      throw new Error('Spatial indexing is not enabled');
    }

    const {
      limit = this.options.defaultPageSize,
      offset = 0,
      timeRange = null,
    } = options;

    let query;
    let params;

    switch (spatialQuery.type) {
      case 'within_polygon':
        query = `
                    SELECT * FROM weather_data_timeseries
                    WHERE ST_Within(
                        ST_Point(
                            (location->>'longitude')::double precision,
                            (location->>'latitude')::double precision
                        ),
                        ST_GeomFromGeoJSON($1)
                    )
                `;
        params = [JSON.stringify(spatialQuery.polygon)];
        break;

      case 'nearest_points': {
        // Use KNN (<->) operator so a GiST index can satisfy ORDER BY without a full-table
        // distance sort (#433). Apply a hard cap of 500 before the generic LIMIT is appended.
        const nearestLimit = Math.min(
          limit,
          this.options.maxPageSize,
          500
        );
        query = `
                    SELECT *,
                        ST_MakePoint(
                            (location->>'longitude')::double precision,
                            (location->>'latitude')::double precision
                        )::geometry <-> ST_MakePoint($1, $2)::geometry AS distance
                    FROM weather_data_timeseries
                    ORDER BY distance
                    LIMIT $3 OFFSET $4
                `;
        params = [spatialQuery.longitude, spatialQuery.latitude, nearestLimit, offset];
        const nearestResult = await this.storageManager.pool.query(query, params);
        return {
          spatialQuery,
          data: nearestResult.rows,
          pagination: { limit: nearestLimit, offset },
        };
      }

      default:
        throw new Error(`Unsupported spatial query type: ${spatialQuery.type}`);
    }

    // Add time range filter if specified
    if (timeRange) {
      query +=
        ' AND timestamp BETWEEN $' +
        (params.length + 1) +
        ' AND $' +
        (params.length + 2);
      params.push(timeRange.start, timeRange.end);
    }

    query +=
      ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Math.min(limit, this.options.maxPageSize), offset);

    const result = await this.storageManager.pool.query(query, params);

    return {
      spatialQuery,
      data: result.rows,
      pagination: { limit, offset },
    };
  }

  /**
   * Complex multi-dimensional queries
   */
  async executeComplexQuery(querySpec, options = {}) {
    // Validate query complexity
    const complexity = this.calculateQueryComplexity(querySpec);
    if (complexity > this.options.maxQueryComplexity) {
      throw new Error(
        `Query complexity ${complexity} exceeds maximum ${this.options.maxQueryComplexity}`
      );
    }

    const queryKey = this.generateComplexQueryKey(querySpec);

    return await this.executeQuery(
      queryKey,
      async () => {
        const { sql, params } = this.buildComplexQuery(querySpec);

        this.logger.debug(
          `Executing complex query: ${sql.substring(0, 200)}...`
        );

        const result = await this.storageManager.pool.query(sql, params);

        return {
          data: result.rows,
          querySpec,
          complexity,
          generatedAt: new Date(),
        };
      },
      options
    );
  }

  /**
   * Query optimization and analysis
   */
  async analyzeQueryPerformance(query, params = []) {
    try {
      // Get query execution plan
      const explainResult = await this.storageManager.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
        params
      );

      const plan = explainResult.rows[0]['QUERY PLAN'][0];

      return {
        executionTime: plan['Execution Time'],
        planningTime: plan['Planning Time'],
        totalCost: plan.Plan['Total Cost'],
        indexUsage: this.extractIndexUsage(plan),
        recommendations: this.generateOptimizationRecommendations(plan),
      };
    } catch (error) {
      this.logger.error('Query analysis failed:', error);
      return null;
    }
  }

  /**
   * Helper methods for counting records
   */
  async getWeatherDataCount(startTime, endTime, filters = {}) {
    let query =
      'SELECT COUNT(*) FROM weather_data_timeseries WHERE timestamp BETWEEN $1 AND $2';
    const params = [startTime, endTime];

    if (filters.stationId) {
      query += ' AND station_id = $3';
      params.push(filters.stationId);
    }

    if (filters.qualityThreshold !== null) {
      query += ` AND quality_score >= $${params.length + 1}`;
      params.push(filters.qualityThreshold);
    }

    const result = await this.storageManager.pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  async getLocationDataCount(latitude, longitude, radiusKm, timeRange) {
    let query = `
            SELECT COUNT(*) FROM weather_data_timeseries 
            WHERE ST_DWithin(
                ST_Point(
                    (location->>'longitude')::double precision,
                    (location->>'latitude')::double precision
                ),
                ST_Point($1, $2),
                $3
            )
        `;
    const params = [longitude, latitude, radiusKm * 1000];

    if (timeRange) {
      query += ' AND timestamp BETWEEN $4 AND $5';
      params.push(timeRange.start, timeRange.end);
    }

    const result = await this.storageManager.pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  async getModelOutputCount(modelType, timeRange, version) {
    let query = `
            SELECT COUNT(*) FROM climate_model_outputs 
            WHERE model_type = $1 AND execution_timestamp BETWEEN $2 AND $3
        `;
    const params = [modelType, timeRange.start, timeRange.end];

    if (version) {
      query += ' AND model_version = $4';
      params.push(version);
    }

    const result = await this.storageManager.pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  async getSearchResultCount(searchText, timeRange) {
    let query = `
            SELECT COUNT(*) FROM weather_data_timeseries
            WHERE to_tsvector('weather_search', 
                COALESCE(station_id, '') || ' ' || COALESCE(metadata::text, '')
            ) @@ plainto_tsquery('weather_search', $1)
        `;
    const params = [searchText];

    if (timeRange) {
      query += ' AND timestamp BETWEEN $2 AND $3';
      params.push(timeRange.start, timeRange.end);
    }

    const result = await this.storageManager.pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  /**
   * Performance monitoring and optimization
   */
  updateQueryMetrics(duration, success, fromCache) {
    this.metrics.totalQueries++;

    if (success) {
      // Update average query time (excluding cached queries)
      if (!fromCache) {
        const totalTime =
          this.metrics.averageQueryTime *
            (this.metrics.totalQueries - this.metrics.cachedQueries - 1) +
          duration;
        this.metrics.averageQueryTime =
          totalTime / (this.metrics.totalQueries - this.metrics.cachedQueries);

        // Track slow queries
        if (duration > 5000) {
          // 5 seconds threshold
          this.metrics.slowQueries++;
        }
      }
    } else {
      this.metrics.failedQueries++;
    }
  }

  trackPopularQuery(queryKey) {
    const count = this.metrics.popularQueries.get(queryKey) || 0;
    this.metrics.popularQueries.set(queryKey, count + 1);

    // Keep only top 100 popular queries
    if (this.metrics.popularQueries.size > 100) {
      const sorted = Array.from(this.metrics.popularQueries.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 100);

      this.metrics.popularQueries.clear();
      sorted.forEach(([key, value]) => {
        this.metrics.popularQueries.set(key, value);
      });
    }
  }

  async updateQueryStatistics() {
    try {
      // Get query statistics from database
      const stats = await this.storageManager.pool.query(`
                SELECT 
                    schemaname,
                    tablename,
                    indexname,
                    idx_scan,
                    idx_tup_read,
                    idx_tup_fetch
                FROM pg_stat_user_indexes
                WHERE schemaname = 'public'
            `);

      // Update index usage metrics
      stats.rows.forEach(row => {
        this.metrics.indexUsage[row.indexname] = {
          scans: row.idx_scan,
          tuplesRead: row.idx_tup_read,
          tuplesFetched: row.idx_tup_fetch,
        };
      });
    } catch (error) {
      this.logger.warn('Failed to update query statistics:', error.message);
    }
  }

  /**
   * Cache management
   */
  clearCache(pattern = null) {
    if (pattern) {
      // Clear entries matching pattern
      for (const key of this.queryCache.keys()) {
        if (key.includes(pattern)) {
          this.queryCache.delete(key);
        }
      }
      for (const key of this.aggregationCache.keys()) {
        if (key.includes(pattern)) {
          this.aggregationCache.delete(key);
        }
      }
    } else {
      // Clear all cache
      this.queryCache.clear();
      this.aggregationCache.clear();
    }

    this.logger.info(
      `Cache cleared${pattern ? ` for pattern: ${pattern}` : ' completely'}`
    );
  }

  getCacheStatistics() {
    return {
      queryCache: {
        size: this.queryCache.size,
        maxSize: this.queryCache.max,
        hitRatio:
          this.metrics.totalQueries > 0
            ? this.metrics.cachedQueries / this.metrics.totalQueries
            : 0,
      },
      aggregationCache: {
        size: this.aggregationCache.size,
        maxSize: this.aggregationCache.max,
      },
    };
  }

  /**
   * Service status and health
   */
  getServiceStatus() {
    return {
      initialized: !!this.storageManager,
      metrics: this.metrics,
      cacheStatistics: this.getCacheStatistics(),
      configuration: {
        enableQueryCache: this.options.enableQueryCache,
        enableSpatialIndexes: this.options.enableSpatialIndexes,
        enableFullTextSearch: this.options.enableFullTextSearch,
        maxQueryComplexity: this.options.maxQueryComplexity,
      },
      indexDefinitions: Object.keys(this.indexDefinitions).reduce(
        (acc, category) => {
          acc[category] = this.indexDefinitions[category].length;
          return acc;
        },
        {}
      ),
    };
  }

  /**
   * Utility methods
   */
  calculateQueryComplexity(querySpec) {
    let complexity = 0;

    // Base complexity
    complexity += 10;

    // Add complexity for filters
    if (querySpec.filters) {
      complexity += Object.keys(querySpec.filters).length * 5;
    }

    // Add complexity for joins
    if (querySpec.joins) {
      complexity += querySpec.joins.length * 25;
    }

    // Add complexity for aggregations
    if (querySpec.aggregations) {
      complexity += querySpec.aggregations.length * 15;
    }

    // Add complexity for spatial operations
    if (querySpec.spatial) {
      complexity += 50;
    }

    return complexity;
  }

  generateComplexQueryKey(querySpec) {
    return `complex_${JSON.stringify(querySpec)}`.substring(0, 100);
  }

  buildComplexQuery(querySpec) {
    // This would implement a query builder based on the specification
    // For now, return a placeholder
    return {
      sql: 'SELECT 1 as placeholder',
      params: [],
    };
  }

  extractIndexUsage(plan) {
    // Extract index usage information from query plan
    const indexes = [];

    function traverse(node) {
      if (node['Index Name']) {
        indexes.push(node['Index Name']);
      }
      if (node.Plans) {
        node.Plans.forEach(traverse);
      }
    }

    traverse(plan.Plan);
    return indexes;
  }

  generateOptimizationRecommendations(plan) {
    const recommendations = [];

    // Check for sequential scans
    function traverse(node) {
      if (node['Node Type'] === 'Seq Scan' && node['Total Cost'] > 1000) {
        recommendations.push(
          `Consider adding an index for table ${node['Relation Name']}`
        );
      }
      if (node.Plans) {
        node.Plans.forEach(traverse);
      }
    }

    traverse(plan.Plan);
    return recommendations;
  }

  /**
   * Cleanup resources
   */
  async shutdown() {
    try {
      this.clearCache();
      this.logger.info('Data Indexing Service shut down successfully');
    } catch (error) {
      this.logger.error('Error during indexing service shutdown:', error);
    }
  }
}

module.exports = { DataIndexingService };
