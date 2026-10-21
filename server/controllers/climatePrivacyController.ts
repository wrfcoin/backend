import { Request, Response } from 'express';
import { eq, and, desc, gte, lte, SQL } from 'drizzle-orm';
import { db } from '../../database/db.js';
import createLogger from '../utils/logger.js';
const privacyLogger = createLogger('privacy');
import {
  privateWeatherData,
  privateClimateTransactions,
  privateCarbonCredits,
  privateClimateFunds,
  climateStealthAddressRegistry,
  climatePrivacyKeys,
  climateTransactionAuditLog,
  CLIMATE_PRIVACY_LEVELS,
  CLIMATE_STEALTH_ADDRESS_TYPES,
} from '../../shared/schema-climate-privacy.js';
import { weatherData, transactions } from '../../shared/schema.js';
import { z } from 'zod';
import crypto from 'crypto';
import { createHash } from 'crypto';

// Zod schemas for climate privacy validation
const privacyLevelSchema = z.enum(['basic', 'enhanced', 'maximum', 'selective_disclosure']);
const addressTypeSchema = z.enum([
  'weather_data_reward',
  'carbon_credit_transfer',
  'climate_fund_disbursement',
  'data_validation_payment',
  'sensor_owner_payment',
]);

const stealthAddressObjectSchema = z.object({
  publicSpendKey: z.string().min(1),
  publicViewKey: z.string().min(1),
  oneTimePublicKey: z.string().optional(),
  transactionKey: z.string().optional(),
});

