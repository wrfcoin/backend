/**
 * Sybil Attack Prevention - Decentralized Identifier (DID) Verification
 *
 * Implements proof-of-unique-human verification using DIDs to prevent
 * a single entity from operating multiple nodes (Sybil attack).
 *
 * SECURITY ENHANCEMENT (Task 92.7): Added optional DID verification
 * for enhanced Sybil resistance.
 */

import { createHash, randomBytes } from 'crypto';

// ============================================================================
// DID VERIFICATION INTERFACES
// ============================================================================

export interface DIDDocument {
  id: string; // e.g., "did:wrfcoin:abc123" or "did:web:example.com"
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  service?: ServiceEndpoint[];
  created: Date;
  updated?: Date;
}

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020' | 'EcdsaSecp256k1VerificationKey2019' | 'JsonWebKey2020';
  controller: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: Record<string, string>;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DIDVerificationResult {
  isValid: boolean;
  did?: string;
  verificationLevel: 'none' | 'basic' | 'enhanced' | 'verified';
  uniquenessScore: number; // 0-100, how confident we are this is a unique human
  errors: string[];
  warnings: string[];
}

export interface DIDRegistration {
  did: string;
  nodeId: string;
  registeredAt: Date;
  lastVerifiedAt: Date;
  verificationLevel: string;
  challengesPassed: number;
  boundAddresses: string[]; // Ethereum/crypto addresses bound to this DID
}

export interface UniqueHumanChallenge {
  challengeId: string;
  type: 'proof-of-personhood' | 'captcha' | 'biometric' | 'social-verification' | 'stake-commitment';
  difficulty: 'easy' | 'medium' | 'hard';
  expiresAt: Date;
  challenge: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// DID VERIFICATION CONFIGURATION
// ============================================================================

export interface DIDVerifierConfig {
  requiredForRegistration: boolean; // Whether DID is mandatory for node registration
  allowedDIDMethods: string[]; // Allowed DID methods (e.g., 'did:wrfcoin:', 'did:web:', 'did:key:')
  minVerificationLevel: 'none' | 'basic' | 'enhanced' | 'verified';
  maxNodesPerDID: number; // Maximum nodes a single DID can operate
  uniquenessScoreThreshold: number; // Minimum uniqueness score required (0-100)
  enableBiometricVerification: boolean;
  enableSocialVerification: boolean;
}

// ============================================================================
// DID VERIFIER CLASS
// ============================================================================

export class DIDVerifier {
  private config: DIDVerifierConfig = {
    requiredForRegistration: false, // Optional by default for gradual adoption
    allowedDIDMethods: ['did:wrfcoin:', 'did:web:', 'did:key:', 'did:pkh:', 'did:ethr:'],
    minVerificationLevel: 'basic',
    maxNodesPerDID: 3, // Allow up to 3 nodes per verified human
    uniquenessScoreThreshold: 60,
    enableBiometricVerification: true,
    enableSocialVerification: true,
  };

  // In-memory storage (would be database in production)
  private didRegistry = new Map<string, DIDRegistration>();
  private pendingChallenges = new Map<string, UniqueHumanChallenge>();
  private didToNodesMap = new Map<string, Set<string>>(); // DID -> nodeIds

