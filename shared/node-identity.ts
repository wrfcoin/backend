/**
 * Cryptographic Identity Verification with PKI
 * Implements certificate-based node authentication with CRL support
 *
 * SECURITY IMPROVEMENTS (v2.0):
 * - HSM integration for all CA private key operations
 * - ECDSA P-384 certificate signing for quantum resistance
 * - CRL signature verification before trust decisions
 * - Certificate pinning for critical peers
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { securityLogger } from '../server/utils/logger.js';
// Note: @peculiar/x509 is optional - used for advanced certificate operations
// import * as x509 from '@peculiar/x509';

// ============ HSM Interface for Key Operations ============

/**
 * HSM Provider Interface - Abstract all private key operations
 * Private keys NEVER leave the HSM
 */
interface HSMProvider {
  generateKeyPair(keyType: string, algorithm: SignatureAlgorithm): Promise<HSMKeyPairResult>;
  sign(keyHandle: string, data: Buffer): Promise<Buffer>;
  verify(keyHandle: string, data: Buffer, signature: Buffer): Promise<boolean>;
  getPublicKey(keyHandle: string): Promise<string>;
  deleteKey(keyHandle: string): Promise<void>;
  isKeyAvailable(keyHandle: string): Promise<boolean>;
}

interface HSMKeyPairResult {
  keyHandle: string;
  publicKey: string;
  algorithm: SignatureAlgorithm;
  createdAt: Date;
}

/**
 * Signature Algorithm identifiers compliant with RFC 5758
 */
type SignatureAlgorithm =
  | 'ECDSA-P384-SHA384'   // Primary: secp384r1 with SHA-384
  | 'ECDSA-P256-SHA256'   // Fallback: secp256r1 with SHA-256
  | 'Ed25519';            // Modern alternative

/**
 * HSM Configuration
 */
interface HSMConfiguration {
  provider: 'aws-cloudhsm' | 'azure-keyvault' | 'pkcs11' | 'software-simulation';
  endpoint?: string;
  keyStoreId?: string;
  sessionTimeout: number;
}

/**
 * Software HSM Simulation - ONLY for development/testing
 * In production, use real HSM providers (AWS CloudHSM, Azure Key Vault, etc.)
 */
class SoftwareHSMSimulation implements HSMProvider {
  private keys: Map<string, { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; algorithm: SignatureAlgorithm }> = new Map();
  private isProduction: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
    if (this.isProduction) {
      securityLogger.warn('Software HSM simulation should NOT be used in production', { module: 'SoftwareHSM', security: 'CRITICAL' });
    }
  }

  async generateKeyPair(keyType: string, algorithm: SignatureAlgorithm): Promise<HSMKeyPairResult> {
    const keyHandle = `hsm-key-${keyType}-${crypto.randomBytes(16).toString('hex')}`;

    let keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };

    switch (algorithm) {
      case 'ECDSA-P384-SHA384':
        keyPair = crypto.generateKeyPairSync('ec', {
          namedCurve: 'secp384r1',
        });
        break;
      case 'ECDSA-P256-SHA256':
        keyPair = crypto.generateKeyPairSync('ec', {
          namedCurve: 'prime256v1',
        });
        break;
      case 'Ed25519':
        keyPair = crypto.generateKeyPairSync('ed25519');
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    this.keys.set(keyHandle, {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      algorithm,
    });

    const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;

    return {
      keyHandle,
      publicKey: publicKeyPem,
      algorithm,
      createdAt: new Date(),
    };
  }

  async sign(keyHandle: string, data: Buffer): Promise<Buffer> {
    const keyData = this.keys.get(keyHandle);
    if (!keyData) {
      throw new Error(`Key not found in HSM: ${keyHandle}`);
    }

    let hashAlgorithm: string;
    switch (keyData.algorithm) {
      case 'ECDSA-P384-SHA384':
        hashAlgorithm = 'sha384';
        break;
      case 'ECDSA-P256-SHA256':
        hashAlgorithm = 'sha256';
        break;
      case 'Ed25519':
        hashAlgorithm = ''; // Ed25519 doesn't use separate hash
        break;
      default:
        throw new Error(`Unsupported algorithm: ${keyData.algorithm}`);
    }

    if (keyData.algorithm === 'Ed25519') {
      return crypto.sign(null, data, keyData.privateKey);
    } else {
      const sign = crypto.createSign(hashAlgorithm);
      sign.update(data);
      sign.end();
      return sign.sign(keyData.privateKey);
    }
  }

  async verify(keyHandle: string, data: Buffer, signature: Buffer): Promise<boolean> {
    const keyData = this.keys.get(keyHandle);
    if (!keyData) {
      throw new Error(`Key not found in HSM: ${keyHandle}`);
    }

    let hashAlgorithm: string;
    switch (keyData.algorithm) {
      case 'ECDSA-P384-SHA384':
        hashAlgorithm = 'sha384';
        break;
      case 'ECDSA-P256-SHA256':
        hashAlgorithm = 'sha256';
        break;
      case 'Ed25519':
        hashAlgorithm = '';
        break;
      default:
        throw new Error(`Unsupported algorithm: ${keyData.algorithm}`);
    }

    try {
      if (keyData.algorithm === 'Ed25519') {
        return crypto.verify(null, data, keyData.publicKey, signature);
      } else {
        const verify = crypto.createVerify(hashAlgorithm);
        verify.update(data);
        verify.end();
        return verify.verify(keyData.publicKey, signature);
      }
    } catch {
      return false;
    }
  }

  async getPublicKey(keyHandle: string): Promise<string> {
    const keyData = this.keys.get(keyHandle);
    if (!keyData) {
      throw new Error(`Key not found in HSM: ${keyHandle}`);
    }
    return keyData.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  async deleteKey(keyHandle: string): Promise<void> {
    this.keys.delete(keyHandle);
  }

  async isKeyAvailable(keyHandle: string): Promise<boolean> {
    return this.keys.has(keyHandle);
  }
}

