/**
 * Weather Data GraphQL Resolvers
 * Handles weather stations, weather data, and oracle integration
 */

import { ethers } from 'ethers';
import {
  GraphQLContext,
  requireAuth,
  requireVerifiedWallet,
} from '../context.js';
import { logger } from '../../utils/logger.js';
import { formatError } from '../error-handler.js';
import { pubsub } from '../subscriptions/pubsub.js';
import { eq, gte, lte, desc, asc, and, or, sql, like } from 'drizzle-orm';
import {
  weatherData,
  weatherForecasts,
  weatherStations,
  weatherDataQuality,
} from '../../shared/schema.js';

function withLegacyWeatherFields(record: {
  id: any;
  stationId: string;
  timestamp: any;
  temperature: any;
  humidity: any;
  pressure: any;
  windSpeed?: any;
  rainfall?: any;
  confidence?: any;
}) {
  const precipitation = record.rainfall ?? '0';

  return {
    id: record.id,
    stationId: record.stationId,
    timestamp: record.timestamp,
    temperature: record.temperature,
    temperature_c: record.temperature,
    humidity: record.humidity,
    humidity_percent: record.humidity,
    pressure: record.pressure,
    pressure_hpa: record.pressure,
    windSpeed: record.windSpeed ?? '0',
    wind_speed_ms: record.windSpeed ?? '0',
    rainfall: precipitation,
    precipitation_mm: precipitation,
    confidence: record.confidence ?? 0.95,
  };
}

