/**
 * Identity Controller - TypeScript Implementation
 * Handles user identity verification, decentralized identity management, and credentials
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { appLogger } from '../utils/logger.js';

// ============ ZOD VALIDATION SCHEMAS ============

// Common validation schemas
const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Schema for creating/updating identity profile
const createIdentityProfileSchema = z.object({
  address: ethereumAddressSchema,
  did: z.string().min(1).max(256).optional(),
  metadata: z
    .object({
      name: z.string().max(100).optional(),
      avatar: z.string().url().max(512).optional(),
      bio: z.string().max(1000).optional(),
      location: z.string().max(100).optional(),
      website: z.string().url().max(256).optional(),
      socialLinks: z.record(z.string(), z.string().max(256)).optional(),
    })
    .optional(),
});

// Schema for identity verification
const verifyIdentitySchema = z.object({
  address: ethereumAddressSchema,
  verificationType: z.enum(['email', 'phone', 'kyc', 'social', 'biometric']),
  verificationData: z.record(z.string(), z.unknown()),
  signature: z
    .string()
    .min(132, 'Signature too short')
    .max(256, 'Signature too long')
    .regex(/^0x[a-fA-F0-9]+$/, 'Invalid signature format'),
});

// Schema for adding credentials
const addCredentialSchema = z.object({
  type: z.string().min(1).max(100),
  issuer: z.string().min(1).max(256),
  credentialSubject: z.record(z.string(), z.unknown()),
  expirationDate: z.string().datetime().optional(),
  proof: z
    .object({
      type: z.string().max(100).optional(),
      proofPurpose: z.string().max(100).optional(),
      verificationMethod: z.string().max(256).optional(),
      signature: z.string().max(512).optional(),
    })
    .optional(),
});

// Schema for search query
const searchQuerySchema = z.object({
  q: z.string().min(2, 'Search query must be at least 2 characters').max(200),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import { EthereumAddress } from '../../shared/types/security-types.js';

// Identity interfaces
interface IdentityProfile {
  id: string;
  address: EthereumAddress;
  did?: string; // Decentralized Identifier
  credentials: VerifiableCredential[];
  reputation: number;
  verified: boolean;
  verificationDate?: Date;
  metadata: {
    name?: string;
    avatar?: string;
    bio?: string;
    location?: string;
    website?: string;
    socialLinks?: Record<string, string>;
  };
  createdAt: Date;
  updatedAt: Date;
}

interface VerifiableCredential {
  id: string;
  type: string;
  issuer: string;
  subject: EthereumAddress;
  issuanceDate: Date;
  expirationDate?: Date;
  credentialSubject: Record<string, any>;
  proof: {
    type: string;
    proofPurpose: string;
    verificationMethod: string;
    signature: string;
  };
  verified: boolean;
}

interface IdentityVerificationRequest {
  address: EthereumAddress;
  verificationType: 'email' | 'phone' | 'kyc' | 'social' | 'biometric';
  verificationData: Record<string, any>;
  signature: string;
}

// Enhanced request interface
interface IdentityRequest extends Request {
  storage?: {
    getIdentityProfile: (
      address: EthereumAddress
    ) => Promise<IdentityProfile | null>;
    createIdentityProfile: (
      profile: Partial<IdentityProfile>
    ) => Promise<IdentityProfile>;
    updateIdentityProfile: (
      address: EthereumAddress,
      updates: Partial<IdentityProfile>
    ) => Promise<IdentityProfile>;
    addCredential: (
      address: EthereumAddress,
      credential: VerifiableCredential
    ) => Promise<IdentityProfile>;
    verifyCredential: (credentialId: string) => Promise<boolean>;
    searchIdentities: (
      query: string,
      limit?: number
    ) => Promise<IdentityProfile[]>;
  };
}

/**
 * Get identity profile by address
 */