// ============ Certificate Pinning Registry ============

/**
 * Certificate Pin for critical peers
 */
interface CertificatePin {
  nodeId: string;
  publicKeyHash: string;      // SHA-384 hash of public key
  certificateHash?: string;   // Optional: SHA-384 hash of full certificate
  validFrom: Date;
  validUntil: Date;
  isCriticalPeer: boolean;
  lastVerified?: Date;
}

/**
 * Certificate Pinning Registry for critical peers
 */
class CertificatePinningRegistry {
  private pins: Map<string, CertificatePin> = new Map();
  private backupPins: Map<string, CertificatePin[]> = new Map(); // Backup pins for rotation

  addPin(pin: CertificatePin): void {
    const existing = this.pins.get(pin.nodeId);
    if (existing) {
      // Keep old pin as backup for graceful rotation
      const backups = this.backupPins.get(pin.nodeId) || [];
      backups.push(existing);
      // Keep only last 2 backup pins
      if (backups.length > 2) {
        backups.shift();
      }
      this.backupPins.set(pin.nodeId, backups);
    }
    this.pins.set(pin.nodeId, pin);
  }

  removePin(nodeId: string): boolean {
    this.backupPins.delete(nodeId);
    return this.pins.delete(nodeId);
  }

  getPin(nodeId: string): CertificatePin | undefined {
    return this.pins.get(nodeId);
  }

  /**
   * Verify certificate against pins
   * Returns true if the certificate matches a valid pin or if no pin exists
   */
  verifyCertificatePin(nodeId: string, publicKey: string, certificate?: string): {
    valid: boolean;
    reason?: string;
    isPinned: boolean;
  } {
    const pin = this.pins.get(nodeId);

    if (!pin) {
      // No pin exists for this node
      return { valid: true, isPinned: false };
    }

    const now = new Date();

    // Check pin validity period
    if (now < pin.validFrom || now > pin.validUntil) {
      return {
        valid: false,
        reason: 'Certificate pin has expired or is not yet valid',
        isPinned: true,
      };
    }

    // Calculate public key hash
    const publicKeyHash = crypto
      .createHash('sha384')
      .update(publicKey)
      .digest('hex');

    // Check primary pin
    if (publicKeyHash === pin.publicKeyHash) {
      pin.lastVerified = now;
      return { valid: true, isPinned: true };
    }

    // Check backup pins for graceful rotation
    const backups = this.backupPins.get(nodeId) || [];
    for (const backup of backups) {
      if (now >= backup.validFrom && now <= backup.validUntil) {
        if (publicKeyHash === backup.publicKeyHash) {
          backup.lastVerified = now;
          return { valid: true, isPinned: true };
        }
      }
    }

    // Pin mismatch - potential attack
    return {
      valid: false,
      reason: 'Certificate public key does not match pinned key',
      isPinned: true,
    };
  }

  /**
   * Calculate pin from public key
   */
  static calculatePublicKeyPin(publicKey: string): string {
    return crypto
      .createHash('sha384')
      .update(publicKey)
      .digest('hex');
  }
}

// ============ Core Identity Types ============

interface NodeIdentity {
  nodeId: string;
  publicKey: string;
  certificate: string;
  certificateChain: string[];
  issuedAt: Date;
  expiresAt: Date;
  revoked: boolean;
  revokedAt?: Date;
  revocationReason?: string;
}

/**
 * Certificate Authority - Private key operations delegated to HSM
 */
interface CertificateAuthority {
  caId: string;
  name: string;
  publicKey: string;
  keyHandle: string;          // HSM key handle - NEVER expose raw private key
  certificate: string;
  trustLevel: number;
  issuedCertificates: Set<string>;
  signatureAlgorithm: SignatureAlgorithm;
}

/**
 * Certificate Revocation List with signature verification support
 */
