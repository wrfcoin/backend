/**
 * Comprehensive test for OpenForis API implementation
 * Tests the complete data transformation and caching pipeline
 */

const { OpenForisAdapter } = require('../openforis/adapter');
const { OpenForisTransformer } = require('../utils/openforis-transformer');
const { openForisCacheManager } = require('../utils/openforis-cache');

describe('OpenForis Implementation - Task 58 Subtasks 3 & 4', () => {
  let adapter;
  let transformer;
  let cacheManager;

  beforeEach(() => {
    // Initialize in test mode
    adapter = new OpenForisAdapter({ testMode: true });
    transformer = new OpenForisTransformer();
    cacheManager = openForisCacheManager;
  });

  afterEach(async () => {
    // Clean up cache
    await cacheManager.clearAll();
    transformer.resetStats();
  });

  describe('Data Transformation Pipeline', () => {
    test('should transform OpenForis project data correctly', () => {
      const openforisProject = {
        id: 'of-project-123',
        name: 'Test Forest Project',
        description: 'A test project for forest monitoring',
        type: 'forest_monitoring',
        region: 'Test Region',
        created_at: '2024-01-01T00:00:00Z',
        status: 'active',
        metadata: { source: 'test' },
      };

      const transformed = transformer.transformProject(openforisProject);

      expect(transformed).toMatchObject({
        id: 'of-project-123',
        name: 'Test Forest Project',
        type: 'FOREST_MONITORING',
        region: 'Test Region',
        status: 'ACTIVE',
        plotCount: 0,
      });
      expect(transformed.metadata.source).toBe('OpenForis');
      expect(transformed.metadata.transformedAt).toBeDefined();
    });

    test('should transform OpenForis plot data correctly', () => {
      const openforisPlot = {
        id: 'of-plot-456',
        project_id: 'of-project-123',
        name: 'Test Plot',
        coordinates: { latitude: 45.5, longitude: -122.7 },
        area_hectares: 100,
        forest_type: 'temperate_forest',
        carbon_stock_tc_per_ha: 150,
        biodiversity_index: 7.5,
        last_updated: '2024-01-01T00:00:00Z',
      };

      const transformed = transformer.transformPlot(openforisPlot);

      expect(transformed).toMatchObject({
        id: 'of-plot-456',
        projectId: 'of-project-123',
        name: 'Test Plot',
        coordinates: { latitude: 45.5, longitude: -122.7 },
        size: 100,
        forestType: 'Mixed temperate',
        carbonStock: 150,
        biodiversityIndex: 7.5,
        status: 'VERIFIED',
      });
    });

    test('should transform time series data correctly', () => {
      const openforisTimeSeries = {
        id: 'of-ts-789',
        plot_id: 'of-plot-456',
        start_date: '2023-01-01T00:00:00Z',
        end_date: '2023-12-31T23:59:59Z',
        resolution_meters: '30',
        satellite_source: 'sentinel-2',
        data_points: [
          {
            timestamp: '2023-01-01T00:00:00Z',
            ndvi: 0.7,
            precipitation_mm: 50,
            temperature_celsius: 15,
            forest_cover_percent: 85,
            forest_loss_percent: 0.1,
            soil_moisture_percent: 25,
          },
        ],
      };

      const transformed = transformer.transformTimeSeries(openforisTimeSeries);

      expect(transformed).toMatchObject({
        id: 'of-ts-789',
        plotId: 'of-plot-456',
        type: 'EARTH_MAP',
        resolution: '30m',
      });
      expect(transformed.dataPoints).toHaveLength(1);
      expect(transformed.dataPoints[0]).toMatchObject({
        ndvi: 0.7,
        precipitation: 50,
        temperature: 15,
        forestCover: 85,
        forestLoss: 0.1,
        soilMoisture: 25,
      });
    });

    test('should transform climate data correctly', () => {
      const openforisClimateData = {
        id: 'of-climate-101',
        region: 'Test Region',
        scenario: 'RCP4.5',
        time_range: '2025-2100',
        resolution_km: '50km',
        variables: ['temperature', 'precipitation'],
        projections: [
          {
            year: 2030,
            temperature_celsius: 16.5,
            precipitation_mm: 900,
            extreme_events_count: 3,
          },
        ],
        model_metadata: { model: 'CMIP6' },
      };

      const transformed =
        transformer.transformClimateData(openforisClimateData);

      expect(transformed).toMatchObject({
        id: 'of-climate-101',
        region: 'Test Region',
        scenario: 'RCP4.5',
        timeRange: '2025-2100',
        resolution: '50km',
        variables: ['temperature', 'precipitation'],
      });
      expect(transformed.projections).toHaveLength(1);
      expect(transformed.projections[0]).toMatchObject({
        year: 2030,
        temperature: 16.5,
        precipitation: 900,
        extremeEvents: 3,
      });
    });
  });

  describe('Advanced Data Transformations', () => {
    test('should aggregate time series data correctly', () => {
      const timeSeriesArray = [
        {
          id: 'ts-1',
          plotId: 'plot-1',
          dataPoints: [
            { timestamp: '2023-01-15T00:00:00Z', ndvi: 0.7, precipitation: 50 },
            {
              timestamp: '2023-02-15T00:00:00Z',
              ndvi: 0.75,
              precipitation: 60,
            },
          ],
        },
        {
          id: 'ts-2',
          plotId: 'plot-2',
          dataPoints: [
            {
              timestamp: '2023-01-15T00:00:00Z',
              ndvi: 0.65,
              precipitation: 45,
            },
            { timestamp: '2023-02-15T00:00:00Z', ndvi: 0.7, precipitation: 55 },
          ],
        },
      ];

      const aggregated = transformer.aggregateTimeSeries(timeSeriesArray, {
        aggregationType: 'monthly',
        variables: ['ndvi', 'precipitation'],
        statisticFunctions: ['mean', 'min', 'max'],
      });

      expect(aggregated.aggregationType).toBe('monthly');
      expect(aggregated.aggregatedData).toHaveLength(2); // January and February
      expect(aggregated.metadata.inputTimeSeriesCount).toBe(2);
      expect(aggregated.metadata.totalDataPoints).toBe(4);

      // Check statistical calculations
      const janData = aggregated.aggregatedData.find(
        d => d.timePeriod === '2023-01'
      );
      expect(janData.statistics.ndvi.mean).toBeCloseTo(0.675); // (0.7 + 0.65) / 2
      expect(janData.statistics.precipitation.mean).toBeCloseTo(47.5); // (50 + 45) / 2
    });

    test('should calculate carbon credits correctly', () => {
      const plotData = {
        id: 'plot-1',
        size: 100, // hectares
        forestType: 'Mixed temperate',
        carbonStock: 120,
      };

      const timeSeriesData = {
        dataPoints: [
          {
            timestamp: '2023-01-01T00:00:00Z',
            forestCover: 80,
            ndvi: 0.6,
          },
          {
            timestamp: '2024-01-01T00:00:00Z',
            forestCover: 85, // 5% improvement
            ndvi: 0.7, // 0.1 improvement
          },
        ],
      };

      const carbonCredits = transformer.transformForCarbonCredits(
        plotData,
        timeSeriesData
      );

      expect(carbonCredits.plotId).toBe('plot-1');
      expect(carbonCredits.area).toBe(100);
      expect(carbonCredits.forestType).toBe('Mixed temperate');
      expect(carbonCredits.calculations).toHaveLength(1);
      expect(carbonCredits.totalCarbonSequestration).toBeGreaterThan(0);
      expect(carbonCredits.eligibleCredits).toBeGreaterThan(0);
      expect(carbonCredits.metadata.calculationMethod).toBe('IPCC Tier 2');
    });
  });

  describe('Caching Implementation', () => {
    test('should cache and retrieve project data', async () => {
      const projectData = {
        id: 'project-123',
        name: 'Test Project',
        type: 'FOREST_MONITORING',
        region: 'Test Region',
      };

      // Cache the project
      await cacheManager.cacheProject('project-123', projectData);

      // Retrieve from cache
      const cached = await cacheManager.getProject('project-123');

      expect(cached).toEqual(projectData);
    });

    test('should cache and retrieve plot data', async () => {
      const plotData = {
        id: 'plot-456',
        projectId: 'project-123',
        name: 'Test Plot',
        coordinates: { latitude: 45.5, longitude: -122.7 },
      };

      await cacheManager.cachePlot('plot-456', plotData);
      const cached = await cacheManager.getPlot('plot-456');

      expect(cached).toEqual(plotData);
    });

    test('should cache and retrieve time series data', async () => {
      const timeSeriesData = {
        id: 'ts-789',
        plotId: 'plot-456',
        type: 'EARTH_MAP',
        dataPoints: [],
      };

      await cacheManager.cacheTimeSeries('ts-789', timeSeriesData);
      const cached = await cacheManager.getTimeSeries('ts-789');

      expect(cached).toEqual(timeSeriesData);
    });

    test('should cache and retrieve climate data', async () => {
      const climateData = {
        id: 'climate-101',
        region: 'North America',
        scenario: 'RCP4.5',
        projections: [],
      };

      await cacheManager.cacheClimateData(
        'North America',
        'RCP4.5',
        climateData
      );
      const cached = await cacheManager.getClimateData(
        'North America',
        'RCP4.5'
      );

      expect(cached).toEqual(climateData);
    });

    test('should implement cache-aside pattern', async () => {
      let fetchCallCount = 0;
      const fetchFunction = async () => {
        fetchCallCount++;
        return { data: 'test-data', timestamp: Date.now() };
      };

      // First call should fetch data
      const result1 = await cacheManager.cacheAside(
        'test-key',
        fetchFunction,
        300
      );
      expect(fetchCallCount).toBe(1);
      expect(result1.data).toBe('test-data');

      // Second call should use cache
      const result2 = await cacheManager.cacheAside(
        'test-key',
        fetchFunction,
        300
      );
      expect(fetchCallCount).toBe(1); // Should not increase
      expect(result2.data).toBe('test-data');
    });

    test('should handle bulk operations', async () => {
      const operations = [
        { type: 'SET', key: 'bulk-1', data: { value: 1 } },
        { type: 'SET', key: 'bulk-2', data: { value: 2 } },
        { type: 'SET', key: 'bulk-3', data: { value: 3 } },
      ];

      const results = await cacheManager.bulkOperations(operations);

      expect(results.successful).toBe(3);
      expect(results.failed).toBe(0);
      expect(results.errors).toHaveLength(0);
    });

    test('should cache search results', async () => {
      const query = 'forest monitoring';
      const results = [
        { id: 'project-1', name: 'Forest Project 1' },
        { id: 'project-2', name: 'Forest Project 2' },
      ];
      const options = { type: 'projects', limit: 10 };

      await cacheManager.cacheSearchResults(query, results, options);
      const cached = await cacheManager.getSearchResults(query, options);

      expect(cached.query).toBe(query);
      expect(cached.results).toEqual(results);
      expect(cached.resultCount).toBe(2);
    });
  });

  describe('OpenForis Adapter Integration', () => {
    test('should initialize adapter correctly', async () => {
      expect(adapter.testMode).toBe(true);
      expect(adapter.initialized).toBe(false);

      await adapter.initialize();

      expect(adapter.initialized).toBe(true);

      const status = adapter.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.testMode).toBe(true);
      expect(status.cacheStats).toBeDefined();
    });

    test('should create projects in test mode', async () => {
      await adapter.initialize();

      const projectData = {
        name: 'Test Forest Project',
        description: 'A test project for validation',
        type: 'FOREST_MONITORING',
        region: 'Test Region',
      };

      const project = await adapter.createCollectEarthProject(projectData);

      expect(project.id).toBeDefined();
      expect(project.name).toBe(projectData.name);
      expect(project.type).toBe(projectData.type);
      expect(project.status).toBe('ACTIVE');
    });

    test('should create plots in test mode', async () => {
      await adapter.initialize();

      // First create a project
      const project = await adapter.createCollectEarthProject({
        name: 'Test Project',
        type: 'FOREST_MONITORING',
        region: 'Test Region',
      });

      const plotData = {
        projectId: project.id,
        name: 'Test Plot',
        coordinates: { latitude: 45.5, longitude: -122.7 },
        size: 100,
        forestType: 'Mixed',
        carbonStock: 150,
        biodiversityIndex: 7.5,
      };

      const plot = await adapter.createPlot(plotData);

      expect(plot.id).toBeDefined();
      expect(plot.projectId).toBe(project.id);
      expect(plot.name).toBe(plotData.name);
      expect(plot.coordinates).toEqual(plotData.coordinates);
    });

    test('should start time series analysis in test mode', async () => {
      await adapter.initialize();

      // Create project and plot first
      const project = await adapter.createCollectEarthProject({
        name: 'Test Project',
        type: 'FOREST_MONITORING',
      });

      const plot = await adapter.createPlot({
        projectId: project.id,
        name: 'Test Plot',
        coordinates: { latitude: 45.5, longitude: -122.7 },
        size: 100,
      });

      const timeSeries = await adapter.startTimeSeriesAnalysis(plot.id, {
        startDate: '2023-01-01T00:00:00Z',
        endDate: '2023-12-31T23:59:59Z',
      });

      expect(timeSeries.id).toBeDefined();
      expect(timeSeries.plotId).toBe(plot.id);
      expect(timeSeries.type).toBe('EARTH_MAP');
      expect(timeSeries.status).toBe('PROCESSING');
    });

    test('should generate climate projections in test mode', async () => {
      await adapter.initialize();

      const projection = await adapter.generateClimateProjection({
        region: 'Test Region',
        scenario: 'RCP4.5',
        startYear: 2025,
        endYear: 2050,
      });

      expect(projection.id).toBeDefined();
      expect(projection.region).toBe('Test Region');
      expect(projection.scenario).toBe('RCP4.5');
      expect(projection.projections).toBeDefined();
      expect(Array.isArray(projection.projections)).toBe(true);
    });

    test('should get aggregated statistics', async () => {
      await adapter.initialize();

      // Create some test data
      await adapter.createCollectEarthProject({
        name: 'Test Project 1',
        type: 'FOREST_MONITORING',
        region: 'Region A',
      });

      const stats = await adapter.getAggregatedStats();

      expect(stats.projects.total).toBeGreaterThan(0);
      expect(stats.projects.byType).toBeDefined();
      expect(stats.projects.byRegion).toBeDefined();
      expect(stats.cache).toBeDefined();
    });

    test('should get data quality metrics', async () => {
      await adapter.initialize();

      const metrics = await adapter.getDataQualityMetrics();

      expect(metrics.completeness).toBeDefined();
      expect(metrics.accuracy).toBeDefined();
      expect(metrics.freshness).toBeDefined();
      expect(metrics.transformation).toBeDefined();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle invalid transformation data gracefully', () => {
      expect(() => {
        transformer.transformProject(null);
      }).toThrow('Project transformation failed');

      expect(() => {
        transformer.transformPlot({});
      }).toThrow('Plot transformation failed');

      expect(() => {
        transformer.transformTimeSeries({ invalid: 'data' });
      }).toThrow('Time series transformation failed');
    });

    test('should handle cache errors gracefully', async () => {
      // Test with invalid cache operations
      const result = await cacheManager.getProject('non-existent-id');
      expect(result).toBeNull();

      const climateResult = await cacheManager.getClimateData(
        'non-existent',
        'invalid'
      );
      expect(climateResult).toBeNull();
    });

    test('should handle empty aggregation inputs', () => {
      expect(() => {
        transformer.aggregateTimeSeries([]);
      }).toThrow('Time series array cannot be empty');

      expect(() => {
        transformer.aggregateTimeSeries(null);
      }).toThrow('Time series array cannot be empty');
    });
  });
});
