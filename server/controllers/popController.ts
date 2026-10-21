/**
 * Proof of Publishing (PoP) Controller - TypeScript Implementation
 * Handles Proof of Publishing consensus mechanism and environmental data validation
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

// Proof of Publishing interfaces
interface EnvironmentalDataSubmission {
  id: string;
  submissionId: string;
  submitter: EthereumAddress;
  dataType:
    | 'weather'
    | 'air_quality'
    | 'water_quality'
    | 'soil'
    | 'biodiversity'
    | 'climate';
  location: {
    latitude: number;
    longitude: number;
    region: string;
    country: string;
    elevation?: number;
  };
  data: {
    measurements: Record<string, number>;
    units: Record<string, string>;
    methodology: string;
    equipment: string[];
    calibration?: Date;
  };
  metadata: {
    timestamp: Date;
    duration: number; // measurement period in minutes
    sampleSize: number;
    confidence: number; // percentage
    source: string;
  };
  validation: {
    state: 'pending' | 'validated' | 'rejected' | 'disputed';
    score: number; // 0-100
    attestations: number;
    requiredAttestations: number;
  };
  rewards: {
    baseReward: PositiveNumber;
    qualityBonus: PositiveNumber;
    consensusBonus: PositiveNumber;
    total: PositiveNumber;
  };
  submittedAt: Date;
  validatedAt?: Date;
}

interface DataValidationAttestation {
  id: string;
  submissionId: string;
  validator: EthereumAddress;
  decision: 'accept' | 'reject' | 'needs_review';
  confidence: number; // percentage
  reasoning: string;
  metrics: {
    dataQuality: number; // 0-100
    methodologyScore: number; // 0-100
    locationAccuracy: number; // 0-100
    temporalConsistency: number; // 0-100
  };
  weight: number; // validator reputation weight
  timestamp: Date;
}

interface PopReward {
  id: string;
  recipient: EthereumAddress;
  submissionId: string;
  type:
    | 'data_submission'
    | 'validation'
    | 'consensus_participation'
    | 'quality_bonus';
  amount: PositiveNumber;
  multiplier: number;
  reason: string;
  blockNumber?: number;
  transactionHash?: string;
  distributedAt: Date;
}

interface ConsensusMetrics {
  totalSubmissions: number;
  validatedSubmissions: number;
  rejectedSubmissions: number;
  averageValidationTime: number; // hours
  averageScore: number; // 0-100
  participantCount: number;
  totalRewardsDistributed: PositiveNumber;
  qualityTrend: number; // percentage change
}

interface RegionStats {
  region: string;
  country: string;
  submissionCount: number;
  averageQuality: number;
  topDataTypes: string[];
  activeSubmitters: number;
  lastActivity: Date;
}

// Enhanced request interface
interface PopRequest extends Request {
  storage?: {
    submitEnvironmentalData: (
      data: Partial<EnvironmentalDataSubmission>
    ) => Promise<EnvironmentalDataSubmission>;
    getSubmissionById: (
      id: string
    ) => Promise<EnvironmentalDataSubmission | null>;
    getRecentSubmissions: (
      limit?: number,
      dataType?: string
    ) => Promise<EnvironmentalDataSubmission[]>;
    submitAttestation: (
      attestation: Partial<DataValidationAttestation>
    ) => Promise<DataValidationAttestation>;
    getAttestationsForSubmission: (
      submissionId: string
    ) => Promise<DataValidationAttestation[]>;
    validateSubmission: (submissionId: string) => Promise<boolean>;
    getPopRewards: (
      recipient?: EthereumAddress,
      limit?: number
    ) => Promise<PopReward[]>;
    createPopReward: (reward: Partial<PopReward>) => Promise<PopReward>;
    getConsensusMetrics: () => Promise<ConsensusMetrics>;
    getRegionStats: (limit?: number) => Promise<RegionStats[]>;
  };
  popService?: {
    validateData: (submission: EnvironmentalDataSubmission) => Promise<number>;
    calculateRewards: (submission: EnvironmentalDataSubmission) => Promise<any>;
    processConsensus: (submissionId: string) => Promise<boolean>;
    distributeRewards: (submissionId: string) => Promise<boolean>;
  };
}

/**
 * Submit environmental data
 */