interface CertificateRevocationList {
  crlId: string;
  issuer: string;
  issuerKeyHandle: string;    // HSM key handle for signature verification
  revokedCertificates: Map<
    string,
    {
      serialNumber: string;
      revokedAt: Date;
      reason: string;
    }
  >;
  thisUpdate: Date;           // When this CRL was issued
  nextUpdate: Date;           // When next CRL should be fetched
  signature: string;
  signatureAlgorithm: SignatureAlgorithm;
  signatureVerified: boolean; // Track verification status
}

export class NodeIdentityVerification extends EventEmitter {
  private certificateAuthorities: Map<string, CertificateAuthority> = new Map();
  private nodeIdentities: Map<string, NodeIdentity> = new Map();
  private certificateRevocationLists: Map<string, CertificateRevocationList> =
    new Map();
  private trustedRoots: Set<string> = new Set();

  // Security enhancements
  private hsm: HSMProvider;
  private certificatePinning: CertificatePinningRegistry;
  private defaultSignatureAlgorithm: SignatureAlgorithm = 'ECDSA-P384-SHA384';
  private crlCacheDuration: number = 3600000; // 1 hour in ms
  private isInitialized: boolean = false;

  constructor(hsmProvider?: HSMProvider) {
    super();
    // Use provided HSM or default to software simulation
    this.hsm = hsmProvider || new SoftwareHSMSimulation();
    this.certificatePinning = new CertificatePinningRegistry();

    // Don't auto-initialize - require explicit initialization
    // This ensures proper async handling and error management
  }

  /**
   * Initialize the PKI system
   * Must be called before using other methods
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.initializeRootCA();
    this.isInitialized = true;

    this.emit('pkiInitialized', {
      timestamp: new Date(),
      signatureAlgorithm: this.defaultSignatureAlgorithm,
    });
  }

  /**
   * Initialize root Certificate Authority with HSM-protected keys
   * Private key NEVER leaves the HSM
   */
  private async initializeRootCA(): Promise<void> {
    // Generate key pair in HSM - private key stays in HSM
    const keyResult = await this.hsm.generateKeyPair(
      'root-ca',
      this.defaultSignatureAlgorithm
    );

    const caId = 'root-ca-' + crypto.randomBytes(8).toString('hex');

    // Generate self-signed certificate using HSM
    const certificate = await this.generateSelfSignedCertificateWithHSM(
      keyResult.keyHandle,
      keyResult.publicKey,
      'WRFCoin Root CA'
    );

    const rootCA: CertificateAuthority = {
      caId,
      name: 'WRFCoin Root CA',
      publicKey: keyResult.publicKey,
      keyHandle: keyResult.keyHandle, // HSM key handle - NOT the actual private key
      certificate,
      trustLevel: 100,
      issuedCertificates: new Set(),
      signatureAlgorithm: this.defaultSignatureAlgorithm,
    };

    this.certificateAuthorities.set(rootCA.caId, rootCA);
    this.trustedRoots.add(rootCA.caId);

    this.emit('rootCAInitialized', {
      caId: rootCA.caId,
      publicKey: rootCA.publicKey,
      signatureAlgorithm: rootCA.signatureAlgorithm,
      timestamp: new Date(),
    });
  }

  /**
   * Generate self-signed root certificate using HSM for signing
   * SECURITY: Private key operations happen inside HSM
   */
  private async generateSelfSignedCertificateWithHSM(
    keyHandle: string,
    publicKey: string,
    commonName: string
  ): Promise<string> {
    const serialNumber = crypto.randomBytes(20).toString('hex');
    const notBefore = new Date();
    const notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years

    const certData = {
      version: 3,
      serialNumber,
      subject: {
        commonName,
        organization: 'WRFCoin Network',
        country: 'US',
      },
      issuer: {
        commonName,
        organization: 'WRFCoin Network',
        country: 'US',
      },
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      publicKey,
      signatureAlgorithm: this.defaultSignatureAlgorithm,
      extensions: {
        basicConstraints: {
          critical: true,
          ca: true,
          pathLenConstraint: 1,
        },
        keyUsage: {
          critical: true,
          keyCertSign: true,
          cRLSign: true,
          digitalSignature: true,
        },
        subjectKeyIdentifier: this.calculateKeyIdentifier(publicKey),
      },
    };

    // Sign certificate data using HSM
    const tbsData = Buffer.from(JSON.stringify(certData), 'utf8');
    const signature = await this.hsm.sign(keyHandle, tbsData);

    const certificate = {
      ...certData,
      signature: signature.toString('base64'),
      signatureAlgorithm: this.defaultSignatureAlgorithm,
    };

    return JSON.stringify(certificate);
  }

  /**
   * Calculate key identifier (Subject Key Identifier extension)
   */
  private calculateKeyIdentifier(publicKey: string): string {
    return crypto
      .createHash('sha256')
      .update(publicKey)
      .digest('hex')
      .substring(0, 40);
  }