const privateWeatherDataSchema = z.object({
  weatherData: z.record(z.string(), z.any()),
  rewardStealthAddress: stealthAddressObjectSchema,
  sensorOwnerStealthAddress: stealthAddressObjectSchema.optional(),
  privacyLevel: privacyLevelSchema,
  addressType: addressTypeSchema,
  dataType: z.string().max(50).optional(),
  regionCode: z.string().max(10).optional(),
  complianceFlags: z.array(z.string()).optional(),
  encryptedSensorData: z.string().optional(),
  encryptedPayload: z.string().optional(),
  validityProof: z.string().optional(),
  rangeProof: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const privateCarbonCreditSchema = z.object({
  projectId: z.string().min(1).max(100),
  vintageYear: z.number().int().min(2000).max(2100),
  creditType: z.string().max(50).optional(),
  buyerStealthAddress: stealthAddressObjectSchema,
  sellerStealthAddress: stealthAddressObjectSchema,
  privacyLevel: privacyLevelSchema,
  confidentialCreditAmount: z.record(z.string(), z.any()).optional(),
  encryptedAmount: z.string().optional(),
  rangeProof: z.string().optional(),
  registryData: z.record(z.string(), z.any()).optional(),
  complianceFlags: z.array(z.string()).optional(),
  verificationProof: z.string().optional(),
  regionCode: z.string().max(10).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const privateFundDisbursementSchema = z.object({
  programId: z.string().min(1).max(100),
  purpose: z.string().min(1).max(500),
  fundingSource: z.string().max(100).optional(),
  recipientStealthAddress: stealthAddressObjectSchema,
  privacyLevel: privacyLevelSchema,
  confidentialAmount: z.record(z.string(), z.any()).optional(),
  encryptedAmount: z.string().optional(),
  rangeProof: z.string().optional(),
  complianceData: z.record(z.string(), z.any()).optional(),
  encryptedMilestones: z.string().optional(),
  reportingRequirements: z.record(z.string(), z.any()).optional(),
  regionCode: z.string().max(10).optional(),
  complianceFlags: z.array(z.string()).optional(),
  totalMilestones: z.number().int().min(1).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const registerStealthAddressSchema = z.object({
  publicSpendKey: z.string().min(1).max(200),
  publicViewKey: z.string().min(1).max(200),
  oneTimePublicKey: z.string().min(1).max(200),
  transactionKey: z.string().min(1).max(200),
  paymentId: z.string().optional(),
  addressType: addressTypeSchema,
  purpose: z.string().max(200).optional(),
  dataType: z.string().max(50).optional(),
  projectId: z.string().max(100).optional(),
  programId: z.string().max(100).optional(),
  privacyLevel: privacyLevelSchema,
  regionCode: z.string().max(10).optional(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const confidentialTransactionSchema = z.object({
  transactionType: z.string().min(1).max(50),
  confidentialAmounts: z.array(z.record(z.string(), z.any())).min(1),
  privacyLevel: privacyLevelSchema,
  stealthAddresses: z.array(stealthAddressObjectSchema).min(1),
  climateContext: z.string().max(500).optional(),
  projectId: z.string().max(100).optional(),
  programId: z.string().max(100).optional(),
  regionCode: z.string().max(10).optional(),
  complianceFlags: z.array(z.string()).optional(),
  nullifierHashes: z.array(z.string()).optional(),
  membershipProofs: z.array(z.string()).optional(),
  validityProofs: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const validateAmountsSchema = z.object({
  confidentialAmounts: z.array(z.record(z.string(), z.any())).min(1),
  transactionType: z.string().min(1).max(50),
});

// Utility function to safely extract error message from unknown error type
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

// Helper function to generate stealth address ID
function generateStealthAddressId(
  publicSpendKey: Buffer,
  publicViewKey: Buffer
): string {
  const hash = createHash('sha256');
  hash.update(publicSpendKey);
  hash.update(publicViewKey);
  hash.update(Buffer.from(Date.now().toString()));
  return hash.digest('hex').substring(0, 32);
}

// Helper function to generate transaction ID
function generateTransactionId(): string {
  return `climate_tx_${crypto.randomUUID().replace(/-/g, '')}`;
}

// Helper function to validate privacy level
function isValidPrivacyLevel(level: string): boolean {
  return CLIMATE_PRIVACY_LEVELS.includes(level as any);
}

// Helper function to validate address type
function isValidAddressType(type: string): boolean {
  return CLIMATE_STEALTH_ADDRESS_TYPES.includes(type as any);
}

export const climatePrivacyController = {
  // Submit private weather data
  submitPrivateWeatherData: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = privateWeatherDataSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const validatedData = result.data;
      const {
        weatherData: weatherDataInput,
        rewardStealthAddress,
        sensorOwnerStealthAddress,
        privacyLevel,
        addressType,
        dataType,
        regionCode,
        complianceFlags,
        encryptedSensorData,
        encryptedPayload,
        validityProof,
        rangeProof,
        metadata,
      } = validatedData;

        // Generate submission ID
        const submissionId = `private_weather_${crypto.randomUUID().replace(/-/g, '')}`;

        // Create private weather data submission
        const [submission] = await db
          .insert(privateWeatherData)
          .values({
            submissionId,
            rewardStealthAddress: JSON.stringify(rewardStealthAddress),
            sensorOwnerStealthAddress: sensorOwnerStealthAddress
              ? JSON.stringify(sensorOwnerStealthAddress)
              : null,
            privacyLevel,
            addressType,
            dataType,
            regionCode,
            complianceFlags: complianceFlags
              ? JSON.stringify(complianceFlags)
              : null,
            encryptedSensorData,
            encryptedPayload,
            validityProof,
            rangeProof,
            metadata: metadata ? JSON.stringify(metadata) : null,
          } as any)
          .returning();

        // Log audit event
        await db.insert(climateTransactionAuditLog).values({
          auditId: `audit_${crypto.randomUUID().replace(/-/g, '')}`,
          transactionId: submissionId,
          transactionType: 'private_weather_data',
          auditEvent: 'created',
          auditDetails: JSON.stringify({
            addressType,
            privacyLevel,
            dataType,
            hasEncryptedData: !!encryptedSensorData,
          }),
          privacyLevel,
          privacyFeatures: JSON.stringify([
            'stealth_addresses',
            'encrypted_payload',
          ]),
          complianceChecks: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          complianceStatus: 'pending',
          actorType: 'user',
          systemVersion: '1.0.0',
        });

        res.status(201).json({
          success: true,
          data: {
            submissionId: submission.submissionId,
            status: 'created',
            privacyLevel,
            timestamp: submission.createdAt,
          },
        });
    } catch (error) {
      privacyLogger.error('Error submitting private weather data', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to submit private weather data',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Create private carbon credit transfer
  createPrivateCarbonCreditTransfer: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = privateCarbonCreditSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const validatedData = result.data;
      const {
          projectId,
          vintageYear,
          creditType,
          buyerStealthAddress,
          sellerStealthAddress,
          confidentialCreditAmount,
          encryptedAmount,
          rangeProof,
          registryData,
          complianceFlags,
          verificationProof,
          privacyLevel,
          regionCode,
          metadata,
        } = req.body;

        // Generate credit ID and transaction ID
        const creditId = `private_carbon_${crypto.randomUUID().replace(/-/g, '')}`;
        const transactionId = generateTransactionId();

        // Create private carbon credit record
        const [carbonCredit] = await db
          .insert(privateCarbonCredits)
          .values({
            creditId,
            projectId,
            vintageYear,
            creditType,
            buyerStealthAddress: JSON.stringify(buyerStealthAddress),
            sellerStealthAddress: JSON.stringify(sellerStealthAddress),
            confidentialCreditAmount: confidentialCreditAmount
              ? JSON.stringify(confidentialCreditAmount)
              : null,
            encryptedAmount,
            rangeProof,
            registryData: registryData ? JSON.stringify(registryData) : null,
            complianceFlags: complianceFlags
              ? JSON.stringify(complianceFlags)
              : null,
            verificationProof,
            privacyLevel,
            regionCode,
            transactionId,
            metadata: metadata ? JSON.stringify(metadata) : null,
          })
          .returning();

        // Create corresponding private climate transaction
        await db.insert(privateClimateTransactions).values({
          transactionId,
          transactionType: 'carbon_credit',
          climateContext: `Carbon credit transfer: ${projectId}`,
          senderStealthAddress: JSON.stringify(sellerStealthAddress),
          recipientStealthAddress: JSON.stringify(buyerStealthAddress),
          privacyLevel,
          addressType: 'carbon_credit_transfer',
          confidentialAmount: confidentialCreditAmount
            ? JSON.stringify(confidentialCreditAmount)
            : null,
          encryptedAmount,
          rangeProof,
          regionCode,
          complianceFlags: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          projectId,
          status: 'pending',
        });

        // Log audit event
        await db.insert(climateTransactionAuditLog).values({
          auditId: `audit_${crypto.randomUUID().replace(/-/g, '')}`,
          transactionId,
          transactionType: 'carbon_credit',
          auditEvent: 'created',
          auditDetails: JSON.stringify({
            projectId,
            vintageYear,
            privacyLevel,
            hasConfidentialAmount: !!confidentialCreditAmount,
          }),
          privacyLevel,
          privacyFeatures: JSON.stringify([
            'stealth_addresses',
            'confidential_amounts',
          ]),
          complianceChecks: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          complianceStatus: 'pending',
          actorType: 'user',
          systemVersion: '1.0.0',
        });

        res.status(201).json({
          success: true,
          data: {
            creditId: carbonCredit.creditId,
            transactionId,
            status: 'pending',
            privacyLevel,
            timestamp: carbonCredit.createdAt,
          },
        });
    } catch (error) {
      privacyLogger.error('Error creating private carbon credit transfer', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to create private carbon credit transfer',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Create private climate fund disbursement
  createPrivateClimateFundDisbursement: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = privateFundDisbursementSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const validatedData = result.data;
      const {
          programId,
          purpose,
          fundingSource,
          recipientStealthAddress,
          confidentialAmount,
          encryptedAmount,
          rangeProof,
          complianceData,
          encryptedMilestones,
          reportingRequirements,
          privacyLevel,
          regionCode,
          complianceFlags,
          totalMilestones,
          metadata,
        } = req.body;

        // Generate disbursement ID and transaction ID
        const disbursementId = `private_fund_${crypto.randomUUID().replace(/-/g, '')}`;
        const transactionId = generateTransactionId();

        // Create private climate fund disbursement
        const [fundDisbursement] = await db
          .insert(privateClimateFunds)
          .values({
            disbursementId,
            programId,
            purpose,
            fundingSource,
            recipientStealthAddress: JSON.stringify(recipientStealthAddress),
            confidentialAmount: confidentialAmount
              ? JSON.stringify(confidentialAmount)
              : null,
            encryptedAmount,
            rangeProof,
            complianceData: complianceData
              ? JSON.stringify(complianceData)
              : null,
            encryptedMilestones,
            reportingRequirements: reportingRequirements
              ? JSON.stringify(reportingRequirements)
              : null,
            privacyLevel,
            regionCode,
            complianceFlags: complianceFlags
              ? JSON.stringify(complianceFlags)
              : null,
            transactionId,
            totalMilestones,
            metadata: metadata ? JSON.stringify(metadata) : null,
          })
          .returning();

        // Create corresponding private climate transaction
        await db.insert(privateClimateTransactions).values({
          transactionId,
          transactionType: 'climate_fund',
          climateContext: `Climate fund disbursement: ${programId}`,
          recipientStealthAddress: JSON.stringify(recipientStealthAddress),
          privacyLevel,
          addressType: 'climate_fund_disbursement',
          confidentialAmount: confidentialAmount
            ? JSON.stringify(confidentialAmount)
            : null,
          encryptedAmount,
          rangeProof,
          regionCode,
          complianceFlags: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          programId,
          status: 'pending',
        });

        // Log audit event
        await db.insert(climateTransactionAuditLog).values({
          auditId: `audit_${crypto.randomUUID().replace(/-/g, '')}`,
          transactionId,
          transactionType: 'climate_fund',
          auditEvent: 'created',
          auditDetails: JSON.stringify({
            programId,
            purpose,
            privacyLevel,
            hasConfidentialAmount: !!confidentialAmount,
            totalMilestones,
          }),
          privacyLevel,
          privacyFeatures: JSON.stringify([
            'stealth_addresses',
            'confidential_amounts',
            'milestone_tracking',
          ]),
          complianceChecks: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          complianceStatus: 'pending',
          actorType: 'user',
          systemVersion: '1.0.0',
        });

        res.status(201).json({
          success: true,
          data: {
            disbursementId: fundDisbursement.disbursementId,
            transactionId,
            status: 'pending',
            privacyLevel,
            timestamp: fundDisbursement.createdAt,
          },
        });
    } catch (error) {
      privacyLogger.error('Error creating private climate fund disbursement', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to create private climate fund disbursement',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Register climate stealth address
  registerClimateStealthAddress: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = registerStealthAddressSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const validatedData = result.data;
      const {
          publicSpendKey,
          publicViewKey,
          oneTimePublicKey,
          transactionKey,
          paymentId,
          addressType,
          purpose,
          dataType,
          projectId,
          programId,
          privacyLevel,
          regionCode,
          expiresAt,
          metadata,
        } = req.body;

        // Store hex strings directly (no conversion to buffers needed since schema now uses text)
        // Generate address ID from hex strings
        const addressId = generateStealthAddressId(
          publicSpendKey,
          publicViewKey
        );

        // Register stealth address
        const [stealthAddress] = await db
          .insert(climateStealthAddressRegistry)
          .values({
            addressId,
            publicSpendKey,
            publicViewKey,
            oneTimePublicKey,
            transactionKey,
            paymentId,
            addressType,
            purpose,
            dataType,
            projectId,
            programId,
            privacyLevel,
            regionCode,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            metadata: metadata ? JSON.stringify(metadata) : null,
          })
          .returning();

        res.status(201).json({
          success: true,
          data: {
            addressId: stealthAddress.addressId,
            addressType,
            privacyLevel,
            isUsed: stealthAddress.isUsed,
            createdAt: stealthAddress.createdAt,
          },
        });
    } catch (error) {
      privacyLogger.error('Error registering climate stealth address', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to register climate stealth address',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Get private climate transactions (with privacy filters)
  getPrivateClimateTransactions: async (req: Request, res: Response) => {
    try {
      const {
        transactionType,
        privacyLevel,
        addressType,
        regionCode,
        projectId,
        programId,
        status,
        startDate,
        endDate,
      } = req.query;
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Math.min(isNaN(rawLimit) ? 50 : rawLimit, 100);
      const rawOffset = parseInt(req.query.offset as string, 10);
      const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

      let query = db.select().from(privateClimateTransactions) as any;

      if (transactionType) {
        query = query.where(
          eq(
            privateClimateTransactions.transactionType,
            transactionType as string
          )
        );
      }
      if (privacyLevel) {
        query = query.where(
          eq(
            privateClimateTransactions.privacyLevel as any,
            privacyLevel as string
          )
        );
      }
      if (addressType) {
        query = query.where(
          eq(
            privateClimateTransactions.addressType as any,
            addressType as string
          )
        );
      }
      if (regionCode) {
        query = query.where(
          eq(privateClimateTransactions.regionCode, regionCode as string)
        );
      }
      if (projectId) {
        query = query.where(
          eq(privateClimateTransactions.projectId, projectId as string)
        );
      }
      if (programId) {
        query = query.where(
          eq(privateClimateTransactions.programId, programId as string)
        );
      }
      if (status) {
        query = query.where(
          eq(privateClimateTransactions.status, status as string)
        );
      }
      if (startDate) {
        query = query.where(
          gte(
            privateClimateTransactions.createdAt,
            new Date(startDate as string)
          )
        );
      }
      if (endDate) {
        query = query.where(
          lte(privateClimateTransactions.createdAt, new Date(endDate as string))
        );
      }

      const transactions = await query
        .orderBy(desc(privateClimateTransactions.createdAt))
        .limit(limit)
        .offset(offset);

      // Filter out sensitive data based on privacy level
      const filteredTransactions = transactions.map(tx => {
        const filtered = { ...tx } as any;

        // Hide sensitive information based on privacy level
        if (tx.privacyLevel === 'maximum') {
          delete filtered.senderStealthAddress;
          delete filtered.recipientStealthAddress;
          delete filtered.confidentialAmount;
          delete filtered.encryptedAmount;
        } else if (tx.privacyLevel === 'enhanced') {
          delete filtered.confidentialAmount;
          delete filtered.encryptedAmount;
        }

        return filtered;
      });

      res.status(200).json({
        success: true,
        data: {
          transactions: filteredTransactions,
          total: filteredTransactions.length,
          limit,
          offset,
        },
      });
    } catch (error) {
      privacyLogger.error('Error getting private climate transactions', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to get private climate transactions',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Get climate transaction audit log
  getClimateTransactionAuditLog: async (req: Request, res: Response) => {
    try {
      const { transactionId } = req.params;
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Math.min(isNaN(rawLimit) ? 50 : rawLimit, 200);
      const rawOffset = parseInt(req.query.offset as string, 10);
      const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

      const auditLogs = await db
        .select()
        .from(climateTransactionAuditLog)
        .where(eq(climateTransactionAuditLog.transactionId, transactionId))
        .orderBy(desc(climateTransactionAuditLog.timestamp))
        .limit(limit)
        .offset(offset);

      res.status(200).json({
        success: true,
        data: {
          transactionId,
          auditLogs,
          total: auditLogs.length,
        },
      });
    } catch (error) {
      privacyLogger.error('Error getting climate transaction audit log', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to get climate transaction audit log',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Create confidential climate transaction
  createConfidentialClimateTransaction: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = confidentialTransactionSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const validatedData = result.data;
      const {
          transactionType,
          confidentialAmounts,
          privacyLevel,
          stealthAddresses,
          climateContext,
          projectId,
          programId,
          regionCode,
          complianceFlags,
          nullifierHashes,
          membershipProofs,
          validityProofs,
          metadata,
        } = req.body;

        // Generate transaction ID
        const transactionId = generateTransactionId();

        // Create private climate transaction with confidential amounts
        const [transaction] = await db
          .insert(privateClimateTransactions)
          .values({
            transactionId,
            transactionType,
            climateContext,
            senderStealthAddress:
              stealthAddresses.length > 0
                ? JSON.stringify(stealthAddresses[0])
                : null,
            recipientStealthAddress:
              stealthAddresses.length > 1
                ? JSON.stringify(stealthAddresses[1])
                : JSON.stringify(stealthAddresses[0]),
            privacyLevel,
            addressType: transactionType.includes('carbon')
              ? 'carbon_credit_transfer'
              : transactionType.includes('fund')
                ? 'climate_fund_disbursement'
                : transactionType.includes('weather')
                  ? 'weather_data_reward'
                  : 'data_validation_payment',
            confidentialAmount:
              confidentialAmounts.length > 0
                ? JSON.stringify(confidentialAmounts[0])
                : null,
            encryptedAmount:
              confidentialAmounts.length > 0 &&
              confidentialAmounts[0].encryptedAmount
                ? confidentialAmounts[0].encryptedAmount
                : null,
            rangeProof:
              confidentialAmounts.length > 0 &&
              confidentialAmounts[0].rangeProof
                ? confidentialAmounts[0].rangeProof
                : null,
            regionCode,
            complianceFlags: complianceFlags
              ? JSON.stringify(complianceFlags)
              : null,
            projectId,
            programId,
            nullifierHash:
              nullifierHashes && nullifierHashes.length > 0
                ? nullifierHashes[0]
                : null,
            membershipProof:
              membershipProofs && membershipProofs.length > 0
                ? membershipProofs[0]
                : null,
            validityProof:
              validityProofs && validityProofs.length > 0
                ? validityProofs[0]
                : null,
            status: 'pending',
            metadata: metadata ? JSON.stringify(metadata) : null,
          })
          .returning();

        // Log comprehensive audit event
        await db.insert(climateTransactionAuditLog).values({
          auditId: `audit_${crypto.randomUUID().replace(/-/g, '')}`,
          transactionId,
          transactionType,
          auditEvent: 'created',
          auditDetails: JSON.stringify({
            transactionType,
            privacyLevel,
            confidentialAmountCount: confidentialAmounts.length,
            stealthAddressCount: stealthAddresses.length,
            hasNullifiers: !!nullifierHashes && nullifierHashes.length > 0,
            hasMembershipProofs:
              !!membershipProofs && membershipProofs.length > 0,
            projectId,
            programId,
          }),
          privacyLevel,
          privacyFeatures: JSON.stringify([
            'stealth_addresses',
            'confidential_amounts',
            'range_proofs',
            ...(nullifierHashes && nullifierHashes.length > 0
              ? ['nullifiers']
              : []),
            ...(membershipProofs && membershipProofs.length > 0
              ? ['membership_proofs']
              : []),
          ]),
          complianceChecks: complianceFlags
            ? JSON.stringify(complianceFlags)
            : null,
          complianceStatus: 'pending',
          actorType: 'user',
          systemVersion: '1.0.0',
        });

        res.status(201).json({
          success: true,
          data: {
            transactionId: transaction.transactionId,
            status: 'pending',
            privacyLevel,
            privacyFeatures: [
              'stealth_addresses',
              'confidential_amounts',
              'range_proofs',
            ],
            timestamp: transaction.createdAt,
          },
        });
    } catch (error) {
      privacyLogger.error('Error creating confidential climate transaction', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to create confidential climate transaction',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Validate confidential amounts
  validateConfidentialAmounts: async (req: Request, res: Response): Promise<void> => {
    try {
      const result = validateAmountsSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error.issues[0]?.message || 'Validation failed',
          errors: result.error.issues,
        });
        return;
      }

      const { confidentialAmounts, transactionType } = result.data;

        const validationResults: Array<{
          index: number;
          isValid: boolean;
          errors: string[];
          warnings: string[];
        }> = [];

        for (const [index, amount] of confidentialAmounts.entries()) {
          const validation = {
            index,
            isValid: true,
            errors: [] as string[],
            warnings: [] as string[],
          };

          // Validate commitment structure
          if (!amount.commitment || !amount.commitment.commitment) {
            validation.isValid = false;
            validation.errors.push('Missing or invalid Pedersen commitment');
          }

          // Validate range proof
          if (!amount.rangeProof || amount.rangeProof.length === 0) {
            validation.isValid = false;
            validation.errors.push('Missing range proof');
          }

          // Validate transaction type compatibility
          if (
            !amount.transactionType ||
            typeof amount.transactionType !== 'object'
          ) {
            validation.isValid = false;
            validation.errors.push('Missing or invalid transaction type');
          }

          // Validate compliance metadata
          if (!amount.complianceMetadata) {
            validation.warnings.push('Missing compliance metadata');
          } else {
            const compliance = amount.complianceMetadata;

            // Check regulatory requirements
            if (
              transactionType.includes('carbon') &&
              !compliance.auditTrailRequired
            ) {
              validation.warnings.push(
                'Carbon credit transactions typically require audit trails'
              );
            }

            if (
              transactionType.includes('fund') &&
              !compliance.taxReportingRequired
            ) {
              validation.warnings.push(
                'Fund disbursements typically require tax reporting'
              );
            }

            // Check KYC/AML requirements for high-value transactions
            if (amount.encryptedAmount && !compliance.kycRequired) {
              validation.warnings.push(
                'High-value transactions may require KYC'
              );
            }
          }

          // Validate encrypted amounts for compliance
          if (
            amount.complianceMetadata &&
            amount.complianceMetadata.auditTrailRequired &&
            !amount.encryptedAmount
          ) {
            validation.isValid = false;
            validation.errors.push(
              'Audit trail required but no encrypted amount provided'
            );
          }

          validationResults.push(validation);
        }

        const overallValid = validationResults.every(result => result.isValid);
        const totalWarnings = validationResults.reduce(
          (sum, result) => sum + result.warnings.length,
          0
        );

        res.status(200).json({
          success: true,
          data: {
            overallValid,
            totalWarnings,
            validationResults,
            summary: {
              totalAmounts: confidentialAmounts.length,
              validAmounts: validationResults.filter(r => r.isValid).length,
              invalidAmounts: validationResults.filter(r => !r.isValid).length,
              warningCount: totalWarnings,
            },
          },
        });
    } catch (error) {
      privacyLogger.error('Error validating confidential amounts', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to validate confidential amounts',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Get compliance requirements for jurisdiction
  getComplianceRequirements: async (req: Request, res: Response) => {
    try {
      const { jurisdiction, transactionType } = req.query;

      // Define compliance requirements by jurisdiction and transaction type
      const complianceMatrix = {
        EU: {
          carbon_credit: {
            kycRequired: true,
            amlRequired: true,
            auditTrailRequired: true,
            taxReportingRequired: true,
            maxDisclosureAmount: 10000,
            minReportingThreshold: 1000,
            complianceFlags: ['gdpr', 'eu_taxonomy', 'carbon_registry'],
            requiredDocuments: [
              'identity_verification',
              'carbon_registry_proof',
            ],
          },
          climate_fund: {
            kycRequired: true,
            amlRequired: true,
            auditTrailRequired: true,
            taxReportingRequired: true,
            maxDisclosureAmount: 50000,
            minReportingThreshold: 5000,
            complianceFlags: ['gdpr', 'public_funds', 'grant_transparency'],
            requiredDocuments: ['grant_application', 'milestone_reports'],
          },
          weather_data: {
            kycRequired: false,
            amlRequired: false,
            auditTrailRequired: false,
            taxReportingRequired: false,
            maxDisclosureAmount: null,
            minReportingThreshold: 100,
            complianceFlags: ['gdpr', 'data_privacy'],
            requiredDocuments: ['data_quality_proof'],
          },
        },
        US: {
          carbon_credit: {
            kycRequired: true,
            amlRequired: true,
            auditTrailRequired: true,
            taxReportingRequired: true,
            maxDisclosureAmount: 10000,
            minReportingThreshold: 600,
            complianceFlags: [
              'sec_regulations',
              'irs_reporting',
              'cftc_oversight',
            ],
            requiredDocuments: ['ssn_verification', 'carbon_offset_proof'],
          },
          climate_fund: {
            kycRequired: true,
            amlRequired: true,
            auditTrailRequired: true,
            taxReportingRequired: true,
            maxDisclosureAmount: 25000,
            minReportingThreshold: 600,
            complianceFlags: [
              'sec_regulations',
              'irs_reporting',
              'government_funds',
            ],
            requiredDocuments: ['tax_id', 'grant_justification'],
          },
          weather_data: {
            kycRequired: false,
            amlRequired: false,
            auditTrailRequired: false,
            taxReportingRequired: false,
            maxDisclosureAmount: null,
            minReportingThreshold: 600,
            complianceFlags: ['data_privacy', 'noaa_standards'],
            requiredDocuments: ['data_source_verification'],
          },
        },
        GLOBAL: {
          carbon_credit: {
            kycRequired: false,
            amlRequired: false,
            auditTrailRequired: true,
            taxReportingRequired: false,
            maxDisclosureAmount: null,
            minReportingThreshold: 1000,
            complianceFlags: ['basic_compliance', 'carbon_registry'],
            requiredDocuments: ['carbon_credit_proof'],
          },
          climate_fund: {
            kycRequired: false,
            amlRequired: false,
            auditTrailRequired: true,
            taxReportingRequired: false,
            maxDisclosureAmount: null,
            minReportingThreshold: 1000,
            complianceFlags: ['basic_compliance', 'transparency'],
            requiredDocuments: ['funding_justification'],
          },
          weather_data: {
            kycRequired: false,
            amlRequired: false,
            auditTrailRequired: false,
            taxReportingRequired: false,
            maxDisclosureAmount: null,
            minReportingThreshold: null,
            complianceFlags: ['basic_compliance'],
            requiredDocuments: [],
          },
        },
      };

      const jurisdictionKey = (jurisdiction as string) || 'GLOBAL';
      const transactionTypeKey = (transactionType as string) || 'weather_data';

      const requirements =
        complianceMatrix[jurisdictionKey]?.[transactionTypeKey] ||
        complianceMatrix['GLOBAL'][transactionTypeKey] ||
        complianceMatrix['GLOBAL']['weather_data'];

      res.status(200).json({
        success: true,
        data: {
          jurisdiction: jurisdictionKey,
          transactionType: transactionTypeKey,
          requirements,
          lastUpdated: new Date().toISOString(),
        },
      });
    } catch (error) {
      privacyLogger.error('Error getting compliance requirements', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to get compliance requirements',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },

  // Get privacy statistics
  getPrivacyStatistics: async (req: Request, res: Response) => {
    try {
      // Get counts by privacy level
      const privacyLevelStats = await db
        .select({
          privacyLevel: privateClimateTransactions.privacyLevel,
          count: privateClimateTransactions.id,
        })
        .from(privateClimateTransactions)
        .groupBy(privateClimateTransactions.privacyLevel);

      // Get counts by address type
      const addressTypeStats = await db
        .select({
          addressType: privateClimateTransactions.addressType,
          count: privateClimateTransactions.id,
        })
        .from(privateClimateTransactions)
        .groupBy(privateClimateTransactions.addressType);

      // Get stealth address usage
      const stealthAddressStats = await db
        .select({
          total: climateStealthAddressRegistry.id,
          used: climateStealthAddressRegistry.isUsed,
        })
        .from(climateStealthAddressRegistry);

      res.status(200).json({
        success: true,
        data: {
          privacyLevelDistribution: privacyLevelStats,
          addressTypeDistribution: addressTypeStats,
          stealthAddressUsage: stealthAddressStats,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      privacyLogger.error('Error getting privacy statistics', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        message: 'Failed to get privacy statistics',
        error:
          process.env.NODE_ENV === 'development'
            ? getErrorMessage(error)
            : undefined,
      });
    }
  },
};

export default climatePrivacyController;