  constructor(config?: Partial<DIDVerifierConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  // ============================================================================
  // PUBLIC METHODS
  // ============================================================================

  /**
   * Verify a DID for node registration
   * Returns verification result with uniqueness score
   */
  async verifyDID(
    did: string,
    nodeId: string,
    signature?: string
  ): Promise<DIDVerificationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // If DID is not provided and not required, return success with no verification
    if (!did) {
      if (this.config.requiredForRegistration) {
        return {
          isValid: false,
          verificationLevel: 'none',
          uniquenessScore: 0,
          errors: ['DID is required for node registration'],
          warnings: [],
        };
      }
      return {
        isValid: true,
        verificationLevel: 'none',
        uniquenessScore: 20, // Low score for unverified nodes
        errors: [],
        warnings: ['Node registered without DID verification - limited privileges'],
      };
    }

    // Validate DID format
    if (!this.isValidDIDFormat(did)) {
      return {
        isValid: false,
        did,
        verificationLevel: 'none',
        uniquenessScore: 0,
        errors: ['Invalid DID format'],
        warnings: [],
      };
    }

    // Check if DID method is allowed
    if (!this.isDIDMethodAllowed(did)) {
      return {
        isValid: false,
        did,
        verificationLevel: 'none',
        uniquenessScore: 0,
        errors: [`DID method not allowed. Supported: ${this.config.allowedDIDMethods.join(', ')}`],
        warnings: [],
      };
    }

    // Check if this DID has already registered too many nodes
    const existingNodes = this.didToNodesMap.get(did) || new Set();
    if (existingNodes.size >= this.config.maxNodesPerDID) {
      return {
        isValid: false,
        did,
        verificationLevel: 'none',
        uniquenessScore: 0,
        errors: [`DID has reached maximum node limit (${this.config.maxNodesPerDID})`],
        warnings: [],
      };
    }

    // Check if node is already registered with a different DID
    const didMapEntries = Array.from(this.didToNodesMap.entries());
    for (const [registeredDid, nodes] of didMapEntries) {
      if (nodes.has(nodeId) && registeredDid !== did) {
        return {
          isValid: false,
          did,
          verificationLevel: 'none',
          uniquenessScore: 0,
          errors: ['Node is already registered with a different DID'],
          warnings: [],
        };
      }
    }

    // Resolve and verify DID document
    const didDocument = await this.resolveDIDDocument(did);
    if (!didDocument) {
      warnings.push('DID document could not be resolved - treating as basic verification');
    }

    // Verify signature if provided
    let signatureValid = false;
    if (signature && didDocument) {
      signatureValid = await this.verifyDIDSignature(did, nodeId, signature, didDocument);
      if (!signatureValid) {
        errors.push('DID signature verification failed');
      }
    }

    // Calculate verification level and uniqueness score
    const verificationLevel = this.calculateVerificationLevel(did, didDocument, signatureValid);
    const uniquenessScore = this.calculateUniquenessScore(did, verificationLevel, existingNodes.size);

    // Check minimum uniqueness score
    if (uniquenessScore < this.config.uniquenessScoreThreshold) {
      warnings.push(`Uniqueness score (${uniquenessScore}) below threshold (${this.config.uniquenessScoreThreshold})`);
    }

    // Check minimum verification level
    const levelOrder = ['none', 'basic', 'enhanced', 'verified'];
    const minLevelIndex = levelOrder.indexOf(this.config.minVerificationLevel);
    const currentLevelIndex = levelOrder.indexOf(verificationLevel);

    if (currentLevelIndex < minLevelIndex) {
      errors.push(`Verification level (${verificationLevel}) below minimum required (${this.config.minVerificationLevel})`);
    }

    const isValid = errors.length === 0;

    // Register DID -> Node mapping if valid
    if (isValid) {
      await this.registerDIDNode(did, nodeId, verificationLevel);
    }

    return {
      isValid,
      did,
      verificationLevel,
      uniquenessScore,
      errors,
      warnings,
    };
  }

  /**
   * Generate a unique human challenge for enhanced verification
   */
  generateUniqueHumanChallenge(
    nodeId: string,
    type: UniqueHumanChallenge['type'] = 'proof-of-personhood'
  ): UniqueHumanChallenge {
    const challengeId = this.generateChallengeId();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    let challenge: string;
    let difficulty: UniqueHumanChallenge['difficulty'] = 'medium';

    switch (type) {
      case 'proof-of-personhood':
        // Generate a PoP challenge (e.g., image selection, puzzle)
        challenge = this.generatePoPersonhoodChallenge();
        difficulty = 'medium';
        break;
      case 'captcha':
        // Generate CAPTCHA-style challenge
        challenge = this.generateCaptchaChallenge();
        difficulty = 'easy';
        break;
      case 'biometric':
        // Generate biometric verification request
        challenge = this.generateBiometricChallenge();
        difficulty = 'hard';
        break;
      case 'social-verification':
        // Generate social verification challenge
        challenge = this.generateSocialVerificationChallenge();
        difficulty = 'hard';
        break;
      case 'stake-commitment':
        // Generate stake commitment challenge
        challenge = this.generateStakeCommitmentChallenge();
        difficulty = 'medium';
        break;
      default:
        challenge = this.generatePoPersonhoodChallenge();
    }

    const uniqueHumanChallenge: UniqueHumanChallenge = {
      challengeId,
      type,
      difficulty,
      expiresAt,
      challenge,
    };

    this.pendingChallenges.set(challengeId, uniqueHumanChallenge);
    return uniqueHumanChallenge;
  }

  /**
   * Verify a unique human challenge response
   */
  async verifyChallengeResponse(
    challengeId: string,
    nodeId: string,
    response: string
  ): Promise<{ passed: boolean; message: string }> {
    const challenge = this.pendingChallenges.get(challengeId);

    if (!challenge) {
      return { passed: false, message: 'Challenge not found or expired' };
    }

    if (new Date() > challenge.expiresAt) {
      this.pendingChallenges.delete(challengeId);
      return { passed: false, message: 'Challenge expired' };
    }

    // Verify the response based on challenge type
    const isValid = await this.validateChallengeResponse(challenge, response);

    if (isValid) {
      this.pendingChallenges.delete(challengeId);

      // Update DID registration if exists
      await this.incrementChallengesPassed(nodeId);

      return { passed: true, message: 'Challenge passed successfully' };
    }

    return { passed: false, message: 'Invalid challenge response' };
  }