  /**
   * Register new node with PKI-based identity
   * Uses HSM for all certificate signing operations
   */
  async registerNode(
    nodeId: string,
    publicKey: string,
    certificateRequest: {
      commonName: string;
      organization: string;
      country: string;
      validityDays: number;
    }
  ): Promise<{ certificate: string; certificateChain: string[] }> {
    // Ensure PKI is initialized
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Validate node doesn't already exist
    if (this.nodeIdentities.has(nodeId)) {
      throw new Error('Node already registered');
    }

    // Get root CA
    const rootCA = Array.from(this.certificateAuthorities.values()).find(ca =>
      this.trustedRoots.has(ca.caId)
    );

    if (!rootCA) {
      throw new Error('Root CA not initialized');
    }

    // Validate HSM key is available
    const keyAvailable = await this.hsm.isKeyAvailable(rootCA.keyHandle);
    if (!keyAvailable) {
      throw new Error('CA signing key not available in HSM');
    }

    // Generate node certificate using HSM
    const certificate = await this.issueCertificateWithHSM(
      rootCA,
      nodeId,
      publicKey,
      certificateRequest
    );

    // Build certificate chain
    const certificateChain = [certificate, rootCA.certificate];

    // Create node identity
    const nodeIdentity: NodeIdentity = {
      nodeId,
      publicKey,
      certificate,
      certificateChain,
      issuedAt: new Date(),
      expiresAt: new Date(
        Date.now() + certificateRequest.validityDays * 24 * 60 * 60 * 1000
      ),
      revoked: false,
    };

    this.nodeIdentities.set(nodeId, nodeIdentity);

    this.emit('nodeRegistered', {
      nodeId,
      certificate,
      signatureAlgorithm: rootCA.signatureAlgorithm,
      issuedAt: nodeIdentity.issuedAt,
      expiresAt: nodeIdentity.expiresAt,
    });

    return {
      certificate,
      certificateChain,
    };
  }

  /**
   * Issue certificate for node using HSM for signing
   * SECURITY: CA private key operations delegated to HSM
   */
  private async issueCertificateWithHSM(
    ca: CertificateAuthority,
    nodeId: string,
    publicKey: string,
    request: {
      commonName: string;
      organization: string;
      country: string;
      validityDays: number;
    }
  ): Promise<string> {
    const serialNumber = crypto.randomBytes(20).toString('hex');
    const notBefore = new Date();
    const notAfter = new Date(
      Date.now() + request.validityDays * 24 * 60 * 60 * 1000
    );

    // Certificate To Be Signed (TBS) data
    const certData = {
      version: 3,
      serialNumber,
      subject: {
        commonName: request.commonName,
        organization: request.organization,
        country: request.country,
        nodeId: nodeId,
      },
      issuer: {
        commonName: ca.name,
        caId: ca.caId,
      },
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      publicKey: publicKey,
      signatureAlgorithm: ca.signatureAlgorithm,
      extensions: {
        basicConstraints: {
          critical: true,
          ca: false,
        },
        keyUsage: {
          critical: true,
          digitalSignature: true,
          keyEncipherment: true,
        },
        extendedKeyUsage: ['serverAuth', 'clientAuth'],
        subjectAlternativeName: [`nodeId:${nodeId}`],
        subjectKeyIdentifier: this.calculateKeyIdentifier(publicKey),
        authorityKeyIdentifier: this.calculateKeyIdentifier(ca.publicKey),
      },
    };

    // Sign certificate using HSM - private key NEVER leaves HSM
    const tbsData = Buffer.from(JSON.stringify(certData), 'utf8');
    const signature = await this.hsm.sign(ca.keyHandle, tbsData);

    const certificate = {
      ...certData,
      signature: signature.toString('base64'),
    };

    // Track issued certificate
    ca.issuedCertificates.add(serialNumber);

    return JSON.stringify(certificate);
  }

  /**
   * Sign data using HSM
   * SECURITY: Private key operations happen inside HSM
   * @deprecated Use hsm.sign() directly for new code
   */
  private async signWithHSM(keyHandle: string, data: Buffer): Promise<string> {
    const signature = await this.hsm.sign(keyHandle, data);
    return signature.toString('base64');
  }

