/**
 * WebAuthn/FIDO2 Service
 * Task 94.14: Implements passwordless authentication using WebAuthn standard
 *
 * Provides:
 * - Credential registration (security keys, biometrics, passkeys)
 * - Authentication verification
 * - Credential management
 * - Integration with existing MFA system
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import * as crypto from 'crypto';
import { drizzle as drizzleRuntime } from 'drizzle-orm/postgres-js';
import type { drizzle as drizzleEsm } from '../../node_modules/drizzle-orm/postgres-js/index.js';
import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../../node_modules/drizzle-orm/index.js';
import postgres from 'postgres';
import { securityLogger } from '../utils/logger.js';
import {
  webauthnCredentials,
  webauthnChallenges,
  userMfaSettings,
  mfaAttempts,
  securityEvents,
} from '../../shared/mfa-schema.js';
import { users } from '../../shared/schema.js';

const drizzle = drizzleRuntime as unknown as typeof drizzleEsm;
const { eq, and, lt, isNull } =
  drizzleOrm as unknown as typeof drizzleOrmEsm;

// Configuration
const WEBAUTHN_CONFIG = {
  // Relying Party (RP) information - update for production
  RP_NAME: process.env.WEBAUTHN_RP_NAME || 'WRFCoin Platform',
  RP_ID: process.env.WEBAUTHN_RP_ID || 'localhost',
  ORIGIN: process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173',

  // Challenge settings
  CHALLENGE_EXPIRY: 5 * 60 * 1000, // 5 minutes
  CHALLENGE_ID_LENGTH: 32,

  // Authenticator settings
  AUTHENTICATOR_ATTACHMENT: 'platform' as const, // 'platform' for built-in, 'cross-platform' for roaming
  RESIDENT_KEY: 'preferred' as const,
  USER_VERIFICATION: 'preferred' as const,

  // Timeouts
  REGISTRATION_TIMEOUT: 60000, // 60 seconds
  AUTHENTICATION_TIMEOUT: 60000,
};

// Lazy database connection — avoids blocking the event loop at module scope
// when running inside an esbuild CJS bundle (#267).
let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const connectionString =
      process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin';
    _db = drizzle(postgres(connectionString), {
      schema: {
        webauthnCredentials,
        webauthnChallenges,
        userMfaSettings,
        mfaAttempts,
        securityEvents,
        users,
      },
    });
  }
  return _db;
}

// Types
export interface WebAuthnUser {
  id: number;
  username: string;
  email?: string;
}

export interface StoredCredential {
  id: number;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: string | null;
  transports: string[] | null;
  friendlyName: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface RegistrationOptionsResult {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface AuthenticationOptionsResult {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface VerificationResult {
  success: boolean;
  message?: string;
  credential?: StoredCredential;
}

export class WebAuthnService {
  /**
   * Generate registration options for a new WebAuthn credential
   */
  async generateRegistrationOptions(
    user: WebAuthnUser
  ): Promise<RegistrationOptionsResult> {
    // Get existing credentials to exclude from registration
    const existingCredentials = await this.getUserCredentials(user.id);
    const excludeCredentials = existingCredentials.map((cred) => ({
      id: cred.credentialId, // Already base64url encoded string
      transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
    }));

    // Generate user handle (unique identifier for the authenticator)
    const userIdBuffer = Buffer.alloc(8);
    userIdBuffer.writeBigInt64BE(BigInt(user.id));

    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_CONFIG.RP_NAME,
      rpID: WEBAUTHN_CONFIG.RP_ID,
      userID: userIdBuffer,
      userName: user.username,
      userDisplayName: user.email || user.username,
      attestationType: 'none', // Use 'direct' or 'indirect' for attestation verification
      excludeCredentials,
      authenticatorSelection: {
        residentKey: WEBAUTHN_CONFIG.RESIDENT_KEY,
        userVerification: WEBAUTHN_CONFIG.USER_VERIFICATION,
      },
      timeout: WEBAUTHN_CONFIG.REGISTRATION_TIMEOUT,
      // Support algorithms: ES256, RS256
      supportedAlgorithmIDs: [-7, -257],
    });

    // Store challenge for verification
    const challengeId = crypto
      .randomBytes(WEBAUTHN_CONFIG.CHALLENGE_ID_LENGTH)
      .toString('hex');

    await getDb().insert(webauthnChallenges).values({
      challengeId,
      challenge: options.challenge,
      userId: user.id,
      type: 'registration',
      expiresAt: new Date(Date.now() + WEBAUTHN_CONFIG.CHALLENGE_EXPIRY),
    });

    return {
      challengeId,
      options,
    };
  }

  /**
   * Verify registration response and store credential
   */
  async verifyRegistration(
    userId: number,
    challengeId: string,
    response: RegistrationResponseJSON,
    friendlyName?: string
  ): Promise<VerificationResult> {
    // Retrieve and validate challenge
    const challengeRecord = await this.getAndValidateChallenge(
      challengeId,
      'registration',
      userId
    );

    if (!challengeRecord) {
      await this.logMfaAttempt(userId, 'webauthn', false, 'Invalid or expired challenge');
      return {
        success: false,
        message: 'Invalid or expired challenge',
      };
    }

    try {
      const verification: VerifiedRegistrationResponse =
        await verifyRegistrationResponse({
          response,
          expectedChallenge: challengeRecord.challenge,
          expectedOrigin: WEBAUTHN_CONFIG.ORIGIN,
          expectedRPID: WEBAUTHN_CONFIG.RP_ID,
        });

      if (!verification.verified || !verification.registrationInfo) {
        await this.logMfaAttempt(userId, 'webauthn', false, 'Verification failed');
        return {
          success: false,
          message: 'WebAuthn registration verification failed',
        };
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      // Store credential
      const credentialId = Buffer.from(credential.id).toString('base64url');
      const publicKey = Buffer.from(credential.publicKey).toString('base64');

      await getDb().insert(webauthnCredentials).values({
        userId,
        credentialId,
        publicKey,
        counter: credential.counter,
        deviceType: credentialDeviceType,
        transports: response.response.transports || [],
        aaguid: Buffer.from(verification.registrationInfo.aaguid || '').toString('hex'),
        friendlyName: friendlyName || `Security Key ${new Date().toLocaleDateString()}`,
        backedUp: credentialBackedUp,
        lastUsedAt: new Date(),
      });

      // Mark challenge as used
      await this.markChallengeUsed(challengeId);

      // Update user MFA settings to indicate WebAuthn is enabled
      await this.updateMfaSettings(userId);

      // Log successful registration
      await this.logSecurityEvent(userId, 'webauthn_registered', 'medium', {
        credentialId,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
      });

      await this.logMfaAttempt(userId, 'webauthn', true);

      // Retrieve the stored credential
      const storedCred = await this.getCredentialById(credentialId);

      return {
        success: true,
        credential: storedCred || undefined,
      };
    } catch (error) {
      securityLogger.error('WebAuthn registration error', { module: 'WebAuthnService', operation: 'verifyRegistration', error: error instanceof Error ? error.message : String(error) });
      await this.logMfaAttempt(
        userId,
        'webauthn',
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'WebAuthn registration failed',
      };
    }
  }

  /**
   * Generate authentication options
   */
  async generateAuthenticationOptions(
    userId?: number
  ): Promise<AuthenticationOptionsResult> {
    let allowCredentials:
      | {
          id: string;
          transports?: AuthenticatorTransportFuture[];
        }[]
      | undefined;

    // If userId provided, only allow that user's credentials
    if (userId) {
      const credentials = await this.getUserCredentials(userId);
      if (credentials.length === 0) {
        throw new Error('No WebAuthn credentials found for user');
      }

      allowCredentials = credentials.map((cred) => ({
        id: cred.credentialId, // Already base64url encoded string
        transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_CONFIG.RP_ID,
      allowCredentials,
      userVerification: WEBAUTHN_CONFIG.USER_VERIFICATION,
      timeout: WEBAUTHN_CONFIG.AUTHENTICATION_TIMEOUT,
    });

    // Store challenge
    const challengeId = crypto
      .randomBytes(WEBAUTHN_CONFIG.CHALLENGE_ID_LENGTH)
      .toString('hex');

    await getDb().insert(webauthnChallenges).values({
      challengeId,
      challenge: options.challenge,
      userId: userId || null,
      type: 'authentication',
      expiresAt: new Date(Date.now() + WEBAUTHN_CONFIG.CHALLENGE_EXPIRY),
    });

    return {
      challengeId,
      options,
    };
  }

  /**
   * Verify authentication response
   */
  async verifyAuthentication(
    challengeId: string,
    response: AuthenticationResponseJSON,
    expectedUserId?: number
  ): Promise<VerificationResult & { userId?: number }> {
    // Retrieve challenge
    const challengeRecord = await this.getAndValidateChallenge(
      challengeId,
      'authentication',
      expectedUserId
    );

    if (!challengeRecord) {
      return {
        success: false,
        message: 'Invalid or expired challenge',
      };
    }

    // Find credential
    const credentialId = response.id;
    const storedCredential = await this.getCredentialById(credentialId);

    if (!storedCredential) {
      await this.logMfaAttempt(
        expectedUserId || 0,
        'webauthn',
        false,
        'Credential not found'
      );
      return {
        success: false,
        message: 'Credential not found',
      };
    }

    // If expectedUserId provided, verify credential belongs to user
    if (expectedUserId && storedCredential.userId !== expectedUserId) {
      await this.logMfaAttempt(
        expectedUserId,
        'webauthn',
        false,
        'Credential user mismatch'
      );
      return {
        success: false,
        message: 'Credential does not belong to user',
      };
    }

    try {
      const publicKey = Buffer.from(storedCredential.publicKey, 'base64');

      const verification: VerifiedAuthenticationResponse =
        await verifyAuthenticationResponse({
          response,
          expectedChallenge: challengeRecord.challenge,
          expectedOrigin: WEBAUTHN_CONFIG.ORIGIN,
          expectedRPID: WEBAUTHN_CONFIG.RP_ID,
          credential: {
            id: storedCredential.credentialId, // base64url string
            publicKey: new Uint8Array(publicKey),
            counter: storedCredential.counter,
            transports: storedCredential.transports as AuthenticatorTransportFuture[] | undefined,
          },
        });

      if (!verification.verified) {
        await this.logMfaAttempt(
          storedCredential.userId,
          'webauthn',
          false,
          'Authentication verification failed'
        );
        return {
          success: false,
          message: 'WebAuthn authentication failed',
        };
      }

      // Update counter to prevent replay attacks
      await getDb()
        .update(webauthnCredentials)
        .set({
          counter: verification.authenticationInfo.newCounter,
          lastUsedAt: new Date(),
        })
        .where(eq(webauthnCredentials.credentialId, credentialId));

      // Mark challenge as used
      await this.markChallengeUsed(challengeId);

      // Log successful authentication
      await this.logSecurityEvent(
        storedCredential.userId,
        'webauthn_authenticated',
        'low',
        { credentialId }
      );

      await this.logMfaAttempt(storedCredential.userId, 'webauthn', true);

      return {
        success: true,
        userId: storedCredential.userId,
        credential: {
          id: storedCredential.id,
          credentialId: storedCredential.credentialId,
          publicKey: storedCredential.publicKey,
          counter: verification.authenticationInfo.newCounter,
          deviceType: storedCredential.deviceType,
          transports: storedCredential.transports,
          friendlyName: storedCredential.friendlyName,
          lastUsedAt: new Date(),
          createdAt: storedCredential.createdAt,
        },
      };
    } catch (error) {
      securityLogger.error('WebAuthn authentication error', { module: 'WebAuthnService', operation: 'verifyAuthentication', error: error instanceof Error ? error.message : String(error) });
      await this.logMfaAttempt(
        storedCredential.userId,
        'webauthn',
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'WebAuthn authentication failed',
      };
    }
  }

  /**
   * Get all credentials for a user
   */
  async getUserCredentials(userId: number): Promise<StoredCredential[]> {
    const credentials = await getDb()
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));

    return credentials.map((cred) => ({
      id: cred.id,
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      counter: cred.counter,
      deviceType: cred.deviceType,
      transports: cred.transports as string[] | null,
      friendlyName: cred.friendlyName,
      lastUsedAt: cred.lastUsedAt,
      createdAt: cred.createdAt,
      userId: cred.userId,
    }));
  }

  /**
   * Get credential by ID
   */
  async getCredentialById(
    credentialId: string
  ): Promise<(StoredCredential & { userId: number }) | null> {
    const result = await getDb()
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const cred = result[0];
    return {
      id: cred.id,
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      counter: cred.counter,
      deviceType: cred.deviceType,
      transports: cred.transports as string[] | null,
      friendlyName: cred.friendlyName,
      lastUsedAt: cred.lastUsedAt,
      createdAt: cred.createdAt,
      userId: cred.userId,
    };
  }

  /**
   * Update credential friendly name
   */
  async updateCredentialName(
    userId: number,
    credentialId: string,
    friendlyName: string
  ): Promise<boolean> {
    const result = await getDb()
      .update(webauthnCredentials)
      .set({ friendlyName })
      .where(
        and(
          eq(webauthnCredentials.userId, userId),
          eq(webauthnCredentials.credentialId, credentialId)
        )
      );

    return true;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(
    userId: number,
    credentialId: string
  ): Promise<boolean> {
    const credentials = await this.getUserCredentials(userId);

    // Don't allow deletion of last credential if MFA is required
    if (credentials.length <= 1) {
      const mfaSettings = await getDb()
        .select()
        .from(userMfaSettings)
        .where(eq(userMfaSettings.userId, userId))
        .limit(1);

      // Check if TOTP is enabled as backup
      if (mfaSettings.length === 0 || !mfaSettings[0].totpSecret) {
        throw new Error(
          'Cannot delete last WebAuthn credential without alternative MFA method'
        );
      }
    }

    await getDb()
      .delete(webauthnCredentials)
      .where(
        and(
          eq(webauthnCredentials.userId, userId),
          eq(webauthnCredentials.credentialId, credentialId)
        )
      );

    await this.logSecurityEvent(userId, 'webauthn_credential_deleted', 'medium', {
      credentialId,
    });

    return true;
  }

  /**
   * Check if user has WebAuthn enabled
   */
  async hasWebAuthn(userId: number): Promise<boolean> {
    const credentials = await this.getUserCredentials(userId);
    return credentials.length > 0;
  }

  /**
   * Helper: Get and validate challenge
   */
  private async getAndValidateChallenge(
    challengeId: string,
    type: 'registration' | 'authentication',
    userId?: number
  ): Promise<{ challenge: string } | null> {
    // Find challenge that hasn't expired yet (expiresAt > now)
    const now = new Date();
    const result = await getDb()
      .select()
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.challengeId, challengeId),
          eq(webauthnChallenges.type, type),
          isNull(webauthnChallenges.usedAt)
        )
      )
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const challenge = result[0];

    // Check if challenge has expired
    if (challenge.expiresAt < now) {
      return null;
    }

    // For registration, verify userId matches
    if (type === 'registration' && userId && challenge.userId !== userId) {
      return null;
    }

    return {
      challenge: challenge.challenge,
    };
  }

  /**
   * Helper: Mark challenge as used
   */
  private async markChallengeUsed(challengeId: string): Promise<void> {
    await getDb()
      .update(webauthnChallenges)
      .set({ usedAt: new Date() })
      .where(eq(webauthnChallenges.challengeId, challengeId));
  }

  /**
   * Helper: Update MFA settings to indicate WebAuthn is configured
   */
  private async updateMfaSettings(userId: number): Promise<void> {
    // Check if settings exist
    const existing = await getDb()
      .select()
      .from(userMfaSettings)
      .where(eq(userMfaSettings.userId, userId))
      .limit(1);

    if (existing.length === 0) {
      await getDb().insert(userMfaSettings).values({
        userId,
        mfaEnabled: true,
      });
    } else if (!existing[0].mfaEnabled) {
      await getDb()
        .update(userMfaSettings)
        .set({ mfaEnabled: true, updatedAt: new Date() })
        .where(eq(userMfaSettings.userId, userId));
    }
  }

  /**
   * Helper: Log MFA attempt
   */
  private async logMfaAttempt(
    userId: number,
    attemptType: string,
    success: boolean,
    failureReason?: string
  ): Promise<void> {
    await getDb().insert(mfaAttempts).values({
      userId,
      attemptType,
      success,
      failureReason,
    });
  }

  /**
   * Helper: Log security event
   */
  private async logSecurityEvent(
    userId: number,
    eventType: string,
    severity: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    await getDb().insert(securityEvents).values({
      userId,
      eventType,
      severity,
      description: `WebAuthn event: ${eventType}`,
      metadata,
    });
  }

  /**
   * Cleanup expired challenges
   */
  async cleanupExpiredChallenges(): Promise<number> {
    // Delete challenges where expiresAt < now (expired)
    await getDb()
      .delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, new Date()));

    return 0; // Drizzle doesn't return affected rows easily
  }
}

export const webauthnService = new WebAuthnService();