export const weatherResolvers = {
  Query: {
    // Get single weather station
    weatherStation: async (
      _: any,
      { id }: { id: string },
      context: GraphQLContext
    ) => {
      try {
        // Convert string ID to bytes32 for blockchain query
        const stationId = ethers.keccak256(ethers.toUtf8Bytes(id));

        // Check if station exists and is active
        const isActive =
          await context.contracts.weatherOracle.isStationActive(stationId);
        if (!isActive) {
          return null;
        }

        // Get station location
        const location =
          await context.contracts.weatherOracle.getStationLocation(stationId);

        // Get quality score
        const qualityScore =
          await context.contracts.weatherOracle.getDataQualityScore(stationId);

        // Get latest weather data
        const latestData =
          await context.contracts.weatherOracle.getLatestWeatherData(stationId);

        // Query database for additional station info
        const stationRecord = await context.db.query.weatherStations.findFirst({
          where: eq(weatherStations.stationId, id),
        });

        return {
          id,
          address:
            stationRecord?.ownerAddress ||
            '0x0000000000000000000000000000000000000000',
          stationId: id,
          location,
          isActive,
          lastRewardTime: stationRecord?.lastRewardTime,
          totalRewards: stationRecord?.totalRewards || '0',
          qualityScore: Number(qualityScore) / 100, // Convert from basis points
        };
      } catch (error) {
        logger.error('Error fetching weather station', {
          id,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'WEATHER_STATION_FETCH_ERROR',
        });
      }
    },

    // Get multiple weather stations with filtering
    weatherStations: async (
      _: any,
      {
        first = 10,
        skip = 0,
        orderBy = 'id',
        orderDirection = 'asc',
        where,
      }: {
        first?: number;
        skip?: number;
        orderBy?: string;
        orderDirection?: string;
        where?: any;
      },
      context: GraphQLContext
    ) => {
      try {
        // Build query conditions
        const queryConditions: any[] = [];

        if (where) {
          // Apply isActive filter
          if (where.isActive !== undefined) {
            queryConditions.push(eq(weatherStations.isActive, where.isActive));
          }

          // Apply location filter
          if (where.location_contains) {
            queryConditions.push(
              like(weatherStations.location, `%${where.location_contains}%`)
            );
          }

          // Apply quality score filter
          if (where.qualityScore_gte) {
            queryConditions.push(
              gte(weatherStations.qualityScore, where.qualityScore_gte * 100)
            );
          }
        }

        const whereClause =
          queryConditions.length > 0 ? and(...queryConditions) : undefined;

        // Apply ordering
        let orderByClause;
        if (orderBy === 'qualityScore') {
          orderByClause =
            orderDirection === 'desc'
              ? desc(weatherStations.qualityScore)
              : asc(weatherStations.qualityScore);
        } else {
          orderByClause =
            orderDirection === 'desc'
              ? desc(weatherStations.createdAt)
              : asc(weatherStations.createdAt);
        }

        const stations = await context.db.query.weatherStations.findMany({
          where: whereClause,
          limit: Math.min(first, 100),
          offset: skip,
          orderBy: orderByClause,
        });

        // Enrich with blockchain data using DataLoader for deduplication/caching
        const stationBytes32Ids = stations.map(station =>
          ethers.keccak256(ethers.toUtf8Bytes(station.stationId))
        );
        const qualityScores = await Promise.all(
          stationBytes32Ids.map(id => context.loaders.qualityScores.load(id))
        );

        const enrichedStations = stations.map((station, index) => ({
          id: station.stationId,
          address: station.ownerAddress,
          stationId: station.stationId,
          location: station.location,
          isActive: station.isActive,
          lastRewardTime: station.lastRewardTime,
          totalRewards: station.totalRewards || '0',
          qualityScore: qualityScores[index] / 100,
        }));

        return enrichedStations;
      } catch (error) {
        logger.error('Error fetching weather stations', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'WEATHER_STATIONS_FETCH_ERROR',
        });
      }
    },

    // Get weather data for a station
    weatherData: async (
      _: any,
      {
        stationId,
        from,
        to,
        first = 100,
      }: {
        stationId: string;
        from?: Date;
        to?: Date;
        first?: number;
      },
      context: GraphQLContext
    ) => {
      try {
        // Build query conditions
        const conditions = [eq(weatherData.stationId, stationId)];

        if (from) {
          conditions.push(gte(weatherData.timestamp, from));
        }

        if (to) {
          conditions.push(lte(weatherData.timestamp, to));
        }

        const weatherRecords = await context.db.query.weatherData.findMany({
          where: and(...conditions),
          limit: Math.min(first, 1000), // Cap at 1000 records
          orderBy: desc(weatherData.timestamp),
        });

        // Batch fetch quality data for all weather records
        const dataIds = weatherRecords.map(r => r.dataId);
        const qualityRecords = await context.db.query.weatherDataQuality.findMany({
          where: sql`${weatherDataQuality.dataId} IN (${sql.join(dataIds.map(id => sql`${id}`), sql`, `)})`,
        });
        const qualityMap = new Map(
          qualityRecords.map(q => [q.dataId, q.confidence])
        );

        return weatherRecords.map(record =>
          withLegacyWeatherFields({
            ...record,
            rainfall: record.precipitation || '0',
            confidence: qualityMap.get(record.dataId) ?? 0.95,
          })
        );
      } catch (error) {
        logger.error('Error fetching weather data', {
          stationId,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'WEATHER_DATA_FETCH_ERROR',
        });
      }
    },
  },

  Mutation: {
    // Submit weather data
    submitWeatherData: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      try {
        const user = requireVerifiedWallet(context);

        // Validate input data
        if (!input.stationId || !input.signature) {
          throw new Error('Station ID and signature are required');
        }

        // Normalize input: accept both legacy and canonical field names
        const temperature = input.temperature_c ?? input.temperature;
        const humidity = input.humidity_percent ?? input.humidity;
        const pressure = input.pressure_hpa ?? input.pressure;
        const windSpeed = input.wind_speed_ms ?? input.windSpeed;
        const rainfall = input.precipitation_mm ?? input.rainfall;

        if (
          temperature == null ||
          humidity == null ||
          pressure == null ||
          windSpeed == null ||
          rainfall == null
        ) {
          throw new Error(
            'Temperature, humidity, pressure, wind speed, and rainfall are required'
          );
        }

        // Verify the signature matches the weather data
        const dataHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            [
              'string',
              'int256',
              'uint256',
              'uint256',
              'uint256',
              'uint256',
              'uint256',
            ],
            [
              input.stationId,
              Math.round(temperature * 100),
              Math.round(humidity * 100),
              Math.round(pressure * 100),
              Math.round(windSpeed * 100),
              Math.round(rainfall * 100),
              Math.round(input.confidence * 100),
            ]
          )
        );

        const recoveredAddress = ethers.verifyMessage(
          ethers.getBytes(dataHash),
          input.signature
        );

        if (recoveredAddress.toLowerCase() !== user.address.toLowerCase()) {
          throw new Error('Invalid signature for weather data');
        }

        // Check if user is authorized to submit data for this station
        const stationRecord = await context.db.query.weatherStations.findFirst({
          where: eq(weatherStations.stationId, input.stationId),
        });

        if (!stationRecord) {
          throw new Error('Weather station not found');
        }

        // Check authorization: owner OR authorized oracle
        const isOwner =
          stationRecord.ownerAddress?.toLowerCase() === user.address.toLowerCase();
        const stationMetadata = stationRecord.metadata as Record<string, any> | null;
        const authorizedOracles = stationMetadata?.authorizedOracles || [];
        const isAuthorizedOracle = authorizedOracles.some(
          (oracle: string) => oracle.toLowerCase() === user.address.toLowerCase()
        );

        if (!isOwner && !isAuthorizedOracle) {
          throw new Error(
            'Not authorized to submit weather data for this station. ' +
            'Only station owner or authorized oracles can submit data.'
          );
        }

        // Validate weather data ranges
        if (temperature < -50 || temperature > 70) {
          throw new Error('Temperature out of valid range (-50°C to 70°C)');
        }
        if (humidity < 0 || humidity > 100) {
          throw new Error('Humidity out of valid range (0% to 100%)');
        }
        if (input.confidence < 0 || input.confidence > 100) {
          throw new Error('Confidence out of valid range (0% to 100%)');
        }

        // Get location from input or station record
        const stationLocation = stationMetadata?.location as Record<string, any> | undefined;
        const latitude = input.latitude?.toString() ||
          stationLocation?.lat?.toString() ||
          stationRecord.location || '0';
        const longitude = input.longitude?.toString() ||
          stationLocation?.lng?.toString() || '0';

        // Calculate quality score based on input confidence and station quality
        const calculatedConfidence = calculateDataConfidence(
          input.confidence || 0.95,
          stationRecord.qualityScore,
          {
            temperature,
            humidity,
            pressure,
          }
        );

        // Store weather data in database
        const dataId = `${input.stationId}-${Date.now()}`;
        const [weatherRecord] = await context.db
          .insert(weatherData)
          .values({
            dataId,
            stationId: input.stationId,
            timestamp: new Date(),
            latitude,
            longitude,
            temperature: temperature?.toString(),
            humidity: humidity?.toString(),
            pressure: pressure?.toString(),
            windSpeed: windSpeed?.toString(),
            precipitation: rainfall?.toString(),
            dataHash: ethers.keccak256(
              ethers.toUtf8Bytes(JSON.stringify(input))
            ),
            sourceType: 'station',
            verificationStatus: 'verified',
          })
          .returning();

        // Store quality metrics for this submission
        await context.db.insert(weatherDataQuality).values({
          stationId: input.stationId,
          submissionId: dataId,
          dataId: dataId,
          qualityScore: stationRecord.qualityScore || 50,
          confidence: calculatedConfidence,
          factors: {
            inputConfidence: input.confidence,
            stationQuality: stationRecord.qualityScore,
            dataRangeValid: true,
            submittedBy: isOwner ? 'owner' : 'oracle',
          },
          validationStatus: 'validated',
          validatedBy: user.address,
        });

        // Submit to blockchain oracle (this would trigger reward calculation)
        const stationIdBytes32 = ethers.keccak256(
          ethers.toUtf8Bytes(input.stationId)
        );

        // Note: In production, this would be submitted by an authorized oracle
        // For demo, we simulate the blockchain update
        logger.info('Weather data submitted to blockchain oracle', {
          stationId: input.stationId,
          user: user.address,
          dataId: weatherRecord.id,
          requestId: context.requestId,
        });

        // Calculate potential rewards (this would be done by smart contract)
        const rewardAmount = calculateWeatherReward(
          input.confidence,
          stationRecord.qualityScore
        );

        // Publish subscription update
        pubsub.publish('WEATHER_DATA_UPDATED', {
          weatherDataUpdated: withLegacyWeatherFields({
            id: weatherRecord.id,
            stationId: weatherRecord.stationId,
            timestamp: weatherRecord.timestamp,
            temperature: weatherRecord.temperature,
            humidity: weatherRecord.humidity,
            pressure: weatherRecord.pressure,
            windSpeed: weatherRecord.windSpeed,
            rainfall: weatherRecord.precipitation || '0',
            confidence: calculatedConfidence,
          }),
        });

        return {
          success: true,
          weatherData: withLegacyWeatherFields({
            id: weatherRecord.id,
            stationId: weatherRecord.stationId,
            timestamp: weatherRecord.timestamp,
            temperature: weatherRecord.temperature,
            humidity: weatherRecord.humidity,
            pressure: weatherRecord.pressure,
            windSpeed: weatherRecord.windSpeed,
            rainfall: weatherRecord.precipitation || '0',
            confidence: calculatedConfidence,
          }),
          rewards: rewardAmount,
          error: null,
        };
      } catch (error) {
        logger.error('Error submitting weather data', {
          input,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          weatherData: null,
          rewards: '0',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },

  // Field resolvers
  WeatherStation: {
    weatherData: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const weatherRecords = await context.db.query.weatherData.findMany({
          where: eq(weatherData.stationId, parent.stationId),
          limit: Math.min(first, 100),
          orderBy: desc(weatherData.timestamp),
        });

        return weatherRecords.map(record =>
          withLegacyWeatherFields({
            ...record,
            rainfall: record.precipitation || '0',
          })
        );
      } catch (error) {
        logger.error('Error fetching weather data for station', {
          stationId: parent.stationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    latestWeatherData: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        const latestRecord = await context.db.query.weatherData.findFirst({
          where: eq(weatherData.stationId, parent.stationId),
          orderBy: desc(weatherData.timestamp),
        });

        return latestRecord
          ? withLegacyWeatherFields({
              ...latestRecord,
              rainfall: latestRecord.precipitation || '0',
            })
          : null;
      } catch (error) {
        logger.error('Error fetching latest weather data', {
          stationId: parent.stationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  },

  WeatherData: {
    station: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        const stationRecord = await context.db.query.weatherStations.findFirst({
          where: eq(weatherStations.stationId, parent.stationId),
        });

        if (!stationRecord) {
          return null;
        }

        const stationIdBytes32 = ethers.keccak256(
          ethers.toUtf8Bytes(parent.stationId)
        );
        const qualityScore = await context.loaders.qualityScores.load(
          stationIdBytes32
        );

        return {
          id: stationRecord.stationId,
          address: stationRecord.ownerAddress,
          stationId: stationRecord.stationId,
          location: stationRecord.location,
          isActive: stationRecord.isActive,
          lastRewardTime: stationRecord.lastRewardTime,
          totalRewards: stationRecord.totalRewards || '0',
          qualityScore: qualityScore / 100,
        };
      } catch (error) {
        logger.error('Error fetching station for weather data', {
          stationId: parent.stationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  },
};

// Helper function to calculate weather rewards
function calculateWeatherReward(
  confidence: number,
  qualityScore: number
): string {
  // Base reward: 17.5 WRF tokens (from smart contract)
  const baseReward = BigInt('17500000000000000000'); // 17.5 * 10^18

  // Apply confidence multiplier (0.5x to 1.5x based on confidence)
  const confidenceMultiplier = 50 + confidence; // 50-150

  // Apply quality score multiplier (0.8x to 1.2x based on station quality)
  const qualityMultiplier = 80 + (qualityScore * 40) / 100; // 80-120

  const totalMultiplier = (confidenceMultiplier * qualityMultiplier) / 10000;
  const finalReward = (baseReward * BigInt(totalMultiplier)) / BigInt(100);

  return finalReward.toString();
}

// Helper function to calculate data confidence from input and station quality
function calculateDataConfidence(
  inputConfidence: number,
  stationQualityScore: number | null,
  weatherData: { temperature?: number; humidity?: number; pressure?: number }
): number {
  // Base confidence from input (0-1 scale)
  let confidence = inputConfidence > 1 ? inputConfidence / 100 : inputConfidence;

  // Apply station quality factor (weight: 30%)
  const stationQuality = (stationQualityScore || 50) / 100;
  confidence = confidence * 0.7 + stationQuality * 0.3;

  // Apply range validation penalties
  if (weatherData.temperature !== undefined) {
    // Penalize extreme values slightly
    if (weatherData.temperature < -40 || weatherData.temperature > 50) {
      confidence *= 0.95; // 5% penalty for extreme but valid temperatures
    }
  }

  if (weatherData.humidity !== undefined) {
    // Penalize unlikely humidity values
    if (weatherData.humidity < 5 || weatherData.humidity > 99) {
      confidence *= 0.98; // 2% penalty for very low/high humidity
    }
  }

  if (weatherData.pressure !== undefined) {
    // Penalize unusual pressure values (normal range: 980-1030 hPa)
    if (weatherData.pressure < 950 || weatherData.pressure > 1050) {
      confidence *= 0.97; // 3% penalty for unusual pressure
    }
  }

  // Ensure confidence stays in valid range
  return Math.max(0, Math.min(1, confidence));
}
