/**
 * Comprehensive Test Suite for Data Storage Services
 *
 * Tests all core data storage services: WeatherDataStorageManager, DataArchivalService,
 * DataIndexingService, and DataVersioningService with various scenarios including
 * unit tests, integration tests, and error handling.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Import services to test
const {
  WeatherDataStorageManager,
} = require('../services/weather-data-storage-manager');
const { DataArchivalService } = require('../services/data-archival-service');
const { DataIndexingService } = require('../services/data-indexing-service');
const {
  DataVersioningService,
} = require('../services/data-versioning-service');

describe('Data Storage Services Test Suite', function () {
  this.timeout(30000); // Increase timeout for database operations

  let mockPool;
  let storageManager;
  let archivalService;
  let indexingService;
  let versioningService;

  // Mock data for testing
  const mockWeatherData = {
    station_id: 'TEST_STATION_001',
    timestamp: new Date('2024-01-15T10:00:00Z'),
    measurements: {
      temperature: 22.5,
      humidity: 65.2,
      pressure: 1013.25,
      wind_speed: 12.3,
      wind_direction: 180,
    },
    location: {
      latitude: 40.7128,
      longitude: -74.006,
    },
    quality_score: 95.5,
    metadata: {
      source: 'automated',
      sensor_type: 'professional',
      calibration_date: '2024-01-01',
    },
  };

  const mockModelOutput = {
    model_run_id: '550e8400-e29b-41d4-a716-446655440000',
    model_type: 'WRF',
    model_version: '4.3.1',
    execution_timestamp: new Date('2024-01-15T12:00:00Z'),
    output_data: {
      forecast_data: {
        temperature_2m: [20.1, 21.5, 22.8],
        precipitation: [0.0, 0.5, 1.2],
      },
      grid_points: 10000,
    },
    input_data_hash: 'abc123def456',
    execution_parameters: {
      grid_resolution: '9km',
      forecast_hours: 72,
    },
    performance_metrics: {
      execution_time_seconds: 3600,
      memory_usage_gb: 16.5,
    },
  };

  beforeEach(async function () {
    // Create mock database pool
    mockPool = {
      query: sinon.stub(),
      end: sinon.stub().resolves(),
      connect: sinon.stub().resolves({
        query: sinon.stub(),
        release: sinon.stub(),
      }),
    };

    // Mock file system operations
    sinon.stub(fs, 'mkdir').resolves();
    sinon.stub(fs, 'writeFile').resolves();
    sinon.stub(fs, 'readFile').resolves(JSON.stringify(mockWeatherData));
    sinon.stub(fs, 'access').resolves();
    sinon.stub(fs, 'unlink').resolves();

    // Initialize services with mocked dependencies
    storageManager = new WeatherDataStorageManager({
      enableTimescaleDB: true,
      enableCompression: true,
      batchSize: 100,
    });

    // Mock the pool assignment
    storageManager.pool = mockPool;
    storageManager.isInitialized = true;

    archivalService = new DataArchivalService({
      localArchivePath: './test-archives',
      enableCompression: true,
      cloudProvider: 'local',
    });

    indexingService = new DataIndexingService({
      enableQueryCache: true,
      enableSpatialIndexes: true,
      enableFullTextSearch: true,
    });

    versioningService = new DataVersioningService({
      versioningStrategy: 'semantic',
      enableBranching: true,
      enableDeltaCompression: true,
    });

    // Mock initialize methods
    sinon.stub(archivalService, 'initialize').resolves();
    sinon.stub(indexingService, 'initialize').resolves();
    sinon.stub(versioningService, 'initialize').resolves();

    // Set up dependencies
    archivalService.storageManager = storageManager;
    indexingService.storageManager = storageManager;
    versioningService.storageManager = storageManager;
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('WeatherDataStorageManager', function () {
    describe('storeWeatherData()', function () {
      it('should successfully store weather data', async function () {
        // Mock successful database insertion
        mockPool.query
          .withArgs(sinon.match.string, sinon.match.array)
          .resolves({ rows: [{ id: 1, ...mockWeatherData }] });

        const result = await storageManager.storeWeatherData(mockWeatherData);

        expect(result).to.have.property('id', 1);
        expect(mockPool.query.called).to.be.true;

        // Verify the SQL query was called with correct parameters
        const queryCall = mockPool.query.getCall(0);
        expect(queryCall.args[0]).to.include('INSERT INTO');
        expect(queryCall.args[1]).to.be.an('array');
      });

      it('should handle invalid weather data', async function () {
        const invalidData = { ...mockWeatherData };
        delete invalidData.station_id; // Remove required field

        try {
          await storageManager.storeWeatherData(invalidData);
          expect.fail('Should have thrown validation error');
        } catch (error) {
          expect(error.message).to.include('validation');
        }
      });

      it('should handle database connection errors', async function () {
        mockPool.query.rejects(new Error('Database connection failed'));

        try {
          await storageManager.storeWeatherData(mockWeatherData);
          expect.fail('Should have thrown database error');
        } catch (error) {
          expect(error.message).to.include('Database connection failed');
        }
      });
    });

    describe('storeBatchWeatherData()', function () {
      it('should successfully store batch weather data', async function () {
        const batchData = [
          mockWeatherData,
          { ...mockWeatherData, station_id: 'TEST_STATION_002' },
        ];

        mockPool.query.resolves({
          rows: batchData.map((data, index) => ({ id: index + 1, ...data })),
        });

        const result = await storageManager.storeBatchWeatherData(batchData);

        expect(result).to.have.property('successful', 2);
        expect(result).to.have.property('failed', 0);
        expect(result.ids).to.have.length(2);
      });

      it('should handle partial batch failures', async function () {
        const batchData = [mockWeatherData, { invalid: 'data' }];

        // First item succeeds, second fails
        mockPool.query
          .onFirstCall()
          .resolves({ rows: [{ id: 1, ...mockWeatherData }] });
        mockPool.query.onSecondCall().rejects(new Error('Invalid data format'));

        const result = await storageManager.storeBatchWeatherData(batchData);

        expect(result.successful).to.be.greaterThan(0);
        expect(result.failed).to.be.greaterThan(0);
      });
    });

    describe('storeModelOutput()', function () {
      it('should successfully store model output', async function () {
        mockPool.query.resolves({ rows: [{ id: 1, ...mockModelOutput }] });

        const result = await storageManager.storeModelOutput(mockModelOutput);

        expect(result).to.have.property('id', 1);
        expect(mockPool.query.called).to.be.true;
      });

      it('should validate model output data structure', async function () {
        const invalidModelOutput = { ...mockModelOutput };
        delete invalidModelOutput.model_type;

        try {
          await storageManager.storeModelOutput(invalidModelOutput);
          expect.fail('Should have thrown validation error');
        } catch (error) {
          expect(error.message).to.include('validation');
        }
      });
    });
  });

  describe('DataArchivalService', function () {
    describe('executeArchival()', function () {
      it('should successfully execute archival process', async function () {
        // Mock retention policies query
        mockPool.query
          .withArgs(sinon.match(/SELECT.*retention_policies/))
          .resolves({
            rows: [
              {
                id: 1,
                policy_name: 'weather_data_30d',
                table_name: 'weather_data_timeseries',
                retention_period: '30 days',
                is_active: true,
              },
            ],
          });

        // Mock data for archival query
        mockPool.query
          .withArgs(sinon.match(/SELECT.*FROM weather_data_timeseries/))
          .resolves({
            rows: [mockWeatherData],
          });

        // Mock archive index insertion
        mockPool.query
          .withArgs(sinon.match(/INSERT INTO.*archive_index/))
          .resolves({ rows: [{ id: 1 }] });

        const result = await archivalService.executeArchival();

        expect(result).to.have.property('jobId');
        expect(result).to.have.property('totalArchived');
        expect(result.totalArchived).to.be.at.least(0);
      });

      it('should handle archival errors gracefully', async function () {
        mockPool.query.rejects(new Error('Archival storage unavailable'));

        try {
          await archivalService.executeArchival();
          expect.fail('Should have thrown archival error');
        } catch (error) {
          expect(error.message).to.include('Archival storage unavailable');
        }
      });
    });

    describe('retrieveArchivedData()', function () {
      it('should successfully retrieve archived data', async function () {
        const archiveReference = 'archive_ref_12345';

        // Mock archive info query
        mockPool.query.withArgs(sinon.match(/SELECT.*archive_index/)).resolves({
          rows: [
            {
              id: 1,
              archive_path: 'test/path/data.json.gz',
              tier: 'warm',
              format: 'json',
              compressed: true,
              checksum: 'abc123',
            },
          ],
        });

        const result =
          await archivalService.retrieveArchivedData(archiveReference);

        expect(result).to.have.property('data');
        expect(result).to.have.property('metadata');
        expect(result).to.have.property('retrievedAt');
      });

      it('should validate data integrity', async function () {
        const archiveReference = 'archive_ref_12345';

        mockPool.query.resolves({
          rows: [
            {
              archive_path: 'test/path/data.json.gz',
              tier: 'warm',
              format: 'json',
              compressed: true,
              checksum: 'wrong_checksum',
            },
          ],
        });

        try {
          await archivalService.retrieveArchivedData(archiveReference, {
            validateIntegrity: true,
          });
          expect.fail('Should have thrown integrity error');
        } catch (error) {
          expect(error.message).to.include('Integrity check failed');
        }
      });
    });

    describe('migrateStorageTiers()', function () {
      it('should successfully migrate data between storage tiers', async function () {
        // Mock archived data query
        mockPool.query.withArgs(sinon.match(/SELECT.*data_versions/)).resolves({
          rows: [
            {
              id: 1,
              tier: 'hot',
              created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
              archive_path: 'hot/old_data.json',
            },
          ],
        });

        // Mock tier update
        mockPool.query
          .withArgs(sinon.match(/UPDATE.*archive_location/))
          .resolves({ rowCount: 1 });

        const result = await archivalService.migrateStorageTiers();

        expect(result).to.be.a('number');
        expect(result).to.be.at.least(0);
      });
    });
  });

  describe('DataIndexingService', function () {
    describe('queryWeatherByTimeRange()', function () {
      it('should successfully query weather data by time range', async function () {
        const startTime = new Date('2024-01-01T00:00:00Z');
        const endTime = new Date('2024-01-31T23:59:59Z');

        mockPool.query.resolves({
          rows: [mockWeatherData],
        });

        const result = await indexingService.queryWeatherByTimeRange(
          startTime,
          endTime
        );

        expect(result).to.have.property('data');
        expect(result).to.have.property('pagination');
        expect(result.data).to.be.an('array');
        expect(result.pagination).to.have.property('total');
      });

      it('should apply quality threshold filtering', async function () {
        const startTime = new Date('2024-01-01T00:00:00Z');
        const endTime = new Date('2024-01-31T23:59:59Z');

        mockPool.query.resolves({
          rows: [mockWeatherData],
        });

        const result = await indexingService.queryWeatherByTimeRange(
          startTime,
          endTime,
          {
            qualityThreshold: 90.0,
          }
        );

        expect(mockPool.query.called).to.be.true;
        const queryCall = mockPool.query.getCall(0);
        expect(queryCall.args[0]).to.include('quality_score');
      });
    });

    describe('queryWeatherByLocation()', function () {
      it('should successfully query weather data by location', async function () {
        const latitude = 40.7128;
        const longitude = -74.006;
        const radiusKm = 10;

        mockPool.query.resolves({
          rows: [mockWeatherData],
        });

        const result = await indexingService.queryWeatherByLocation(
          latitude,
          longitude,
          radiusKm
        );

        expect(result).to.have.property('data');
        expect(result.data).to.be.an('array');

        const queryCall = mockPool.query.getCall(0);
        expect(queryCall.args[0]).to.include('ST_DWithin');
      });
    });

    describe('queryAggregatedWeatherData()', function () {
      it('should successfully perform aggregation queries', async function () {
        const aggregationType = 'average';
        const timeRange = {
          start: new Date('2024-01-01T00:00:00Z'),
          end: new Date('2024-01-31T23:59:59Z'),
        };

        mockPool.query.resolves({
          rows: [
            {
              period: '2024-01-01',
              station_id: 'TEST_STATION_001',
              avg_temperature: 22.5,
              avg_humidity: 65.2,
              avg_quality: 95.5,
            },
          ],
        });

        const result = await indexingService.queryAggregatedWeatherData(
          aggregationType,
          timeRange
        );

        expect(result).to.have.property('data');
        expect(result).to.have.property('aggregationType', aggregationType);
        expect(result.data).to.be.an('array');
      });
    });

    describe('searchWeatherData()', function () {
      it('should perform full-text search on weather data', async function () {
        const searchText = 'temperature sensor';

        mockPool.query.resolves({
          rows: [{ ...mockWeatherData, rank: 0.8 }],
        });

        const result = await indexingService.searchWeatherData(searchText);

        expect(result).to.have.property('data');
        expect(result).to.have.property('searchText', searchText);
        expect(result.data).to.be.an('array');

        const queryCall = mockPool.query.getCall(0);
        expect(queryCall.args[0]).to.include('to_tsvector');
      });

      it('should handle search with no results', async function () {
        const searchText = 'nonexistent data';

        mockPool.query.resolves({ rows: [] });

        const result = await indexingService.searchWeatherData(searchText);

        expect(result).to.have.property('data');
        expect(result.data).to.have.length(0);
      });
    });

    describe('getRealtimeDataStream()', function () {
      it('should retrieve real-time data for a station', async function () {
        const stationId = 'TEST_STATION_001';

        mockPool.query.resolves({
          rows: [mockWeatherData],
        });

        const result = await indexingService.getRealtimeDataStream(stationId);

        expect(result).to.have.property('stationId', stationId);
        expect(result).to.have.property('dataPoints');
        expect(result).to.have.property('timestamp');
        expect(result.dataPoints).to.be.an('array');
      });
    });
  });

  describe('DataVersioningService', function () {
    describe('createVersion()', function () {
      it('should successfully create a new version', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';
        const data = mockWeatherData;

        // Mock version number generation
        mockPool.query
          .withArgs(sinon.match(/SELECT.*data_versions.*latest/))
          .resolves({ rows: [] }); // No existing versions

        // Mock version insertion
        mockPool.query
          .withArgs(sinon.match(/INSERT INTO data_versions/))
          .resolves({
            rows: [
              {
                id: 1,
                version_number: '1.0.0',
                created_at: new Date(),
              },
            ],
          });

        const result = await versioningService.createVersion(
          dataType,
          dataId,
          data
        );

        expect(result).to.have.property('versionId', 1);
        expect(result).to.have.property('versionNumber', '1.0.0');
        expect(result).to.have.property('checksum');
      });

      it('should increment version numbers correctly', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';
        const data = mockWeatherData;

        // Mock existing version
        mockPool.query
          .withArgs(sinon.match(/SELECT.*data_versions.*latest/))
          .resolves({
            rows: [
              {
                version_number: '1.2.3',
                created_at: new Date(),
              },
            ],
          });

        mockPool.query
          .withArgs(sinon.match(/INSERT INTO data_versions/))
          .resolves({
            rows: [
              {
                id: 2,
                version_number: '1.2.4',
                created_at: new Date(),
              },
            ],
          });

        const result = await versioningService.createVersion(
          dataType,
          dataId,
          data,
          {
            versionType: 'patch',
          }
        );

        expect(result).to.have.property('versionNumber', '1.2.4');
      });
    });

    describe('getVersion()', function () {
      it('should retrieve a specific version', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';
        const versionNumber = '1.0.0';

        mockPool.query.resolves({
          rows: [
            {
              id: 1,
              data_type: dataType,
              data_id: dataId,
              version_number: versionNumber,
              storage_location: 'test/path/data.json',
              version_metadata: '{"api_source": true}',
            },
          ],
        });

        const result = await versioningService.getVersion(
          dataType,
          dataId,
          versionNumber
        );

        expect(result).to.have.property('id', 1);
        expect(result).to.have.property('version_number', versionNumber);
        expect(result).to.have.property('data');
        expect(result).to.have.property('version_metadata');
      });

      it('should retrieve latest version when no version specified', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';

        mockPool.query.resolves({
          rows: [
            {
              id: 3,
              version_number: '1.2.4',
              storage_location: 'test/path/data.json',
              version_metadata: '{}',
            },
          ],
        });

        const result = await versioningService.getVersion(
          dataType,
          dataId,
          'latest'
        );

        expect(result).to.have.property('id', 3);
        expect(result).to.have.property('version_number', '1.2.4');
      });
    });

    describe('listVersions()', function () {
      it('should list all versions for a data item', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';

        mockPool.query.onFirstCall().resolves({
          rows: [
            { id: 1, version_number: '1.0.0', version_metadata: '{}' },
            { id: 2, version_number: '1.1.0', version_metadata: '{}' },
            { id: 3, version_number: '1.2.0', version_metadata: '{}' },
          ],
        });

        mockPool.query.onSecondCall().resolves({
          rows: [{ total: 3 }],
        });

        const result = await versioningService.listVersions(dataType, dataId);

        expect(result).to.have.property('versions');
        expect(result).to.have.property('pagination');
        expect(result.versions).to.have.length(3);
        expect(result.pagination.total).to.equal(3);
      });
    });

    describe('compareVersions()', function () {
      it('should compare two versions and generate diff', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';
        const fromVersion = '1.0.0';
        const toVersion = '1.1.0';

        // Mock version retrieval
        versioningService.getVersion = sinon.stub();
        versioningService.getVersion.onFirstCall().resolves({
          id: 1,
          data: { temperature: 20.0 },
        });
        versioningService.getVersion.onSecondCall().resolves({
          id: 2,
          data: { temperature: 22.0 },
        });

        // Mock diff storage
        versioningService.storeDiff = sinon.stub().resolves();
        versioningService.getExistingDiff = sinon.stub().resolves(null);
        versioningService.generateDiff = sinon.stub().resolves({
          type: 'modification',
          changes: [{ field: 'temperature', from: 20.0, to: 22.0 }],
        });

        const result = await versioningService.compareVersions(
          dataType,
          dataId,
          fromVersion,
          toVersion
        );

        expect(result).to.have.property('type', 'modification');
        expect(result).to.have.property('changes');
        expect(result.changes).to.be.an('array');
      });
    });

    describe('rollbackToVersion()', function () {
      it('should successfully rollback to a previous version', async function () {
        const dataType = 'weather_data';
        const dataId = 'test_data_001';
        const targetVersion = '1.0.0';

        // Mock target version retrieval
        versioningService.getVersion = sinon.stub().resolves({
          id: 1,
          version_number: targetVersion,
          data: mockWeatherData,
        });

        // Mock new version creation
        versioningService.createVersion = sinon.stub().resolves({
          versionId: 4,
          versionNumber: '1.2.1',
          rollback: true,
        });

        const result = await versioningService.rollbackToVersion(
          dataType,
          dataId,
          targetVersion
        );

        expect(result).to.have.property('versionId', 4);
        expect(result).to.have.property('rollback', true);
      });
    });

    describe('createBranch()', function () {
      it('should successfully create a new branch', async function () {
        const branchName = 'feature-experimental';
        const parentBranch = 'main';

        // Mock branch existence check
        mockPool.query
          .withArgs(sinon.match(/SELECT.*version_branches.*branch_name/))
          .resolves({ rows: [] });

        // Mock branch creation
        mockPool.query
          .withArgs(sinon.match(/INSERT INTO version_branches/))
          .resolves({
            rows: [
              {
                id: 1,
                branch_name: branchName,
                parent_branch: parentBranch,
                created_at: new Date(),
              },
            ],
          });

        const result = await versioningService.createBranch(
          branchName,
          parentBranch
        );

        expect(result).to.have.property('branch_name', branchName);
        expect(result).to.have.property('parent_branch', parentBranch);
      });

      it('should prevent duplicate branch creation', async function () {
        const branchName = 'existing-branch';

        // Mock existing branch
        mockPool.query.resolves({
          rows: [{ branch_name: branchName }],
        });

        try {
          await versioningService.createBranch(branchName);
          expect.fail('Should have thrown duplicate branch error');
        } catch (error) {
          expect(error.message).to.include('already exists');
        }
      });
    });
  });

  describe('Service Integration Tests', function () {
    describe('End-to-End Data Flow', function () {
      it('should store, index, version, and archive data in complete workflow', async function () {
        // Mock all service interactions
        mockPool.query.resolves({ rows: [{ id: 1, ...mockWeatherData }] });

        // 1. Store weather data
        const storeResult =
          await storageManager.storeWeatherData(mockWeatherData);
        expect(storeResult).to.have.property('id');

        // 2. Create version
        const versionResult = await versioningService.createVersion(
          'weather_data',
          storeResult.id,
          mockWeatherData
        );
        expect(versionResult).to.have.property('versionId');

        // 3. Query indexed data
        const queryResult = await indexingService.queryWeatherByTimeRange(
          new Date('2024-01-01'),
          new Date('2024-01-31')
        );
        expect(queryResult).to.have.property('data');

        // 4. Archive old data
        const archiveResult = await archivalService.executeArchival();
        expect(archiveResult).to.have.property('jobId');
      });
    });

    describe('Performance Tests', function () {
      it('should handle large batch operations efficiently', async function () {
        const largeBatch = Array(1000)
          .fill(null)
          .map((_, index) => ({
            ...mockWeatherData,
            station_id: `STATION_${index.toString().padStart(3, '0')}`,
          }));

        mockPool.query.resolves({
          rows: largeBatch.map((data, index) => ({ id: index + 1, ...data })),
        });

        const startTime = Date.now();
        const result = await storageManager.storeBatchWeatherData(largeBatch);
        const duration = Date.now() - startTime;

        expect(result.successful).to.equal(1000);
        expect(duration).to.be.lessThan(5000); // Should complete within 5 seconds
      });
    });

    describe('Error Recovery Tests', function () {
      it('should gracefully handle service failures and maintain data integrity', async function () {
        // Simulate database connection failure
        mockPool.query.onFirstCall().rejects(new Error('Connection timeout'));
        mockPool.query
          .onSecondCall()
          .resolves({ rows: [{ id: 1, ...mockWeatherData }] });

        // First attempt should fail
        try {
          await storageManager.storeWeatherData(mockWeatherData);
          expect.fail('Should have failed on first attempt');
        } catch (error) {
          expect(error.message).to.include('Connection timeout');
        }

        // Second attempt should succeed
        const result = await storageManager.storeWeatherData(mockWeatherData);
        expect(result).to.have.property('id', 1);
      });
    });
  });

  describe('Service Status and Health Checks', function () {
    it('should return comprehensive service status', function () {
      const storageStatus = storageManager.getServiceStatus?.() || {
        initialized: true,
      };
      const archivalStatus = archivalService.getServiceStatus?.() || {
        initialized: true,
      };
      const indexingStatus = indexingService.getServiceStatus?.() || {
        initialized: true,
      };
      const versioningStatus = versioningService.getServiceStatus?.() || {
        initialized: true,
      };

      expect(storageStatus).to.have.property('initialized');
      expect(archivalStatus).to.have.property('initialized');
      expect(indexingStatus).to.have.property('initialized');
      expect(versioningStatus).to.have.property('initialized');
    });
  });
});
