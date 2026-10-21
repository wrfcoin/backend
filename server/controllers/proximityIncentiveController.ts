/**
 * Proximity Incentive Controller - TypeScript Implementation
 * Handles location-based incentives and proximity rewards for weather stations
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';
import { iotLogger } from '../utils/logger.js';

// Proximity Incentive interfaces
interface ProximityZone {
  id: string;
  name: string;
  description: string;
  coordinates: {
    center: {
      latitude: number;
      longitude: number;
    };
    radius: number; // meters
    boundaries?: number[][]; // polygon coordinates
  };
  incentiveType:
    | 'weather_density'
    | 'coverage_gap'
    | 'high_value_area'
    | 'research_zone'
    | 'emergency_zone';
  multiplier: number; // reward multiplier (1.0 = no bonus, 2.0 = double rewards)
  requirements: {
    minStations: number;
    maxStations: number;
    dataTypes: string[];
    updateFrequency: number; // minutes
    qualityThreshold: number; // percentage
  };
  rewards: {
    baseBonus: PositiveNumber;
    proximityBonus: PositiveNumber;
    densityBonus: PositiveNumber;
    qualityBonus: PositiveNumber;
  };
  status: 'active' | 'inactive' | 'expired' | 'paused';
  validFrom: Date;
  validUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface WeatherStation {
  id: string;
  stationId: string;
  owner: EthereumAddress;
  name: string;
  location: {
    latitude: number;
    longitude: number;
    elevation?: number;
    address?: string;
  };
  equipment: {
    type: string;
    model: string;
    sensors: string[];
    calibration: Date;
    accuracy: Record<string, number>;
  };
  status: 'active' | 'inactive' | 'maintenance' | 'offline';
  metrics: {
    uptime: number; // percentage
    dataQuality: number; // percentage
    updateFrequency: number; // minutes
    totalSubmissions: number;
    rewardsEarned: PositiveNumber;
  };
  proximityZones: string[]; // zone IDs
  createdAt: Date;
  updatedAt: Date;
}

interface ProximityReward {
  id: string;
  recipient: EthereumAddress;
  stationId: string;
  zoneId: string;
  rewardType: 'proximity' | 'density' | 'coverage' | 'quality' | 'emergency';
  baseAmount: PositiveNumber;
  multiplier: number;
  bonusAmount: PositiveNumber;
  totalAmount: PositiveNumber;
  reason: string;
  metadata: {
    proximityScore: number;
    densityScore: number;
    qualityScore: number;
    distanceToCenter: number; // meters
    nearbyStations: number;
  };
  timestamp: Date;
  blockNumber?: number;
  transactionHash?: string;
}

interface ProximityAnalytics {
  totalZones: number;
  activeZones: number;
  totalStations: number;
  stationsInZones: number;
  totalRewardsDistributed: PositiveNumber;
  averageProximityScore: number;
  coverageGaps: {
    region: string;
    coordinates: {
      latitude: number;
      longitude: number;
    };
    priority: 'low' | 'medium' | 'high' | 'critical';
    suggestedReward: PositiveNumber;
  }[];
  topPerformingZones: {
    zoneId: string;
    name: string;
    stationCount: number;
    averageQuality: number;
    totalRewards: PositiveNumber;
  }[];
}

// Enhanced request interface
interface ProximityIncentiveRequest extends Request {
  storage?: {
    getAllZones: () => Promise<ProximityZone[]>;
    getZone: (id: string) => Promise<ProximityZone | null>;
    createZone: (zone: Partial<ProximityZone>) => Promise<ProximityZone>;
    updateZone: (
      id: string,
      updates: Partial<ProximityZone>
    ) => Promise<ProximityZone>;
    getAllStations: () => Promise<WeatherStation[]>;
    getStation: (id: string) => Promise<WeatherStation | null>;
    getStationsInZone: (zoneId: string) => Promise<WeatherStation[]>;
    getProximityRewards: (
      stationId?: string,
      zoneId?: string,
      limit?: number
    ) => Promise<ProximityReward[]>;
    createProximityReward: (
      reward: Partial<ProximityReward>
    ) => Promise<ProximityReward>;
    getProximityAnalytics: () => Promise<ProximityAnalytics>;
  };
  proximityService?: {
    calculateProximityScore: (
      stationId: string,
      zoneId: string
    ) => Promise<number>;
    calculateDensityBonus: (stationId: string) => Promise<number>;
    findOptimalZones: (coordinates: {
      latitude: number;
      longitude: number;
    }) => Promise<ProximityZone[]>;
    detectCoverageGaps: (region?: string) => Promise<any[]>;
    distributeProximityRewards: (zoneId: string) => Promise<boolean>;
  };
}

/**
 * Get all proximity zones
 */