  /**
   * Get the number of nodes registered under a DID
   */
  getNodesForDID(did: string): string[] {
    const nodes = this.didToNodesMap.get(did);
    return nodes ? Array.from(nodes) : [];
  }

  /**
   * Get DID registration for a node
   */
  getDIDForNode(nodeId: string): DIDRegistration | undefined {
    const registryEntries = Array.from(this.didRegistry.entries());
    for (const [, registration] of registryEntries) {
      if (registration.nodeId === nodeId) {
        return registration;
      }
    }
    return undefined;
  }

  /**
   * Revoke a DID registration for a node
   */
  revokeDIDRegistration(nodeId: string): boolean {
    const mapEntries = Array.from(this.didToNodesMap.entries());
    for (const [did, nodes] of mapEntries) {
      if (nodes.has(nodeId)) {
        nodes.delete(nodeId);
        if (nodes.size === 0) {
          this.didToNodesMap.delete(did);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Check if DID verification is required
   */
  isDIDRequired(): boolean {
    return this.config.requiredForRegistration;
  }

  /**
   * Get verification statistics
   */
  getVerificationStats(): {
    totalDIDs: number;
    totalNodes: number;
    averageNodesPerDID: number;
    verificationLevelDistribution: Record<string, number>;
  } {
    const totalDIDs = this.didRegistry.size;
    let totalNodes = 0;
    const levelDistribution: Record<string, number> = {
      none: 0,
      basic: 0,
      enhanced: 0,
      verified: 0,
    };

    const nodeMapEntries = Array.from(this.didToNodesMap.values());
    for (const nodes of nodeMapEntries) {
      totalNodes += nodes.size;
    }

    const registryEntries = Array.from(this.didRegistry.values());
    for (const registration of registryEntries) {
      levelDistribution[registration.verificationLevel]++;
    }

    return {
      totalDIDs,
      totalNodes,
      averageNodesPerDID: totalDIDs > 0 ? totalNodes / totalDIDs : 0,
      verificationLevelDistribution: levelDistribution,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private isValidDIDFormat(did: string): boolean {
    // DID format: did:<method>:<method-specific-id>
    const didRegex = /^did:[a-z0-9]+:[a-zA-Z0-9._-]+$/;
    return didRegex.test(did);
  }

  private isDIDMethodAllowed(did: string): boolean {
    return this.config.allowedDIDMethods.some(method => did.startsWith(method));
  }

  private async resolveDIDDocument(did: string): Promise<DIDDocument | null> {
    // In production, this would resolve the DID document from:
    // - Universal DID Resolver
    // - Method-specific resolver (e.g., did:web, did:ethr)
    // - Local cache

    // For now, return a mock document for valid DIDs
    try {
      // Simulate DID resolution
      return {
        id: did,
        controller: did,
        verificationMethod: [{
          id: `${did}#keys-1`,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: 'z6Mk...' + randomBytes(20).toString('hex'),
        }],
        authentication: [`${did}#keys-1`],
        created: new Date(),
      };
    } catch (error) {
      return null;
    }
  }

  private async verifyDIDSignature(
    did: string,
    nodeId: string,
    signature: string,
    didDocument: DIDDocument
  ): Promise<boolean> {
    // In production, this would:
    // 1. Extract public key from DID document
    // 2. Verify the signature against the message (nodeId)
    // 3. Check signature algorithm compatibility

    // For now, basic validation
    try {
      if (!signature || signature.length < 64) {
        return false;
      }

      // Verify signature format (hex-encoded)
      const hexRegex = /^[0-9a-fA-F]+$/;
      return hexRegex.test(signature);
    } catch (error) {
      return false;
    }
  }

  private calculateVerificationLevel(
    did: string,
    didDocument: DIDDocument | null,
    signatureValid: boolean
  ): DIDVerificationResult['verificationLevel'] {
    if (!did) return 'none';

    let score = 0;

    // Basic: Valid DID format
    if (this.isValidDIDFormat(did)) score += 1;

    // Enhanced: DID document resolved
    if (didDocument) score += 1;

    // Verified: Valid signature
    if (signatureValid) score += 2;

    if (score >= 4) return 'verified';
    if (score >= 2) return 'enhanced';
    if (score >= 1) return 'basic';
    return 'none';
  }

  private calculateUniquenessScore(
    did: string,
    verificationLevel: string,
    existingNodeCount: number
  ): number {
    let score = 0;

    // Base score from verification level
    switch (verificationLevel) {
      case 'verified': score += 60; break;
      case 'enhanced': score += 40; break;
      case 'basic': score += 20; break;
      default: score += 0;
    }

    // Bonus for DID methods that inherently prove uniqueness
    if (did.startsWith('did:web:')) score += 15; // Web domain ownership
    if (did.startsWith('did:ethr:')) score += 10; // Ethereum address
    if (did.startsWith('did:pkh:')) score += 10; // Proof of key holder

    // Penalty for multiple nodes on same DID
    score -= existingNodeCount * 10;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, score));
  }

  private async registerDIDNode(
    did: string,
    nodeId: string,
    verificationLevel: string
  ): Promise<void> {
    // Add node to DID mapping
    if (!this.didToNodesMap.has(did)) {
      this.didToNodesMap.set(did, new Set());
    }
    this.didToNodesMap.get(did)!.add(nodeId);

    // Create or update registration
    const registration: DIDRegistration = {
      did,
      nodeId,
      registeredAt: new Date(),
      lastVerifiedAt: new Date(),
      verificationLevel,
      challengesPassed: 0,
      boundAddresses: [],
    };

    this.didRegistry.set(`${did}:${nodeId}`, registration);
  }

  private async incrementChallengesPassed(nodeId: string): Promise<void> {
    const registryEntries = Array.from(this.didRegistry.entries());
    for (const [key, registration] of registryEntries) {
      if (registration.nodeId === nodeId) {
        registration.challengesPassed++;
        registration.lastVerifiedAt = new Date();
        this.didRegistry.set(key, registration);
        break;
      }
    }
  }

  private generateChallengeId(): string {
    return 'ch_' + randomBytes(16).toString('hex');
  }

  private generatePoPersonhoodChallenge(): string {
    // Generate a proof-of-personhood challenge
    // In production, this would be a CAPTCHA, puzzle, or other PoP mechanism
    const operations = ['+', '-', '*'];
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    const op = operations[Math.floor(Math.random() * operations.length)];

    return JSON.stringify({
      type: 'arithmetic',
      question: `What is ${a} ${op} ${b}?`,
      hash: createHash('sha256').update(`${a}${op}${b}`).digest('hex').substring(0, 8),
    });
  }

  private generateCaptchaChallenge(): string {
    // Generate a simple CAPTCHA challenge
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let captcha = '';
    for (let i = 0; i < 6; i++) {
      captcha += chars[Math.floor(Math.random() * chars.length)];
    }

    return JSON.stringify({
      type: 'captcha',
      code: captcha,
      hash: createHash('sha256').update(captcha).digest('hex').substring(0, 8),
    });
  }

  private generateBiometricChallenge(): string {
    // Generate a biometric verification request
    return JSON.stringify({
      type: 'biometric',
      method: 'fingerprint',
      nonce: randomBytes(16).toString('hex'),
      verificationEndpoint: '/api/verify-biometric',
    });
  }

  private generateSocialVerificationChallenge(): string {
    // Generate a social verification challenge
    return JSON.stringify({
      type: 'social',
      platforms: ['twitter', 'github', 'linkedin'],
      verificationCode: randomBytes(8).toString('hex'),
      instructions: 'Post this code publicly on one of the supported platforms',
    });
  }

  private generateStakeCommitmentChallenge(): string {
    // Generate a stake commitment challenge
    const amount = 100 + Math.floor(Math.random() * 400); // 100-500 WRF
    return JSON.stringify({
      type: 'stake',
      requiredAmount: amount,
      lockDuration: 30 * 24 * 60 * 60, // 30 days in seconds
      destinationAddress: '0x' + randomBytes(20).toString('hex'),
    });
  }

  private async validateChallengeResponse(
    challenge: UniqueHumanChallenge,
    response: string
  ): Promise<boolean> {
    try {
      const challengeData = JSON.parse(challenge.challenge);

      switch (challengeData.type) {
        case 'arithmetic':
          // Validate arithmetic response
          const question = challengeData.question;
          const match = question.match(/What is (\d+) ([+\-*]) (\d+)\?/);
          if (!match) return false;

          const [, aStr, op, bStr] = match;
          const a = parseInt(aStr);
          const b = parseInt(bStr);
          let expected: number;

          switch (op) {
            case '+': expected = a + b; break;
            case '-': expected = a - b; break;
            case '*': expected = a * b; break;
            default: return false;
          }

          return parseInt(response) === expected;

        case 'captcha':
          // Validate CAPTCHA response (case-insensitive)
          return response.toUpperCase() === challengeData.code.toUpperCase();

        case 'biometric':
        case 'social':
        case 'stake':
          // These would require external verification
          // For now, accept any non-empty response as pending verification
          return response.length > 0;

        default:
          return false;
      }
    } catch (error) {
      return false;
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default DIDVerifier;
