/**
 * Privacy Controller - TypeScript Implementation
 * Handles privacy settings, ZK proofs, and data protection with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { securityLogger } from '../utils/logger.js';

// ============ ZOD VALIDATION SCHEMAS ============

// Common validation schemas
const ethereumAddressSchema = z
  .string()
  .min(10, 'User ID is required')
  .max(128, 'User ID too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Schema for updating privacy settings
const updatePrivacySettingsSchema = z.object({
  dataSharing: z.boolean().optional(),
  analyticsOptOut: z.boolean().optional(),
  marketingOptOut: z.boolean().optional(),
  locationTracking: z.boolean().optional(),
  weatherDataSharing: z.boolean().optional(),
  zkProofsEnabled: z.boolean().optional(),
});

// Schema for ZK proof creation
const createZKProofSchema = z.object({
  type: z.enum(['weather', 'computation', 'identity']),
  publicInputs: z.array(z.string().max(1000)).min(1, 'At least one public input required'),
  proof: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/, 'Proof must be a valid hex string starting with 0x')
    .min(4, 'Proof too short')
    .max(10000, 'Proof too long'),
  verificationKey: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/, 'Verification key must be a valid hex string')
    .min(4, 'Verification key too short')
    .max(1000, 'Verification key too long'),
});

// Schema for ZK proofs query
const getZKProofsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  userId: ethereumAddressSchema.optional(),
  type: z.enum(['weather', 'computation', 'identity']).optional(),
});

// Schema for data deletion request
const dataDeletionSchema = z.object({
  dataTypes: z.array(z.string().max(100)).optional(),
  confirmDeletion: z.literal(true, {
    message: 'Deletion must be confirmed',
  }),
});
import {
  ControllerResponse,
  PrivacySettings,
  ZKProof,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import { EthereumAddress } from '../../shared/types/security-types.js';

// Enhanced request interface with privacy context
interface PrivacyRequest extends Request {
  storage?: {
    getPrivacySettings: (userId: string) => Promise<PrivacySettings | null>;
    updatePrivacySettings: (
      userId: string,
      settings: Partial<PrivacySettings>
    ) => Promise<PrivacySettings>;
    createZKProof: (proof: Partial<ZKProof>) => Promise<ZKProof>;
    getZKProofs: (userId?: string, type?: string) => Promise<ZKProof[]>;
    verifyZKProof: (proofId: string) => Promise<boolean>;
    deleteUserData: (userId: string, dataType?: string) => Promise<void>;
  };
}

// Privacy settings update interface
interface UpdatePrivacySettingsRequest {
  dataSharing?: boolean;
  analyticsOptOut?: boolean;
  marketingOptOut?: boolean;
  locationTracking?: boolean;
  weatherDataSharing?: boolean;
  zkProofsEnabled?: boolean;
}

// ZK proof creation interface
interface CreateZKProofRequest {
  type: 'weather' | 'computation' | 'identity';
  publicInputs: string[];
  proof: string;
  verificationKey: string;
}

// Data deletion request interface
interface DataDeletionRequest {
  dataTypes?: string[];
  confirmDeletion: boolean;
}

/**
 * Get privacy settings for user
 */