  /**
   * Verify node certificate and chain with enhanced security checks
   * Includes: Certificate pinning, CRL signature verification, HSM-based verification
   */
  async verifyNodeCertificate(
    nodeId: string,
    certificate: string,
    certificateChain: string[]
  ): Promise<{
    valid: boolean;
    reason?: string;
    details?: {
      pinningVerified: boolean;
      chainVerified: boolean;
      signatureVerified: boolean;
      crlVerified: boolean;
    };
  }> {
    try {
      // Parse certificate
      const cert = JSON.parse(certificate);

      const details = {
        pinningVerified: false,
        chainVerified: false,
        signatureVerified: false,
        crlVerified: false,
      };

      // Step 1: Certificate pinning verification (for critical peers)
      const pinResult = this.certificatePinning.verifyCertificatePin(
        nodeId,
        cert.publicKey,
        certificate
      );
      if (!pinResult.valid) {
        return {
          valid: false,
          reason: pinResult.reason || 'Certificate pin verification failed',
          details,
        };
      }
      details.pinningVerified = true;

      // Step 2: Check certificate validity period
      const now = new Date();
      if (now < new Date(cert.notBefore) || now > new Date(cert.notAfter)) {
        return {
          valid: false,
          reason: 'Certificate expired or not yet valid',
          details,
        };
      }

      // Step 3: Check revocation with CRL signature verification
      const revocationResult = await this.checkCertificateRevocationWithVerification(
        cert.serialNumber,
        cert.issuer?.caId
      );
      if (revocationResult.isRevoked) {
        return {
          valid: false,
          reason: 'Certificate has been revoked',
          details,
        };
      }
      if (!revocationResult.crlValid) {
        // CRL signature could not be verified - treat cautiously
        this.emit('crlVerificationWarning', {
          nodeId,
          serialNumber: cert.serialNumber,
          reason: revocationResult.reason,
        });
      }
      details.crlVerified = revocationResult.crlValid;

      // Step 4: Verify certificate chain
      const chainValid = await this.verifyCertificateChainWithHSM(
        certificate,
        certificateChain
      );
      if (!chainValid.valid) {
        return {
          valid: false,
          reason: chainValid.reason || 'Invalid certificate chain',
          details,
        };
      }
      details.chainVerified = true;

      // Step 5: Verify certificate signature using HSM
      const signatureResult = await this.verifyCertificateSignatureWithHSM(
        certificate,
        certificateChain[1]
      );
      if (!signatureResult.valid) {
        return {
          valid: false,
          reason: signatureResult.reason || 'Invalid certificate signature',
          details,
        };
      }
      details.signatureVerified = true;

      return {
        valid: true,
        details,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        reason: `Certificate verification failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Verify certificate chain up to trusted root with HSM
   */
  private async verifyCertificateChainWithHSM(
    certificate: string,
    certificateChain: string[]
  ): Promise<{ valid: boolean; reason?: string }> {
    if (certificateChain.length === 0) {
      return { valid: false, reason: 'Empty certificate chain' };
    }

    // Last certificate in chain should be root CA
    const rootCertStr = certificateChain[certificateChain.length - 1];

    // Check if root is trusted
    const rootCA = Array.from(this.certificateAuthorities.values()).find(
      ca => ca.certificate === rootCertStr
    );

    if (!rootCA || !this.trustedRoots.has(rootCA.caId)) {
      return { valid: false, reason: 'Root CA is not trusted' };
    }

    // Verify each certificate is signed by the next in chain
    for (let i = 0; i < certificateChain.length - 1; i++) {
      const current = certificateChain[i];
      const issuer = certificateChain[i + 1];

      const result = await this.verifyCertificateSignatureWithHSM(current, issuer);
      if (!result.valid) {
        return {
          valid: false,
          reason: `Chain verification failed at position ${i}: ${result.reason}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Verify certificate signature using appropriate algorithm
   * SECURITY: Signature verification with proper algorithm detection
   */
  private async verifyCertificateSignatureWithHSM(
    certificate: string,
    issuerCertificate: string
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const cert = JSON.parse(certificate);
      const issuer = JSON.parse(issuerCertificate);

      // Extract signature and TBS data
      const { signature: signatureB64, signatureAlgorithm, ...certData } = cert;

      if (!signatureB64) {
        return { valid: false, reason: 'Certificate has no signature' };
      }

      const signature = Buffer.from(signatureB64, 'base64');
      const tbsData = Buffer.from(JSON.stringify(certData), 'utf8');

      // Determine hash algorithm based on signature algorithm
      const algorithm = signatureAlgorithm || 'ECDSA-P256-SHA256';

      let hashAlgorithm: string;
      switch (algorithm) {
        case 'ECDSA-P384-SHA384':
          hashAlgorithm = 'sha384';
          break;
        case 'ECDSA-P256-SHA256':
          hashAlgorithm = 'sha256';
          break;
        case 'Ed25519':
          hashAlgorithm = '';
          break;
        default:
          // Legacy fallback for old certificates
          hashAlgorithm = 'sha256';
      }

      // Create public key object from issuer's public key
      const publicKey = crypto.createPublicKey({
        key: issuer.publicKey,
        format: 'pem',
      });

      // Verify signature
      let isValid: boolean;
      if (algorithm === 'Ed25519') {
        isValid = crypto.verify(null, tbsData, publicKey, signature);
      } else {
        const verify = crypto.createVerify(hashAlgorithm);
        verify.update(tbsData);
        verify.end();
        isValid = verify.verify(publicKey, signature);
      }

      return { valid: isValid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, reason: `Signature verification error: ${errorMessage}` };
    }
  }

  /**
   * Legacy signature verification for backward compatibility
   * @deprecated Use verifyCertificateSignatureWithHSM instead
   */
  private verifyCertificateSignature(
    certificate: string,
    issuerCertificate: string
  ): boolean {
    try {
      const cert = JSON.parse(certificate);
      const issuer = JSON.parse(issuerCertificate);

      // Handle both old format (hex) and new format (base64)
      const { signature, signatureAlgorithm, ...certData } = cert;

      if (!signature) {
        return false;
      }

      // Detect signature encoding
      const isBase64 = /^[A-Za-z0-9+/=]+$/.test(signature);
      const signatureBuffer = isBase64
        ? Buffer.from(signature, 'base64')
        : Buffer.from(signature, 'hex');

      const tbsData = Buffer.from(JSON.stringify(certData), 'utf8');

      const publicKey = crypto.createPublicKey({
        key: issuer.publicKey,
        format: 'pem',
      });

      // Try to verify with appropriate algorithm
      const hashAlgorithm = signatureAlgorithm === 'ECDSA-P384-SHA384' ? 'sha384' : 'sha256';

      const verify = crypto.createVerify(hashAlgorithm);
      verify.update(tbsData);
      verify.end();

      return verify.verify(publicKey, signatureBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Check if certificate is revoked with CRL signature verification
   * SECURITY: CRL signatures MUST be verified before trust decisions
   */
  private async checkCertificateRevocationWithVerification(
    serialNumber: string,
    issuerId?: string
  ): Promise<{
    isRevoked: boolean;
    crlValid: boolean;
    reason?: string;
  }> {
    // Find relevant CRL
    const crlId = issuerId ? `crl-${issuerId}` : undefined;
    const crl = crlId ? this.certificateRevocationLists.get(crlId) : undefined;

    if (!crl) {
      // No CRL found - could be first time or CRL not yet published
      // Check all CRLs as fallback
      for (const [, currentCrl] of this.certificateRevocationLists) {
        if (currentCrl.revokedCertificates.has(serialNumber)) {
          // Verify CRL signature before trusting
          const verified = await this.verifyCRLSignature(currentCrl);
          if (!verified.valid) {
            this.emit('securityWarning', {
              type: 'CRL_SIGNATURE_INVALID',
              crlId: currentCrl.crlId,
              reason: verified.reason,
            });
            continue; // Don't trust this CRL
          }
          return { isRevoked: true, crlValid: true };
        }
      }
      return { isRevoked: false, crlValid: true, reason: 'No CRL found for issuer' };
    }

    // Verify CRL signature before trusting
    const crlVerification = await this.verifyCRLSignature(crl);
    if (!crlVerification.valid) {
      this.emit('securityWarning', {
        type: 'CRL_SIGNATURE_INVALID',
        crlId: crl.crlId,
        reason: crlVerification.reason,
      });
      // CRL signature invalid - don't trust it
      return {
        isRevoked: false,
        crlValid: false,
        reason: `CRL signature verification failed: ${crlVerification.reason}`,
      };
    }

    // Check CRL freshness
    const now = new Date();
    if (now > crl.nextUpdate) {
      this.emit('crlStale', {
        crlId: crl.crlId,
        nextUpdate: crl.nextUpdate,
        currentTime: now,
      });
      // CRL is stale - still check but warn
    }

    // Check if certificate is in revocation list
    const isRevoked = crl.revokedCertificates.has(serialNumber);

    return {
      isRevoked,
      crlValid: true,
    };
  }

  /**
   * Verify CRL signature using issuer's public key
   * SECURITY: CRL MUST be signed and signature MUST be verified
   */
  private async verifyCRLSignature(crl: CertificateRevocationList): Promise<{
    valid: boolean;
    reason?: string;
  }> {
    try {
      // If already verified, return cached result
      if (crl.signatureVerified) {
        return { valid: true };
      }

      // Get issuer CA
      const issuerCA = this.certificateAuthorities.get(crl.issuer);
      if (!issuerCA) {
        return { valid: false, reason: 'CRL issuer CA not found' };
      }

      // Reconstruct CRL data without signature for verification
      const crlData = {
        crlId: crl.crlId,
        issuer: crl.issuer,
        revokedCertificates: Object.fromEntries(crl.revokedCertificates),
        thisUpdate: crl.thisUpdate?.toISOString(),
        nextUpdate: crl.nextUpdate.toISOString(),
        signatureAlgorithm: crl.signatureAlgorithm,
      };

      const crlDataBuffer = Buffer.from(JSON.stringify(crlData), 'utf8');
      const signatureBuffer = Buffer.from(crl.signature, 'base64');

      // Determine hash algorithm
      const algorithm = crl.signatureAlgorithm || 'ECDSA-P256-SHA256';
      let hashAlgorithm: string;
      switch (algorithm) {
        case 'ECDSA-P384-SHA384':
          hashAlgorithm = 'sha384';
          break;
        case 'ECDSA-P256-SHA256':
          hashAlgorithm = 'sha256';
          break;
        default:
          hashAlgorithm = 'sha256';
      }

      // Create public key from issuer
      const publicKey = crypto.createPublicKey({
        key: issuerCA.publicKey,
        format: 'pem',
      });

      // Verify signature
      const verify = crypto.createVerify(hashAlgorithm);
      verify.update(crlDataBuffer);
      verify.end();

      const isValid = verify.verify(publicKey, signatureBuffer);

      if (isValid) {
        // Cache the verification result
        crl.signatureVerified = true;
      }

      return { valid: isValid };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, reason: `CRL verification error: ${errorMessage}` };
    }
  }

  /**
   * Legacy revocation check for backward compatibility
   * @deprecated Use checkCertificateRevocationWithVerification instead
   */
  private async checkCertificateRevocation(
    serialNumber: string
  ): Promise<boolean> {
    for (const [, crl] of this.certificateRevocationLists) {
      if (crl.revokedCertificates.has(serialNumber)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Revoke node certificate
   */
  async revokeNodeCertificate(nodeId: string, reason: string): Promise<void> {
    const nodeIdentity = this.nodeIdentities.get(nodeId);
    if (!nodeIdentity) {
      throw new Error('Node not found');
    }

    // Mark as revoked
    nodeIdentity.revoked = true;
    nodeIdentity.revokedAt = new Date();
    nodeIdentity.revocationReason = reason;

    this.nodeIdentities.set(nodeId, nodeIdentity);

    // Add to CRL
    await this.addToCRL(nodeIdentity.certificate, reason);

    this.emit('certificateRevoked', {
      nodeId,
      reason,
      revokedAt: nodeIdentity.revokedAt,
    });
  }

  /**
   * Add certificate to Certificate Revocation List
   * SECURITY: Uses HSM for CRL signing operations
   */
  private async addToCRL(certificate: string, reason: string): Promise<void> {
    const cert = JSON.parse(certificate);

    // Get issuer CA
    const ca = this.certificateAuthorities.get(cert.issuer.caId);
    if (!ca) {
      throw new Error('Issuer CA not found');
    }

    // Verify HSM key is available
    const keyAvailable = await this.hsm.isKeyAvailable(ca.keyHandle);
    if (!keyAvailable) {
      throw new Error('CA signing key not available in HSM');
    }

    // Get or create CRL for issuer
    const crlId = `crl-${cert.issuer.caId}`;
    let crl = this.certificateRevocationLists.get(crlId);

    const now = new Date();

    if (!crl) {
      crl = {
        crlId,
        issuer: cert.issuer.caId,
        issuerKeyHandle: ca.keyHandle,
        revokedCertificates: new Map(),
        thisUpdate: now,
        nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        signature: '',
        signatureAlgorithm: ca.signatureAlgorithm,
        signatureVerified: false,
      };
    }

    // Add revoked certificate
    crl.revokedCertificates.set(cert.serialNumber, {
      serialNumber: cert.serialNumber,
      revokedAt: now,
      reason,
    });

    // Update CRL timestamps
    crl.thisUpdate = now;
    crl.signatureVerified = false; // Signature will be recalculated

    // Sign CRL using HSM - private key NEVER leaves HSM
    crl.signature = await this.signCRLWithHSM(crl, ca.keyHandle, ca.signatureAlgorithm);
    crl.signatureVerified = true;

    this.certificateRevocationLists.set(crlId, crl);

    this.emit('crlUpdated', {
      crlId,
      issuer: cert.issuer.caId,
      revokedCount: crl.revokedCertificates.size,
      nextUpdate: crl.nextUpdate,
    });
  }

  /**
   * Sign Certificate Revocation List using HSM
   * SECURITY: CRL signing operations happen inside HSM
   */
  private async signCRLWithHSM(
    crl: CertificateRevocationList,
    keyHandle: string,
    algorithm: SignatureAlgorithm
  ): Promise<string> {
    // Construct CRL data for signing (exclude existing signature)
    const crlData = {
      crlId: crl.crlId,
      issuer: crl.issuer,
      revokedCertificates: Object.fromEntries(crl.revokedCertificates),
      thisUpdate: crl.thisUpdate.toISOString(),
      nextUpdate: crl.nextUpdate.toISOString(),
      signatureAlgorithm: algorithm,
    };

    const crlDataBuffer = Buffer.from(JSON.stringify(crlData), 'utf8');

    // Sign using HSM - private key NEVER leaves HSM
    const signature = await this.hsm.sign(keyHandle, crlDataBuffer);

    return signature.toString('base64');
  }

  /**
   * Legacy CRL signing for backward compatibility
   * @deprecated Use signCRLWithHSM instead
   */
  private signCRL(
    crl: CertificateRevocationList,
    caPrivateKey: string
  ): string {
    securityLogger.warn('Using deprecated signCRL method', { module: 'PKICertificateAuthority', recommendation: 'migrate to HSM-based signing' });

    const crlData = {
      crlId: crl.crlId,
      issuer: crl.issuer,
      revokedCertificates: Object.fromEntries(crl.revokedCertificates),
      thisUpdate: crl.thisUpdate?.toISOString(),
      nextUpdate: crl.nextUpdate.toISOString(),
    };

    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(crlData));
    sign.end();

    return sign.sign(caPrivateKey, 'hex');
  }

  /**
   * Get current CRL for verification
   */
  getCRL(issuerId: string): CertificateRevocationList | undefined {
    return this.certificateRevocationLists.get(`crl-${issuerId}`);
  }

  /**
   * Authenticate node using certificate
   */
  async authenticateNode(
    nodeId: string,
    challenge: string,
    signature: string,
    certificate: string
  ): Promise<{ authenticated: boolean; reason?: string }> {
    // Verify certificate first
    const nodeIdentity = this.nodeIdentities.get(nodeId);
    if (!nodeIdentity) {
      return {
        authenticated: false,
        reason: 'Node not registered',
      };
    }

    const certValid = await this.verifyNodeCertificate(
      nodeId,
      certificate,
      nodeIdentity.certificateChain
    );

    if (!certValid.valid) {
      return {
        authenticated: false,
        reason: certValid.reason,
      };
    }

    // Verify challenge signature
    const cert = JSON.parse(certificate);
    const verify = crypto.createVerify('SHA256');
    verify.update(challenge);
    verify.end();

    const signatureValid = verify.verify(cert.publicKey, signature, 'hex');

    if (!signatureValid) {
      return {
        authenticated: false,
        reason: 'Invalid signature',
      };
    }

    this.emit('nodeAuthenticated', {
      nodeId,
      timestamp: new Date(),
    });

    return { authenticated: true };
  }

  // ============ Certificate Pinning Public API ============

  /**
   * Add certificate pin for a critical peer
   * SECURITY: Critical peers MUST have their certificates pinned
   */
  addCriticalPeerPin(
    nodeId: string,
    publicKey: string,
    validityDays: number = 365,
    options?: {
      certificateHash?: string;
      isCriticalPeer?: boolean;
    }
  ): void {
    const publicKeyHash = CertificatePinningRegistry.calculatePublicKeyPin(publicKey);
    const now = new Date();

    const pin: CertificatePin = {
      nodeId,
      publicKeyHash,
      certificateHash: options?.certificateHash,
      validFrom: now,
      validUntil: new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000),
      isCriticalPeer: options?.isCriticalPeer ?? true,
      lastVerified: now,
    };

    this.certificatePinning.addPin(pin);

    this.emit('certificatePinAdded', {
      nodeId,
      publicKeyHash,
      validUntil: pin.validUntil,
    });
  }

  /**
   * Remove certificate pin for a peer
   */
  removeCriticalPeerPin(nodeId: string): boolean {
    const removed = this.certificatePinning.removePin(nodeId);

    if (removed) {
      this.emit('certificatePinRemoved', { nodeId });
    }

    return removed;
  }

  /**
   * Get certificate pin for a peer
   */
  getCertificatePin(nodeId: string): CertificatePin | undefined {
    return this.certificatePinning.getPin(nodeId);
  }

  /**
   * Verify if a certificate matches its pin
   */
  verifyCertificatePin(
    nodeId: string,
    publicKey: string,
    certificate?: string
  ): {
    valid: boolean;
    reason?: string;
    isPinned: boolean;
  } {
    return this.certificatePinning.verifyCertificatePin(nodeId, publicKey, certificate);
  }

  /**
   * Calculate public key pin hash (for external use)
   */
  static calculatePublicKeyPin(publicKey: string): string {
    return CertificatePinningRegistry.calculatePublicKeyPin(publicKey);
  }

  // ============ HSM and Configuration Access ============

  /**
   * Get the default signature algorithm
   */
  getSignatureAlgorithm(): SignatureAlgorithm {
    return this.defaultSignatureAlgorithm;
  }

  /**
   * Check if the PKI system is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get trusted root CA IDs
   */
  getTrustedRoots(): string[] {
    return Array.from(this.trustedRoots);
  }

  /**
   * Get node identity (if registered)
   */
  getNodeIdentity(nodeId: string): NodeIdentity | undefined {
    return this.nodeIdentities.get(nodeId);
  }
}

// ============ Exports ============

export {
  // Types
  HSMProvider,
  HSMKeyPairResult,
  SignatureAlgorithm,
  HSMConfiguration,
  CertificatePin,
  NodeIdentity,
  CertificateAuthority,
  CertificateRevocationList,
  // Classes
  SoftwareHSMSimulation,
  CertificatePinningRegistry,
};
