/**
 * Integration Tests for Weather API Services with Data Ingestion Pipeline
 *
 * These tests verify that the data ingestion pipeline works correctly with
 * the actual weather API services implemented in Task 32.1, ensuring
 * end-to-end functionality from API data retrieval through storage.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const WeatherDataIngestionOrchestrator = require('../services/weather-data-ingestion-orchestrator');
const NOAAWeatherService = require('../services/noaa-nws-api-service');
const NOAADataService = require('../services/noaa-data-service');
const EnhancedWeatherController = require('../controllers/enhanced-weather-controller');

describe('Weather API Integration with Ingestion Pipeline', () => {
  let orchestrator;
  let noaaWeatherService;
  let noaaDataService;
  let weatherController;

  beforeEach(() => {
    orchestrator = new WeatherDataIngestionOrchestrator();
    noaaWeatherService = new NOAAWeatherService();
    noaaDataService = new NOAADataService();
    weatherController = new EnhancedWeatherController();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('NOAA NWS API Integration', () => {
    describe('Current Observations Integration', () => {
      it('should fetch and ingest current weather observations from NOAA NWS', async function () {
        this.timeout(10000); // Allow time for API calls

        // Mock NOAA API response to avoid external dependency
        const mockObservation = {
          properties: {
            station: 'KORD',
            timestamp: new Date().toISOString(),
            stationIdentifier: 'KORD',
            stationName: "Chicago O'Hare International Airport",
            temperature: {
              value: 15.5,
              unitCode: 'wmo:degC',
              qualityControl: 'V',
            },
            dewpoint: { value: 8.3, unitCode: 'wmo:degC', qualityControl: 'V' },
            relativeHumidity: {
              value: 65,
              unitCode: 'wmo:percent',
              qualityControl: 'V',
            },
            barometricPressure: {
              value: 101425,
              unitCode: 'wmo:Pa',
              qualityControl: 'V',
            },
            windSpeed: {
              value: 15,
              unitCode: 'wmo:km_h-1',
              qualityControl: 'V',
            },
            windDirection: {
              value: 270,
              unitCode: 'wmo:degree_(angle)',
              qualityControl: 'V',
            },
            visibility: {
              value: 16093,
              unitCode: 'wmo:m',
              qualityControl: 'V',
            },
          },
          geometry: {
            type: 'Point',
            coordinates: [-87.933, 41.995],
          },
        };

        // Mock the API call
        sinon
          .stub(noaaWeatherService, 'getCurrentObservations')
          .resolves(mockObservation);

        // Test fetching and ingesting the data
        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NWS',
          location,
          {
            dataType: 'current',
          }
        );

        expect(result.success).to.be.true;
        expect(result.data).to.exist;
        expect(result.data.metadata.provider).to.equal('NOAA-NWS');
        expect(result.data.metadata.sourceId).to.equal('KORD');
        expect(result.data.location.latitude).to.be.closeTo(41.995, 0.01);
        expect(result.data.location.longitude).to.be.closeTo(-87.933, 0.01);

        // Verify measurements are correctly transformed and cleaned
        expect(result.data.measurements.temperature).to.exist;
        expect(result.data.measurements.temperature.value).to.equal(15.5);
        expect(result.data.measurements.temperature.unit).to.equal('celsius');

        expect(result.data.measurements.pressure).to.exist;
        expect(result.data.measurements.pressure.value).to.be.closeTo(
          1014.25,
          0.01
        ); // Converted from Pa to hPa
        expect(result.data.measurements.pressure.unit).to.equal('hPa');

        expect(result.data.measurements.windSpeed).to.exist;
        expect(result.data.measurements.windSpeed.value).to.be.closeTo(
          4.17,
          0.1
        ); // Converted from km/h to m/s
        expect(result.data.measurements.windSpeed.unit).to.equal('m/s');

        // Verify pipeline steps completed successfully
        expect(result.pipeline.transformation.completed).to.be.true;
        expect(result.pipeline.validation.completed).to.be.true;
        expect(result.pipeline.storage.completed).to.be.true;

        // Verify data quality
        expect(result.pipeline.validation.result.canIngest).to.be.true;
        expect(result.pipeline.validation.result.qualityLevel).to.be.oneOf([
          'excellent',
          'good',
        ]);
      });

      it('should handle NOAA NWS API errors gracefully', async function () {
        this.timeout(5000);

        // Mock API error
        sinon
          .stub(noaaWeatherService, 'getCurrentObservations')
          .rejects(new Error('NOAA API unavailable'));

        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NWS',
          location,
          {
            dataType: 'current',
          }
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.have.length.greaterThan(0);
        expect(result.errors[0]).to.include('NOAA API unavailable');
      });

      it('should validate NOAA NWS data quality appropriately', async function () {
        this.timeout(5000);

        // Mock observation with quality issues
        const mockPoorQualityObservation = {
          properties: {
            station: 'KORD',
            timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours old
            temperature: {
              value: 150,
              unitCode: 'wmo:degC',
              qualityControl: 'X',
            }, // Impossible temperature
            dewpoint: { value: 160, unitCode: 'wmo:degC', qualityControl: 'X' }, // Dewpoint > temperature
            relativeHumidity: {
              value: 120,
              unitCode: 'wmo:percent',
              qualityControl: 'X',
            }, // > 100%
            barometricPressure: {
              value: 50000,
              unitCode: 'wmo:Pa',
              qualityControl: 'X',
            }, // Impossible pressure
          },
          geometry: {
            coordinates: [-87.933, 41.995],
          },
        };

        sinon
          .stub(noaaWeatherService, 'getCurrentObservations')
          .resolves(mockPoorQualityObservation);

        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NWS',
          location,
          {
            dataType: 'current',
            strictMode: false, // Allow ingestion despite quality issues
          }
        );

        expect(result.success).to.be.true; // Should succeed in non-strict mode
        expect(result.warnings).to.have.length.greaterThan(0);
        expect(result.pipeline.validation.result.qualityLevel).to.be.oneOf([
          'poor',
          'fair',
          'invalid',
        ]);

        // Should have flagged data freshness issues
        expect(
          result.pipeline.validation.result.validationChecks.freshnessValidation
            .passed
        ).to.be.false;

        // Should have flagged physics validation issues
        expect(
          result.pipeline.validation.result.validationChecks.physicsValidation
            .passed
        ).to.be.false;
      });
    });

    describe('Weather Alerts Integration', () => {
      it('should fetch and process weather alerts from NOAA NWS', async function () {
        this.timeout(5000);

        const mockAlerts = {
          alerts: [
            {
              id: 'urn:oid:2.49.0.1.840.0.123456789',
              areaDesc: 'Cook County',
              event: 'Winter Weather Advisory',
              headline: 'Winter Weather Advisory issued for Cook County',
              description: 'Snow expected with accumulations of 3 to 5 inches.',
              severity: 'Minor',
              urgency: 'Expected',
              onset: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
              expires: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
            },
          ],
          count: 1,
        };

        sinon.stub(noaaWeatherService, 'getAlerts').resolves(mockAlerts);

        const alerts = await noaaWeatherService.getAlerts(41.995, -87.933);

        expect(alerts).to.exist;
        expect(alerts.count).to.equal(1);
        expect(alerts.alerts).to.have.length(1);
        expect(alerts.alerts[0].event).to.equal('Winter Weather Advisory');
        expect(alerts.alerts[0].severity).to.equal('Minor');
      });
    });

    describe('Station Discovery Integration', () => {
      it('should discover nearby weather stations from NOAA NWS', async function () {
        this.timeout(5000);

        const mockStations = {
          stations: [
            {
              id: 'KORD',
              name: "Chicago O'Hare International Airport",
              latitude: 41.995,
              longitude: -87.933,
              elevation: 205,
              type: 'ASOS',
              distance: 0.5,
            },
            {
              id: 'KMDW',
              name: 'Chicago Midway International Airport',
              latitude: 41.786,
              longitude: -87.752,
              elevation: 189,
              type: 'ASOS',
              distance: 15.2,
            },
          ],
          count: 2,
        };

        sinon
          .stub(noaaWeatherService, 'getNearbyStations')
          .resolves(mockStations);

        const stations = await noaaWeatherService.getNearbyStations(
          41.995,
          -87.933,
          10
        );

        expect(stations).to.exist;
        expect(stations.count).to.equal(2);
        expect(stations.stations).to.have.length(2);
        expect(stations.stations[0].id).to.equal('KORD');
        expect(stations.stations[0].distance).to.be.below(1); // Very close to O'Hare
      });
    });
  });

  describe('NOAA NCEI Historical Data Integration', () => {
    describe('Historical Data Ingestion', () => {
      it('should fetch and ingest historical weather data from NOAA NCEI', async function () {
        this.timeout(10000);

        // Mock historical data response
        const mockHistoricalData = {
          metadata: {
            resultset: {
              offset: 1,
              count: 3,
              limit: 25,
            },
          },
          results: [
            {
              date: '2024-01-15',
              datatype: 'TMAX',
              station: 'USC00111577',
              attributes: 'W',
              value: 55, // 5.5°C in tenths
            },
            {
              date: '2024-01-15',
              datatype: 'TMIN',
              station: 'USC00111577',
              attributes: 'W',
              value: -20, // -2.0°C in tenths
            },
            {
              date: '2024-01-15',
              datatype: 'PRCP',
              station: 'USC00111577',
              attributes: 'W',
              value: 25, // 2.5mm in tenths
            },
          ],
        };

        const mockStationsResponse = {
          stations: [
            {
              id: 'USC00111577',
              name: 'CHICAGO OHARE INTL AP',
              latitude: 41.995,
              longitude: -87.933,
              elevation: 205,
              distance: 0.5,
            },
          ],
          count: 1,
        };

        sinon
          .stub(noaaDataService, 'findStationsNearLocation')
          .resolves(mockStationsResponse);
        sinon
          .stub(noaaDataService, 'getHistoricalData')
          .resolves(mockHistoricalData);

        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NCEI',
          location,
          {
            dataType: 'historical',
            startDate: '2024-01-15',
            endDate: '2024-01-15',
          }
        );

        expect(result.success).to.be.true;
        expect(result.data).to.exist;
        expect(result.data.metadata.provider).to.equal('NOAA-NCEI');
        expect(result.data.metadata.dataType).to.equal('historical');

        // Verify station information
        expect(result.data.location.stationId).to.include('USC00111577');

        // Verify historical measurements are correctly transformed
        // Note: The transformation will depend on how the NOAA NCEI transformer handles the data
        expect(result.pipeline.transformation.completed).to.be.true;
        expect(result.pipeline.validation.completed).to.be.true;
      });

      it('should handle missing historical data gracefully', async function () {
        this.timeout(5000);

        const mockEmptyStationsResponse = {
          stations: [],
          count: 0,
        };

        sinon
          .stub(noaaDataService, 'findStationsNearLocation')
          .resolves(mockEmptyStationsResponse);

        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NCEI',
          location,
          {
            dataType: 'historical',
            startDate: '2024-01-15',
            endDate: '2024-01-15',
          }
        );

        expect(result.success).to.be.false;
        expect(result.errors).to.include.something.that.includes(
          'No weather stations found'
        );
      });
    });
  });

  describe('Enhanced Weather Controller Integration', () => {
    describe('Controller with Ingestion Pipeline', () => {
      it('should integrate controller responses with ingestion pipeline', async function () {
        this.timeout(10000);

        // Mock the controller's NOAA service calls
        const mockObservation = {
          source: 'NOAA-NWS',
          dataType: 'current_observation',
          timestamp: new Date().toISOString(),
          location: {
            latitude: 41.995,
            longitude: -87.933,
            stationId: 'KORD',
          },
          data: {
            temperature: 15.5,
            temperatureUnit: 'celsius',
            humidity: 65,
            pressure: 1014.25,
            pressureUnit: 'hPa',
            windSpeed: 4.17,
            windDirection: 270,
            visibility: 16.093,
          },
          quality: {
            source: 'NOAA-NWS',
            confidence: 0.95,
            validationPassed: true,
          },
        };

        sinon
          .stub(weatherController.noaaWeatherService, 'getCurrentObservations')
          .resolves(mockObservation);
        sinon
          .stub(
            weatherController.noaaWeatherService,
            'transformToWRFCoinFormat'
          )
          .returns(mockObservation);

        // Mock request and response objects
        const mockReq = {
          params: { location: '41.995,-87.933' },
          query: {},
        };

        const mockRes = {
          json: sinon.spy(),
          status: sinon.stub().returnsThis(),
        };

        // Call the controller method
        await weatherController.getCurrentWeather(mockReq, mockRes);

        expect(mockRes.json.calledOnce).to.be.true;
        const responseData = mockRes.json.getCall(0).args[0];

        expect(responseData.status).to.equal('success');
        expect(responseData.source).to.equal('NOAA-NWS');
        expect(responseData.current).to.exist;

        // Now test ingesting this controller response data
        const ingestionResult = await orchestrator.ingestWeatherData(
          'NOAA-NWS',
          mockObservation
        );

        expect(ingestionResult.success).to.be.true;
        expect(ingestionResult.data.measurements.temperature.value).to.equal(
          15.5
        );
        expect(ingestionResult.data.measurements.pressure.value).to.equal(
          1014.25
        );
      });
    });

    describe('Controller Error Handling with Pipeline', () => {
      it('should handle controller API failures and fallback mechanisms', async function () {
        this.timeout(5000);

        // Mock API failure
        sinon
          .stub(weatherController.noaaWeatherService, 'getCurrentObservations')
          .rejects(new Error('API Rate Limited'));

        const mockReq = {
          params: { location: '41.995,-87.933' },
          query: {},
        };

        const mockRes = {
          json: sinon.spy(),
          status: sinon.stub().returnsThis(),
        };

        // Set fallback to mock mode
        weatherController.fallbackToMock = true;

        await weatherController.getCurrentWeather(mockReq, mockRes);

        expect(mockRes.json.calledOnce).to.be.true;
        const responseData = mockRes.json.getCall(0).args[0];

        expect(responseData.status).to.equal('success');
        expect(responseData.source).to.equal('mock-fallback');

        // Verify that even mock data can be ingested successfully
        const mockData = responseData.current;
        const ingestionResult = await orchestrator.ingestWeatherData(
          'LocalStation',
          mockData
        );

        expect(ingestionResult.success).to.be.true;
        expect(ingestionResult.pipeline.validation.result.canIngest).to.be.true;
      });
    });
  });

  describe('Data Flow Integration Tests', () => {
    describe('Complete Data Flow', () => {
      it('should demonstrate complete data flow from API to storage', async function () {
        this.timeout(15000);

        // Test multiple data sources in sequence
        const testLocations = [
          { name: "Chicago O'Hare", latitude: 41.995, longitude: -87.933 },
          { name: 'Los Angeles LAX', latitude: 33.943, longitude: -118.408 },
          { name: 'New York JFK', latitude: 40.64, longitude: -73.779 },
        ];

        const results = [];

        for (const location of testLocations) {
          // Mock different types of weather data for each location
          const mockObservation = {
            properties: {
              station: `${location.name.replace(/\s+/g, '')}_STN`,
              timestamp: new Date().toISOString(),
              temperature: {
                value: 20 + Math.random() * 10,
                unitCode: 'wmo:degC',
              },
              relativeHumidity: {
                value: 50 + Math.random() * 30,
                unitCode: 'wmo:percent',
              },
              barometricPressure: {
                value: 101000 + Math.random() * 2000,
                unitCode: 'wmo:Pa',
              },
            },
            geometry: {
              coordinates: [location.longitude, location.latitude],
            },
          };

          sinon
            .stub(noaaWeatherService, 'getCurrentObservations')
            .resolves(mockObservation);

          const result = await orchestrator.fetchAndIngestFromSource(
            'NOAA-NWS',
            location
          );
          results.push(result);

          // Restore stub for next iteration
          noaaWeatherService.getCurrentObservations.restore();
        }

        // Verify all ingestions succeeded
        expect(results).to.have.length(3);
        results.forEach((result, index) => {
          expect(result.success).to.be.true;
          expect(result.data.location.latitude).to.be.closeTo(
            testLocations[index].latitude,
            0.01
          );
          expect(result.data.location.longitude).to.be.closeTo(
            testLocations[index].longitude,
            0.01
          );
        });

        // Verify orchestrator metrics
        const status = orchestrator.getStatus();
        expect(status.metrics.totalProcessed).to.equal(3);
        expect(status.metrics.totalIngested).to.equal(3);
        expect(status.metrics.successRate).to.equal(1.0);
      });

      it('should handle mixed quality data across multiple sources', async function () {
        this.timeout(10000);

        const mixedQualityData = [
          {
            source: 'NOAA-NWS',
            rawData: {
              properties: {
                station: 'EXCELLENT_STN',
                timestamp: new Date().toISOString(),
                temperature: {
                  value: 20,
                  unitCode: 'wmo:degC',
                  qualityControl: 'V',
                },
                relativeHumidity: {
                  value: 60,
                  unitCode: 'wmo:percent',
                  qualityControl: 'V',
                },
              },
              geometry: { coordinates: [-87.933, 41.995] },
            },
          },
          {
            source: 'NOAA-NWS',
            rawData: {
              properties: {
                station: 'POOR_STN',
                timestamp: new Date(
                  Date.now() - 10 * 60 * 60 * 1000
                ).toISOString(), // Old data
                temperature: {
                  value: 200,
                  unitCode: 'wmo:degC',
                  qualityControl: 'X',
                }, // Impossible
                relativeHumidity: {
                  value: null,
                  unitCode: 'wmo:percent',
                  qualityControl: 'M',
                }, // Missing
              },
              geometry: { coordinates: [-118.408, 33.943] },
            },
          },
          {
            source: 'OpenWeatherMap',
            rawData: {
              coord: { lat: 40.64, lon: -73.779 },
              main: { temp: 283.15, humidity: 65, pressure: 1013 },
              dt: Math.floor(Date.now() / 1000),
            },
          },
        ];

        const results = await orchestrator.ingestWeatherBatch(mixedQualityData);

        expect(results).to.have.length(3);

        // First result should be excellent quality
        expect(results[0].success).to.be.true;
        expect(results[0].pipeline.validation.result?.qualityLevel).to.equal(
          'excellent'
        );

        // Second result should have quality issues but still ingest in non-strict mode
        expect(results[1].success).to.be.true;
        expect(results[1].warnings).to.have.length.greaterThan(0);
        expect(results[1].pipeline.validation.result?.qualityLevel).to.be.oneOf(
          ['poor', 'fair']
        );

        // Third result should be good quality (commercial API)
        expect(results[2].success).to.be.true;
        expect(results[2].pipeline.validation.result?.qualityLevel).to.be.oneOf(
          ['good', 'fair']
        );
      });
    });

    describe('Performance and Scaling', () => {
      it('should handle concurrent ingestion requests efficiently', async function () {
        this.timeout(20000);

        const concurrentRequests = 10;
        const promises = [];

        for (let i = 0; i < concurrentRequests; i++) {
          const mockData = {
            properties: {
              station: `CONCURRENT_STN_${i}`,
              timestamp: new Date().toISOString(),
              temperature: { value: 15 + i, unitCode: 'wmo:degC' },
              relativeHumidity: { value: 60, unitCode: 'wmo:percent' },
            },
            geometry: { coordinates: [-87.933 + i * 0.1, 41.995 + i * 0.1] },
          };

          promises.push(orchestrator.ingestWeatherData('NOAA-NWS', mockData));
        }

        const startTime = Date.now();
        const results = await Promise.all(promises);
        const totalTime = Date.now() - startTime;

        expect(results).to.have.length(concurrentRequests);
        expect(totalTime).to.be.below(15000); // Should complete within 15 seconds

        const successCount = results.filter(r => r.success).length;
        expect(successCount).to.equal(concurrentRequests);

        // Verify orchestrator tracked all requests
        const status = orchestrator.getStatus();
        expect(status.metrics.totalProcessed).to.equal(concurrentRequests);
      });
    });
  });

  describe('Error Recovery and Resilience', () => {
    describe('Network Failure Recovery', () => {
      it('should handle intermittent network failures with retry logic', async function () {
        this.timeout(10000);

        const callCount = 0;
        const stubbedMethod = sinon.stub(
          noaaWeatherService,
          'getCurrentObservations'
        );

        // Fail first two calls, succeed on third
        stubbedMethod.onFirstCall().rejects(new Error('Network timeout'));
        stubbedMethod.onSecondCall().rejects(new Error('Connection refused'));
        stubbedMethod.onThirdCall().resolves({
          properties: {
            station: 'RETRY_STN',
            timestamp: new Date().toISOString(),
            temperature: { value: 20, unitCode: 'wmo:degC' },
          },
          geometry: { coordinates: [-87.933, 41.995] },
        });

        // Note: The orchestrator doesn't currently implement retry logic,
        // but we can test that it handles failures gracefully
        const location = { latitude: 41.995, longitude: -87.933 };
        const result = await orchestrator.fetchAndIngestFromSource(
          'NOAA-NWS',
          location
        );

        // Since we don't have retry logic, this should fail
        expect(result.success).to.be.false;
        expect(result.errors).to.have.length.greaterThan(0);
      });
    });

    describe('Malformed Data Recovery', () => {
      it('should handle malformed API responses gracefully', async function () {
        this.timeout(5000);

        const malformedResponses = [
          null,
          undefined,
          {},
          { properties: null },
          { properties: { station: null } },
          { geometry: { coordinates: null } },
        ];

        const results = [];

        for (const malformedData of malformedResponses) {
          const result = await orchestrator.ingestWeatherData(
            'NOAA-NWS',
            malformedData
          );
          results.push(result);
        }

        // All should fail gracefully without crashing
        expect(results).to.have.length(malformedResponses.length);
        results.forEach(result => {
          expect(result.success).to.be.false;
          expect(result.errors).to.have.length.greaterThan(0);
        });
      });
    });
  });

  describe('Monitoring and Observability', () => {
    describe('Metrics Collection', () => {
      it('should collect comprehensive metrics during integration', async function () {
        this.timeout(10000);

        // Reset metrics
        orchestrator.resetMetrics();

        const testData = [
          {
            source: 'NOAA-NWS',
            rawData: {
              properties: {
                station: 'METRIC_STN_1',
                timestamp: new Date().toISOString(),
                temperature: { value: 20, unitCode: 'wmo:degC' },
              },
              geometry: { coordinates: [-87.933, 41.995] },
            },
          },
          {
            source: 'NOAA-NWS',
            rawData: { invalid: 'data' }, // This will fail
          },
        ];

        await orchestrator.ingestWeatherBatch(testData);

        const status = orchestrator.getStatus();
        const detailedStats = orchestrator.getDetailedStatistics();

        expect(status.metrics.totalProcessed).to.equal(2);
        expect(status.metrics.totalIngested).to.equal(1);
        expect(status.metrics.totalRejected).to.equal(1);
        expect(status.metrics.successRate).to.equal(0.5);

        expect(detailedStats.performance).to.exist;
        expect(detailedStats.performance.processingTimeDistribution).to.exist;
        expect(detailedStats.performance.errorAnalysis).to.exist;
      });
    });
  });
});