export const getPrivacySettings = async (
  req: PrivacyRequest,
  res: Response
): Promise<ControllerResponse<PrivacySettings>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for userId parameter
    const userIdResult = ethereumAddressSchema.safeParse(req.params.userId);
    if (!userIdResult.success) {
      const errorResponse: ControllerResponse<PrivacySettings> = {
        success: false,
        error: userIdResult.error.issues[0].message,
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const userId = userIdResult.data;

    let settings: PrivacySettings | null = null;
    if (req.storage) {
      settings = await req.storage.getPrivacySettings(userId);
    }

    // Create default settings if none exist
    if (!settings) {
      settings = {
        userId,
        dataSharing: false,
        analyticsOptOut: true,
        marketingOptOut: true,
        locationTracking: false,
        weatherDataSharing: true, // Enabled by default for weather platform
        zkProofsEnabled: true,
      };

      if (req.storage) {
        settings = await req.storage.updatePrivacySettings(userId, settings);
      }
    }

    const response: ControllerResponse<PrivacySettings> = {
      success: true,
      data: settings,
      message: 'Privacy settings retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to retrieve privacy settings', { module: 'PrivacyController', operation: 'getPrivacySettings', error: (error as Error).message });
    const errorResponse: ControllerResponse<PrivacySettings> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve privacy settings',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Update privacy settings for user
 */
export const updatePrivacySettings = async (
  req: PrivacyRequest,
  res: Response
): Promise<ControllerResponse<PrivacySettings>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for userId parameter
    const userIdResult = ethereumAddressSchema.safeParse(req.params.userId);
    if (!userIdResult.success) {
      const errorResponse: ControllerResponse<PrivacySettings> = {
        success: false,
        error: userIdResult.error.issues[0].message,
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const userId = userIdResult.data;

    // Zod validation for request body
    const updatesResult = updatePrivacySettingsSchema.safeParse(req.body);
    if (!updatesResult.success) {
      const errorResponse: ControllerResponse<PrivacySettings> = {
        success: false,
        error: updatesResult.error.issues[0].message,
        message: 'Invalid privacy settings data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const updates = updatesResult.data;

    let updatedSettings: PrivacySettings;
    if (req.storage) {
      updatedSettings = await req.storage.updatePrivacySettings(
        userId,
        updates
      );
    } else {
      // Mock response for development
      updatedSettings = {
        userId,
        dataSharing: updates.dataSharing ?? false,
        analyticsOptOut: updates.analyticsOptOut ?? true,
        marketingOptOut: updates.marketingOptOut ?? true,
        locationTracking: updates.locationTracking ?? false,
        weatherDataSharing: updates.weatherDataSharing ?? true,
        zkProofsEnabled: updates.zkProofsEnabled ?? true,
      };
    }

    const response: ControllerResponse<PrivacySettings> = {
      success: true,
      data: updatedSettings,
      message: 'Privacy settings updated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to update privacy settings', { module: 'PrivacyController', operation: 'updatePrivacySettings', error: (error as Error).message });
    const errorResponse: ControllerResponse<PrivacySettings> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update privacy settings',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create ZK proof for privacy-preserving operations
 */
export const createZKProof = async (
  req: PrivacyRequest,
  res: Response
): Promise<ControllerResponse<ZKProof>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for ZK proof creation
    const validationResult = createZKProofSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<ZKProof> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid ZK proof data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { type, publicInputs, proof, verificationKey } =
      validationResult.data;

    // Create ZK proof data
    const zkProofData: Partial<ZKProof> = {
      id: `zkproof_${uuidv4()}`,
      type,
      proof,
      publicInputs,
      timestamp: new Date(),
      isValid: true, // Will be verified separately
      verificationKey,
    };

    let zkProof: ZKProof;
    if (req.storage) {
      zkProof = await req.storage.createZKProof(zkProofData);
    } else {
      zkProof = zkProofData as ZKProof;
    }

    const response: ControllerResponse<ZKProof> = {
      success: true,
      data: zkProof,
      message: 'ZK proof created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to create ZK proof', { module: 'PrivacyController', operation: 'createZKProof', error: (error as Error).message });
    const errorResponse: ControllerResponse<ZKProof> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create ZK proof',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get ZK proofs with filtering
 */
export const getZKProofs = async (
  req: PrivacyRequest,
  res: Response
): Promise<PaginatedResponse<ZKProof>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for query parameters
    const validationResult = getZKProofsQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<ZKProof> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
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
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { page, limit, userId, type } = validationResult.data;

    let proofs: ZKProof[] = [];
    if (req.storage) {
      proofs = await req.storage.getZKProofs(userId, type);
    } else {
      // Mock ZK proofs for development
      proofs = [
        {
          id: 'zkproof_1',
          type: 'weather',
          proof: '0x1234567890abcdef',
          publicInputs: ['temp:25.5', 'humidity:60'],
          timestamp: new Date(),
          isValid: true,
          verificationKey: '0xabcdef1234567890',
        },
        {
          id: 'zkproof_2',
          type: 'computation',
          proof: '0xfedcba0987654321',
          publicInputs: ['result:true', 'computation_time:150ms'],
          timestamp: new Date(),
          isValid: true,
          verificationKey: '0x0987654321fedcba',
        },
      ];
    }

    // Sort by timestamp (most recent first)
    const sortedProofs = proofs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Implement pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedProofs = sortedProofs.slice(startIndex, endIndex);
    const totalPages = Math.ceil(sortedProofs.length / limit);

    const response: PaginatedResponse<ZKProof> = {
      success: true,
      data: paginatedProofs,
      message: `Retrieved ${paginatedProofs.length} ZK proofs`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: sortedProofs.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to retrieve ZK proofs', { module: 'PrivacyController', operation: 'getZKProofs', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ZKProof> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve ZK proofs',
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
 * Verify ZK proof
 */
export const verifyZKProof = async (
  req: PrivacyRequest,
  res: Response
): Promise<ControllerResponse<{ isValid: boolean }>> => {
  const requestId = uuidv4();

  try {
    const proofId = req.params.proofId;

    if (!proofId) {
      const errorResponse: ControllerResponse<{ isValid: boolean }> = {
        success: false,
        error: 'Proof ID is required',
        message: 'Please provide a valid proof ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let isValid = false;
    if (req.storage) {
      isValid = await req.storage.verifyZKProof(proofId);
    } else {
      // Mock verification for development
      isValid = true;
    }

    const response: ControllerResponse<{ isValid: boolean }> = {
      success: true,
      data: { isValid },
      message: `ZK proof verification ${isValid ? 'successful' : 'failed'}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to verify ZK proof', { module: 'PrivacyController', operation: 'verifyZKProof', error: (error as Error).message });
    const errorResponse: ControllerResponse<{ isValid: boolean }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to verify ZK proof',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Delete user data (GDPR compliance)
 */
export const deleteUserData = async (
  req: PrivacyRequest,
  res: Response
): Promise<ControllerResponse<{ deleted: boolean }>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for userId parameter
    const userIdResult = ethereumAddressSchema.safeParse(req.params.userId);
    if (!userIdResult.success) {
      const errorResponse: ControllerResponse<{ deleted: boolean }> = {
        success: false,
        error: userIdResult.error.issues[0].message,
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const userId = userIdResult.data;

    // Zod validation for deletion request body
    const deletionResult = dataDeletionSchema.safeParse(req.body);
    if (!deletionResult.success) {
      const errorResponse: ControllerResponse<{ deleted: boolean }> = {
        success: false,
        error: deletionResult.error.issues[0].message,
        message: 'Invalid deletion request',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { dataTypes } = deletionResult.data;

    // Delete user data based on specified types
    if (req.storage) {
      if (dataTypes && dataTypes.length > 0) {
        for (const dataType of dataTypes) {
          await req.storage.deleteUserData(userId, dataType);
        }
      } else {
        // Delete all user data
        await req.storage.deleteUserData(userId);
      }
    }

    securityLogger.info('User data deletion completed', { module: 'PrivacyController', operation: 'deleteUserData', userId, dataTypes: dataTypes?.join(', ') || 'all' });

    const response: ControllerResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
      message: 'User data deleted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Failed to delete user data', { module: 'PrivacyController', operation: 'deleteUserData', error: (error as Error).message });
    const errorResponse: ControllerResponse<{ deleted: boolean }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to delete user data',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getPrivacySettings,
  updatePrivacySettings,
  createZKProof,
  getZKProofs,
  verifyZKProof,
  deleteUserData,
};