export const submitEnvironmentalData = async (
  req: PopRequest,
  res: Response
): Promise<ControllerResponse<EnvironmentalDataSubmission>> => {
  const requestId = uuidv4();

  try {
    const { submitter, dataType, location, data, metadata } = req.body;

    // Validate required fields
    if (!submitter || !dataType || !location || !data || !metadata) {
      const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Submitter, data type, location, data, and metadata are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate submitter address
    if (!submitter.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
        success: false,
        error: 'Invalid submitter address',
        message: 'Submitter must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate data type
    const validDataTypes = [
      'weather',
      'air_quality',
      'water_quality',
      'soil',
      'biodiversity',
      'climate',
    ];
    if (!validDataTypes.includes(dataType)) {
      const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
        success: false,
        error: 'Invalid data type',
        message: `Data type must be one of: ${validDataTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate location coordinates
    const { latitude, longitude } = location;
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
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

    // Validate data structure
    if (!data.measurements || !data.methodology || !data.equipment) {
      const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
        success: false,
        error: 'Invalid data structure',
        message: 'Data must include measurements, methodology, and equipment',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Calculate required attestations based on data value
    const dataValue = Object.keys(data.measurements).length;
    const requiredAttestations = Math.min(
      Math.max(Math.ceil(dataValue / 5), 3),
      10
    );

    // Create submission data
    const submissionData: Partial<EnvironmentalDataSubmission> = {
      id: `submission_${uuidv4()}`,
      submissionId: `pop_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      submitter: submitter as EthereumAddress,
      dataType,
      location,
      data: {
        ...data,
        units: data.units || {},
      },
      metadata: {
        ...metadata,
        timestamp: metadata.timestamp
          ? new Date(metadata.timestamp)
          : new Date(),
      },
      validation: {
        state: 'pending',
        score: 0,
        attestations: 0,
        requiredAttestations,
      },
      rewards: {
        baseReward: 0.1 as PositiveNumber,
        qualityBonus: 0 as PositiveNumber,
        consensusBonus: 0 as PositiveNumber,
        total: 0 as PositiveNumber,
      },
      submittedAt: new Date(),
    };

    let submission: EnvironmentalDataSubmission;
    if (req.storage) {
      submission = await req.storage.submitEnvironmentalData(submissionData);
    } else {
      submission = submissionData as EnvironmentalDataSubmission;
    }

    // Perform initial validation if service is available
    if (req.popService) {
      const initialScore = await req.popService.validateData(submission);
      submission.validation.score = initialScore;

      // Calculate potential rewards
      const rewardCalc = await req.popService.calculateRewards(submission);
      submission.rewards = rewardCalc;
    }

    const response: ControllerResponse<EnvironmentalDataSubmission> = {
      success: true,
      data: submission,
      message: 'Environmental data submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in submitEnvironmentalData', { module: 'PopController', operation: 'submitEnvironmentalData', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<EnvironmentalDataSubmission> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit environmental data',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit validation attestation
 */
export const submitAttestation = async (
  req: PopRequest,
  res: Response
): Promise<ControllerResponse<DataValidationAttestation>> => {
  const requestId = uuidv4();

  try {
    const {
      submissionId,
      validator,
      decision,
      confidence,
      reasoning,
      metrics,
    } = req.body;

    // Validate required fields
    if (!submissionId || !validator || !decision || !reasoning) {
      const errorResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Missing required fields',
        message:
          'Submission ID, validator, decision, and reasoning are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate validator address
    if (!validator.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Invalid validator address',
        message: 'Validator must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate decision
    const validDecisions = ['accept', 'reject', 'needs_review'];
    if (!validDecisions.includes(decision)) {
      const errorResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Invalid decision',
        message: `Decision must be one of: ${validDecisions.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Get submission
    let submission: EnvironmentalDataSubmission | null = null;
    if (req.storage) {
      submission = await req.storage.getSubmissionById(submissionId);
    }

    if (!submission) {
      const notFoundResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Submission not found',
        message: `No submission found with ID ${submissionId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (submission.validation.state !== 'pending') {
      const errorResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Submission not pending',
        message: 'Can only attest to pending submissions',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Check if validator has already attested
    let existingAttestations: DataValidationAttestation[] = [];
    if (req.storage) {
      existingAttestations =
        await req.storage.getAttestationsForSubmission(submissionId);
    }

    const hasAttested = existingAttestations.some(
      att => att.validator === validator
    );
    if (hasAttested) {
      const errorResponse: ControllerResponse<DataValidationAttestation> = {
        success: false,
        error: 'Already attested',
        message:
          'Validator has already submitted an attestation for this submission',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(409).json(errorResponse);
      return errorResponse;
    }

    // Create attestation data
    const attestationData: Partial<DataValidationAttestation> = {
      id: `attestation_${uuidv4()}`,
      submissionId,
      validator: validator as EthereumAddress,
      decision,
      confidence: confidence || 85,
      reasoning,
      metrics: metrics || {
        dataQuality: 85,
        methodologyScore: 80,
        locationAccuracy: 90,
        temporalConsistency: 85,
      },
      weight: 1, // Base weight, could be adjusted based on validator reputation
      timestamp: new Date(),
    };

    let attestation: DataValidationAttestation;
    if (req.storage) {
      attestation = await req.storage.submitAttestation(attestationData);
    } else {
      attestation = attestationData as DataValidationAttestation;
    }

    // Update submission validation state
    const newAttestationCount = existingAttestations.length + 1;
    if (newAttestationCount >= submission.validation.requiredAttestations) {
      // Check if consensus is reached
      if (req.popService) {
        const consensusReached =
          await req.popService.processConsensus(submissionId);
        if (consensusReached) {
          // Distribute rewards
          await req.popService.distributeRewards(submissionId);
        }
      }
    }

    const response: ControllerResponse<DataValidationAttestation> = {
      success: true,
      data: attestation,
      message: 'Validation attestation submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in submitAttestation', { module: 'PopController', operation: 'submitAttestation', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<DataValidationAttestation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit attestation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get recent submissions
 */
export const getRecentSubmissions = async (
  req: PopRequest,
  res: Response
): Promise<PaginatedResponse<EnvironmentalDataSubmission>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const dataType = req.query.dataType as string;
    const state = req.query.state as string;

    let submissions: EnvironmentalDataSubmission[] = [];
    if (req.storage) {
      submissions = await req.storage.getRecentSubmissions(limit, dataType);
    } else {
      // Mock submissions for development
      submissions = [
        {
          id: 'submission_1',
          submissionId: 'pop_1234567890_abc123',
          submitter:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          dataType: 'weather',
          location: {
            latitude: 40.7128,
            longitude: -74.006,
            region: 'New York',
            country: 'United States',
            elevation: 10,
          },
          data: {
            measurements: {
              temperature: 22.5,
              humidity: 65,
              pressure: 1013.25,
              windSpeed: 5.2,
            },
            units: {
              temperature: 'celsius',
              humidity: 'percent',
              pressure: 'hPa',
              windSpeed: 'm/s',
            },
            methodology: 'Automated weather station with calibrated sensors',
            equipment: ['Davis Vantage Pro2', 'Temperature/Humidity Sensor'],
            calibration: new Date('2024-01-15'),
          },
          metadata: {
            timestamp: new Date(Date.now() - 3600000),
            duration: 60,
            sampleSize: 1,
            confidence: 95,
            source: 'Weather Station Network',
          },
          validation: {
            state: 'validated',
            score: 92,
            attestations: 5,
            requiredAttestations: 3,
          },
          rewards: {
            baseReward: 0.1 as PositiveNumber,
            qualityBonus: 0.05 as PositiveNumber,
            consensusBonus: 0.02 as PositiveNumber,
            total: 0.17 as PositiveNumber,
          },
          submittedAt: new Date(Date.now() - 3600000),
          validatedAt: new Date(Date.now() - 1800000),
        },
      ];
    }

    // Filter by state if provided
    if (state) {
      submissions = submissions.filter(sub => sub.validation.state === state);
    }

    // Sort by submission date (most recent first)
    submissions.sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedSubmissions = submissions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(submissions.length / limit);

    const response: PaginatedResponse<EnvironmentalDataSubmission> = {
      success: true,
      data: paginatedSubmissions,
      message: `Retrieved ${paginatedSubmissions.length} environmental data submissions`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: submissions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in getRecentSubmissions', { module: 'PopController', operation: 'getRecentSubmissions', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<EnvironmentalDataSubmission> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve submissions',
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
 * Get consensus metrics
 */
export const getConsensusMetrics = async (
  req: PopRequest,
  res: Response
): Promise<ControllerResponse<ConsensusMetrics>> => {
  const requestId = uuidv4();

  try {
    let metrics: ConsensusMetrics;
    if (req.storage) {
      metrics = await req.storage.getConsensusMetrics();
    } else {
      // Mock metrics for development
      metrics = {
        totalSubmissions: 1250,
        validatedSubmissions: 1125,
        rejectedSubmissions: 75,
        averageValidationTime: 4.2,
        averageScore: 87.5,
        participantCount: 245,
        totalRewardsDistributed: 425.75 as PositiveNumber,
        qualityTrend: 3.2,
      };
    }

    const response: ControllerResponse<ConsensusMetrics> = {
      success: true,
      data: metrics,
      message: 'Consensus metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in getConsensusMetrics', { module: 'PopController', operation: 'getConsensusMetrics', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ConsensusMetrics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve consensus metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get region statistics
 */
export const getRegionStats = async (
  req: PopRequest,
  res: Response
): Promise<ControllerResponse<RegionStats[]>> => {
  const requestId = uuidv4();

  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);

    let stats: RegionStats[] = [];
    if (req.storage) {
      stats = await req.storage.getRegionStats(limit);
    } else {
      // Mock regional stats for development
      stats = [
        {
          region: 'North America',
          country: 'United States',
          submissionCount: 450,
          averageQuality: 89.2,
          topDataTypes: ['weather', 'air_quality', 'water_quality'],
          activeSubmitters: 125,
          lastActivity: new Date(),
        },
        {
          region: 'Europe',
          country: 'Germany',
          submissionCount: 320,
          averageQuality: 91.5,
          topDataTypes: ['air_quality', 'weather', 'soil'],
          activeSubmitters: 95,
          lastActivity: new Date(Date.now() - 3600000),
        },
      ];
    }

    const response: ControllerResponse<RegionStats[]> = {
      success: true,
      data: stats,
      message: `Retrieved statistics for ${stats.length} regions`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    iotLogger.error('Error in getRegionStats', { module: 'PopController', operation: 'getRegionStats', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<RegionStats[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve region statistics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  submitEnvironmentalData,
  submitAttestation,
  getRecentSubmissions,
  getConsensusMetrics,
  getRegionStats,
};