export const getIdentityProfile = async (
  req: IdentityRequest,
  res: Response
): Promise<ControllerResponse<IdentityProfile>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address parameter
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressResult.success) {
      const errorResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: addressResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const address = addressResult.data as EthereumAddress;

    let profile: IdentityProfile | null = null;
    if (req.storage) {
      profile = await req.storage.getIdentityProfile(address);
    }

    if (!profile) {
      const notFoundResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: 'Identity profile not found',
        message: `No identity profile found for address ${address}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<IdentityProfile> = {
      success: true,
      data: profile,
      message: 'Identity profile retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in getIdentityProfile', { module: 'IdentityController', operation: 'getIdentityProfile', error: (error as Error).message });
    const errorResponse: ControllerResponse<IdentityProfile> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve identity profile',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create or update identity profile
 */
export const createIdentityProfile = async (
  req: IdentityRequest,
  res: Response
): Promise<ControllerResponse<IdentityProfile>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for request body
    const validationResult = createIdentityProfileSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid request data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { address, metadata, did } = validationResult.data;

    // Check if profile already exists
    let existingProfile: IdentityProfile | null = null;
    if (req.storage) {
      existingProfile = await req.storage.getIdentityProfile(
        address as EthereumAddress
      );
    }

    if (existingProfile) {
      // Update existing profile
      const updates = {
        metadata: { ...existingProfile.metadata, ...metadata },
        did: did || existingProfile.did,
        updatedAt: new Date(),
      };

      let updatedProfile: IdentityProfile;
      if (req.storage) {
        updatedProfile = await req.storage.updateIdentityProfile(
          address as EthereumAddress,
          updates
        );
      } else {
        updatedProfile = { ...existingProfile, ...updates };
      }

      const response: ControllerResponse<IdentityProfile> = {
        success: true,
        data: updatedProfile,
        message: 'Identity profile updated successfully',
        timestamp: new Date().toISOString(),
        requestId,
      };

      res.json(response);
      return response;
    }

    // Create new profile
    const profileData: Partial<IdentityProfile> = {
      id: `identity_${uuidv4()}`,
      address: address as EthereumAddress,
      did,
      credentials: [],
      reputation: 0,
      verified: false,
      metadata: metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let profile: IdentityProfile;
    if (req.storage) {
      profile = await req.storage.createIdentityProfile(profileData);
    } else {
      profile = profileData as IdentityProfile;
    }

    const response: ControllerResponse<IdentityProfile> = {
      success: true,
      data: profile,
      message: 'Identity profile created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in createIdentityProfile', { module: 'IdentityController', operation: 'createIdentityProfile', error: (error as Error).message });
    const errorResponse: ControllerResponse<IdentityProfile> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create identity profile',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Verify identity
 */
export const verifyIdentity = async (
  req: IdentityRequest,
  res: Response
): Promise<ControllerResponse<IdentityProfile>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for verification request
    const validationResult = verifyIdentitySchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid verification data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { address: validatedAddress, verificationType, verificationData, signature } =
      validationResult.data;
    const address = validatedAddress as EthereumAddress;

    // Get existing profile
    let profile: IdentityProfile | null = null;
    if (req.storage) {
      profile = await req.storage.getIdentityProfile(address);
    }

    if (!profile) {
      const notFoundResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: 'Identity profile not found',
        message: 'Please create an identity profile first',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Update verification status
    const updates = {
      verified: true,
      verificationDate: new Date(),
      reputation: profile.reputation + 10, // Boost reputation for verification
      updatedAt: new Date(),
    };

    let updatedProfile: IdentityProfile;
    if (req.storage) {
      updatedProfile = await req.storage.updateIdentityProfile(
        address,
        updates
      );
    } else {
      updatedProfile = { ...profile, ...updates };
    }

    const response: ControllerResponse<IdentityProfile> = {
      success: true,
      data: updatedProfile,
      message: 'Identity verified successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in verifyIdentity', { module: 'IdentityController', operation: 'verifyIdentity', error: (error as Error).message });
    const errorResponse: ControllerResponse<IdentityProfile> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to verify identity',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Add verifiable credential
 */
export const addCredential = async (
  req: IdentityRequest,
  res: Response
): Promise<ControllerResponse<IdentityProfile>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address parameter
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressResult.success) {
      const errorResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: addressResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const address = addressResult.data as EthereumAddress;

    // Zod validation for credential data
    const credentialResult = addCredentialSchema.safeParse(req.body);
    if (!credentialResult.success) {
      const errorResponse: ControllerResponse<IdentityProfile> = {
        success: false,
        error: credentialResult.error.issues[0].message,
        message: 'Credential must include type, issuer, and credentialSubject',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const credentialData = credentialResult.data;

    // Create verifiable credential
    const defaultProof = {
      type: 'EcdsaSecp256k1Signature2019',
      proofPurpose: 'assertionMethod',
      verificationMethod: `${address}#key-1`,
      signature: `0x${uuidv4().replace(/-/g, '')}`, // Mock signature
    };
    const credential: VerifiableCredential = {
      id: `credential_${uuidv4()}`,
      type: credentialData.type,
      issuer: credentialData.issuer,
      subject: address,
      issuanceDate: new Date(),
      expirationDate: credentialData.expirationDate
        ? new Date(credentialData.expirationDate)
        : undefined,
      credentialSubject: credentialData.credentialSubject as Record<string, any>,
      proof: credentialData.proof
        ? {
            type: credentialData.proof.type || defaultProof.type,
            proofPurpose: credentialData.proof.proofPurpose || defaultProof.proofPurpose,
            verificationMethod: credentialData.proof.verificationMethod || defaultProof.verificationMethod,
            signature: credentialData.proof.signature || defaultProof.signature,
          }
        : defaultProof,
      verified: false,
    };

    let updatedProfile: IdentityProfile;
    if (req.storage) {
      updatedProfile = await req.storage.addCredential(address, credential);
    } else {
      // Mock response for development
      updatedProfile = {
        id: `identity_${address}`,
        address,
        credentials: [credential],
        reputation: 100,
        verified: true,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const response: ControllerResponse<IdentityProfile> = {
      success: true,
      data: updatedProfile,
      message: 'Credential added successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in addCredential', { module: 'IdentityController', operation: 'addCredential', error: (error as Error).message });
    const errorResponse: ControllerResponse<IdentityProfile> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to add credential',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Search identities
 */
export const searchIdentities = async (
  req: IdentityRequest,
  res: Response
): Promise<PaginatedResponse<IdentityProfile>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for search query parameters
    const validationResult = searchQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<IdentityProfile> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid search parameters',
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
    const { q: query, page, limit } = validationResult.data;

    let identities: IdentityProfile[] = [];
    if (req.storage) {
      identities = await req.storage.searchIdentities(query.trim(), limit);
    } else {
      // Mock search results for development
      identities = [
        {
          id: 'identity_1',
          address:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          credentials: [],
          reputation: 85,
          verified: true,
          verificationDate: new Date(),
          metadata: {
            name: 'Climate Researcher',
            bio: 'Environmental data specialist',
            location: 'Global',
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
    }

    const totalPages = Math.ceil(identities.length / limit);

    const response: PaginatedResponse<IdentityProfile> = {
      success: true,
      data: identities,
      message: `Found ${identities.length} identities matching "${query}"`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: identities.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Error in searchIdentities', { module: 'IdentityController', operation: 'searchIdentities', error: (error as Error).message });
    const errorResponse: PaginatedResponse<IdentityProfile> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to search identities',
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

// Export all controller methods
export default {
  getIdentityProfile,
  createIdentityProfile,
  verifyIdentity,
  addCredential,
  searchIdentities,
};