export const getAllZones = async (
  req: ProximityIncentiveRequest,
  res: Response
): Promise<PaginatedResponse<ProximityZone>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const status = req.query.status as string;
    const incentiveType = req.query.incentiveType as string;

    let zones: ProximityZone[] = [];
    if (req.storage) {
      zones = await req.storage.getAllZones();
    } else {
      // Mock zones for development
      zones = [
        {
          id: 'zone_1',
          name: 'San Francisco Bay Area',
          description: 'High-density urban zone with weather coverage gaps',
          coordinates: {
            center: {
              latitude: 37.7749,
              longitude: -122.4194,
            },
            radius: 50000, // 50km
          },
          incentiveType: 'coverage_gap',
          multiplier: 1.5,
          requirements: {
            minStations: 5,
            maxStations: 50,
            dataTypes: ['temperature', 'humidity', 'pressure', 'air_quality'],
            updateFrequency: 15,
            qualityThreshold: 85,
          },
          rewards: {
            baseBonus: 0.05 as PositiveNumber,
            proximityBonus: 0.03 as PositiveNumber,
            densityBonus: 0.02 as PositiveNumber,
            qualityBonus: 0.01 as PositiveNumber,
          },
          status: 'active',
          validFrom: new Date('2024-01-01'),
          validUntil: new Date('2025-01-01'),
          createdAt: new Date('2023-12-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (status) {
      zones = zones.filter(zone => zone.status === status);
    }
    if (incentiveType) {
      zones = zones.filter(zone => zone.incentiveType === incentiveType);
    }

    // Sort by multiplier (highest first)
    zones.sort((a, b) => b.multiplier - a.multiplier);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedZones = zones.slice(startIndex, endIndex);
    const totalPages = Math.ceil(zones.length / limit);

    const response: PaginatedResponse<ProximityZone> = {
      success: true,
      data: paginatedZones,
      message: `Retrieved ${paginatedZones.length} proximity zones`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: zones.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in getAllZones', { module: 'ProximityIncentiveController', operation: 'getAllZones', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<ProximityZone> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve proximity zones',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create proximity zone
 */
export const createZone = async (
  req: ProximityIncentiveRequest,
  res: Response
): Promise<ControllerResponse<ProximityZone>> => {
  const requestId = uuidv4();

  try {
    const {
      name,
      description,
      coordinates,
      incentiveType,
      multiplier,
      requirements,
      rewards,
      validFrom,
      validUntil,
    } = req.body;

    // Validate required fields
    if (
      !name ||
      !coordinates ||
      !incentiveType ||
      !multiplier ||
      !requirements ||
      !rewards
    ) {
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Name, coordinates, incentive type, multiplier, requirements, and rewards are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate coordinates
    const { center, radius } = coordinates;
    if (!center || !radius) {
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Invalid coordinates',
        message:
          'Coordinates must include center (latitude, longitude) and radius',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (
      center.latitude < -90 ||
      center.latitude > 90 ||
      center.longitude < -180 ||
      center.longitude > 180
    ) {
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Invalid coordinates',
        message:
          'Latitude must be between -90 and 90, longitude between -180 and 180',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (radius <= 0 || radius > 1000000) {
      // Max 1000km radius
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Invalid radius',
        message: 'Radius must be between 1 and 1,000,000 meters',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate incentive type
    const validIncentiveTypes = [
      'weather_density',
      'coverage_gap',
      'high_value_area',
      'research_zone',
      'emergency_zone',
    ];
    if (!validIncentiveTypes.includes(incentiveType)) {
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Invalid incentive type',
        message: `Incentive type must be one of: ${validIncentiveTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate multiplier
    if (multiplier < 0.1 || multiplier > 10.0) {
      const errorResponse: ControllerResponse<ProximityZone> = {
        success: false,
        error: 'Invalid multiplier',
        message: 'Multiplier must be between 0.1 and 10.0',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create zone data
    const zoneData: Partial<ProximityZone> = {
      id: `zone_${uuidv4()}`,
      name,
      description: description || '',
      coordinates,
      incentiveType,
      multiplier,
      requirements,
      rewards,
      status: 'active',
      validFrom: validFrom ? new Date(validFrom) : new Date(),
      validUntil: validUntil
        ? new Date(validUntil)
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let zone: ProximityZone;
    if (req.storage) {
      zone = await req.storage.createZone(zoneData);
    } else {
      zone = zoneData as ProximityZone;
    }

    const response: ControllerResponse<ProximityZone> = {
      success: true,
      data: zone,
      message: 'Proximity zone created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in createZone', { module: 'ProximityIncentiveController', operation: 'createZone', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ProximityZone> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create proximity zone',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Calculate proximity rewards
 */
export const calculateProximityRewards = async (
  req: ProximityIncentiveRequest,
  res: Response
): Promise<ControllerResponse<ProximityReward[]>> => {
  const requestId = uuidv4();

  try {
    const zoneId = req.params.zoneId;

    if (!zoneId) {
      const errorResponse: ControllerResponse<ProximityReward[]> = {
        success: false,
        error: 'Zone ID is required',
        message: 'Please provide a valid zone ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get zone
    let zone: ProximityZone | null = null;
    if (req.storage) {
      zone = await req.storage.getZone(zoneId);
    }

    if (!zone) {
      const notFoundResponse: ControllerResponse<ProximityReward[]> = {
        success: false,
        error: 'Zone not found',
        message: `No zone found with ID ${zoneId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (zone.status !== 'active') {
      const errorResponse: ControllerResponse<ProximityReward[]> = {
        success: false,
        error: 'Zone not active',
        message: 'Cannot calculate rewards for inactive zones',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get stations in zone
    let stations: WeatherStation[] = [];
    if (req.storage) {
      stations = await req.storage.getStationsInZone(zoneId);
    } else {
      // Mock stations for development
      stations = [
        {
          id: 'station_1',
          stationId: 'sf_downtown_01',
          owner:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          name: 'San Francisco Downtown Weather Station',
          location: {
            latitude: 37.7849,
            longitude: -122.4094,
            elevation: 15,
            address: '123 Market St, San Francisco, CA',
          },
          equipment: {
            type: 'Professional',
            model: 'Davis Vantage Pro2',
            sensors: ['temperature', 'humidity', 'pressure', 'wind', 'rain'],
            calibration: new Date('2024-01-15'),
            accuracy: {
              temperature: 0.1,
              humidity: 2.0,
              pressure: 0.5,
            },
          },
          status: 'active',
          metrics: {
            uptime: 98.5,
            dataQuality: 92.3,
            updateFrequency: 10,
            totalSubmissions: 15420,
            rewardsEarned: 125.75 as PositiveNumber,
          },
          proximityZones: [zoneId],
          createdAt: new Date('2023-11-01'),
          updatedAt: new Date(),
        },
      ];
    }

    const rewards: ProximityReward[] = [];

    for (const station of stations) {
      // Calculate proximity score
      let proximityScore = 0.8; // Mock score
      let densityBonus = 0.2; // Mock density bonus

      if (req.proximityService) {
        proximityScore = await req.proximityService.calculateProximityScore(
          station.id,
          zoneId
        );
        densityBonus = await req.proximityService.calculateDensityBonus(
          station.id
        );
      }

      // Calculate reward amounts
      const baseAmount = zone.rewards.baseBonus;
      const proximityBonusAmount = zone.rewards.proximityBonus * proximityScore;
      const densityBonusAmount = zone.rewards.densityBonus * densityBonus;
      const qualityBonusAmount =
        zone.rewards.qualityBonus * (station.metrics.dataQuality / 100);

      const totalBonus =
        proximityBonusAmount + densityBonusAmount + qualityBonusAmount;
      const totalAmount = (baseAmount + totalBonus) * zone.multiplier;

      const reward: ProximityReward = {
        id: `reward_${uuidv4()}`,
        recipient: station.owner,
        stationId: station.id,
        zoneId: zoneId,
        rewardType: 'proximity',
        baseAmount,
        multiplier: zone.multiplier,
        bonusAmount: totalBonus as PositiveNumber,
        totalAmount: totalAmount as PositiveNumber,
        reason: `Proximity reward for station ${station.name} in zone ${zone.name}`,
        metadata: {
          proximityScore,
          densityScore: densityBonus,
          qualityScore: station.metrics.dataQuality,
          distanceToCenter: Math.random() * 1000, // Mock distance
          nearbyStations: stations.length - 1,
        },
        timestamp: new Date(),
      };

      rewards.push(reward);
    }

    // Store rewards if storage is available
    if (req.storage) {
      for (const reward of rewards) {
        await req.storage.createProximityReward(reward);
      }
    }

    const response: ControllerResponse<ProximityReward[]> = {
      success: true,
      data: rewards,
      message: `Calculated proximity rewards for ${rewards.length} stations`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in calculateProximityRewards', { module: 'ProximityIncentiveController', operation: 'calculateProximityRewards', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ProximityReward[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to calculate proximity rewards',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get proximity analytics
 */
export const getProximityAnalytics = async (
  req: ProximityIncentiveRequest,
  res: Response
): Promise<ControllerResponse<ProximityAnalytics>> => {
  const requestId = uuidv4();

  try {
    let analytics: ProximityAnalytics;
    if (req.storage) {
      analytics = await req.storage.getProximityAnalytics();
    } else {
      // Mock analytics for development
      analytics = {
        totalZones: 15,
        activeZones: 12,
        totalStations: 450,
        stationsInZones: 285,
        totalRewardsDistributed: 2450.75 as PositiveNumber,
        averageProximityScore: 0.73,
        coverageGaps: [
          {
            region: 'East Bay Hills',
            coordinates: {
              latitude: 37.8044,
              longitude: -122.2711,
            },
            priority: 'high',
            suggestedReward: 0.25 as PositiveNumber,
          },
        ],
        topPerformingZones: [
          {
            zoneId: 'zone_1',
            name: 'San Francisco Bay Area',
            stationCount: 35,
            averageQuality: 91.2,
            totalRewards: 685.5 as PositiveNumber,
          },
        ],
      };
    }

    const response: ControllerResponse<ProximityAnalytics> = {
      success: true,
      data: analytics,
      message: 'Proximity analytics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in getProximityAnalytics', { module: 'ProximityIncentiveController', operation: 'getProximityAnalytics', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ProximityAnalytics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve proximity analytics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Find optimal zones for location
 */
export const findOptimalZones = async (
  req: ProximityIncentiveRequest,
  res: Response
): Promise<ControllerResponse<ProximityZone[]>> => {
  const requestId = uuidv4();

  try {
    const { latitude, longitude } = req.body;

    // Validate coordinates
    if (!latitude || !longitude) {
      const errorResponse: ControllerResponse<ProximityZone[]> = {
        success: false,
        error: 'Missing coordinates',
        message: 'Latitude and longitude are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      const errorResponse: ControllerResponse<ProximityZone[]> = {
        success: false,
        error: 'Invalid coordinates',
        message:
          'Latitude must be between -90 and 90, longitude between -180 and 180',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let optimalZones: ProximityZone[] = [];
    if (req.proximityService) {
      optimalZones = await req.proximityService.findOptimalZones({
        latitude,
        longitude,
      });
    } else {
      // Mock optimal zones for development
      optimalZones = [
        {
          id: 'zone_1',
          name: 'San Francisco Bay Area',
          description: 'High-density urban zone with weather coverage gaps',
          coordinates: {
            center: {
              latitude: 37.7749,
              longitude: -122.4194,
            },
            radius: 50000,
          },
          incentiveType: 'coverage_gap',
          multiplier: 1.5,
          requirements: {
            minStations: 5,
            maxStations: 50,
            dataTypes: ['temperature', 'humidity', 'pressure'],
            updateFrequency: 15,
            qualityThreshold: 85,
          },
          rewards: {
            baseBonus: 0.05 as PositiveNumber,
            proximityBonus: 0.03 as PositiveNumber,
            densityBonus: 0.02 as PositiveNumber,
            qualityBonus: 0.01 as PositiveNumber,
          },
          status: 'active',
          validFrom: new Date('2024-01-01'),
          validUntil: new Date('2025-01-01'),
          createdAt: new Date('2023-12-01'),
          updatedAt: new Date(),
        },
      ];
    }

    const response: ControllerResponse<ProximityZone[]> = {
      success: true,
      data: optimalZones,
      message: `Found ${optimalZones.length} optimal zones for the specified location`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in findOptimalZones', { module: 'ProximityIncentiveController', operation: 'findOptimalZones', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ProximityZone[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to find optimal zones',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getAllZones,
  createZone,
  calculateProximityRewards,
  getProximityAnalytics,
  findOptimalZones,
};
