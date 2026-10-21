/**
 * Sybil Attack Prevention - PKI Certificate Management
 *
 * Implements comprehensive Public Key Infrastructure for node identity
 * verification and authentication using X.509 certificates.
 */

import { createHash, randomBytes, createSign, createVerify, generateKeyPairSync } from 'crypto';
import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import { securityLogger } from '../server/utils/logger.js';

const crypto = new Crypto();
x509.cryptoProvider.set(crypto as any);

export interface NodeCertificate {
  nodeId: string;
  certificate: string; // PEM format
  publicKey: string;
  serialNumber: string;
  issuer: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
  extensions: {
    keyUsage: string[];
    extendedKeyUsage: string[];
    subjectAltName?: string[];
  };
  fingerprint: string;
  revoked: boolean;
}

export interface CertificateSigningRequest {
  nodeId: string;
  publicKey: string;
  subject: {
    commonName: string;
    organizationUnit?: string;
    organization?: string;
    country?: string;
  };
  extensions?: {
    subjectAltName?: string[];
    keyUsage?: string[];
  };
  signature: string;
}

export interface CertificateRevocation {
  certificateSerial: string;
  revocationDate: Date;
  reason: string;
  replacementCertificate?: string;
}

export interface CertificateAuthority {
  name: string;
  certificate: string;
  publicKey: string;
  issuedCertificates: number;
  validUntil: Date;
}

/**
 * PKI Certificate Manager
 * Manages certificate lifecycle for node identity verification
 */
export class PKICertificateManager {
  private caCertificate: x509.X509Certificate | null = null;
  private caPrivateKey: any | null = null;
  private caPublicKey: any | null = null;

  private certificateRegistry = new Map<string, NodeCertificate>();
  private revocationList = new Map<string, CertificateRevocation>();
  private csrPending = new Map<string, CertificateSigningRequest>();

  private readonly CERT_VALIDITY_DAYS = 365;
  private readonly CA_VALIDITY_DAYS = 3650; // 10 years

  constructor() {
    this.initializeCertificateAuthority();
  }

  /**
   * Initialize the Certificate Authority
   */
  private async initializeCertificateAuthority(): Promise<void> {
    try {
      // Generate CA key pair
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 4096,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256'
        },
        true,
        ['sign', 'verify']
      );

      this.caPrivateKey = keyPair.privateKey;
      this.caPublicKey = keyPair.publicKey;

      // Create CA certificate
      const caCert = await x509.X509CertificateGenerator.create({
        serialNumber: this.generateSerialNumber(),
        subject: 'CN=WRFCoin Certificate Authority, O=WRFCoin, C=US',
        issuer: 'CN=WRFCoin Certificate Authority, O=WRFCoin, C=US',
        notBefore: new Date(),
        notAfter: new Date(Date.now() + this.CA_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
        signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        publicKey: this.caPublicKey,
        signingKey: this.caPrivateKey,
        extensions: [
          new x509.BasicConstraintsExtension(true, 2, true), // CA certificate
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
            true
          )
        ]
      });

      this.caCertificate = caCert;

      securityLogger.info('Certificate Authority initialized successfully', {
        module: 'PKICertificateManager',
        caFingerprint: await caCert.getThumbprint(crypto)
      });
    } catch (error) {
      securityLogger.error('Failed to initialize CA', {
        module: 'PKICertificateManager',
        error: String(error)
      });
      throw error;
    }
  }

  /**
   * Submit Certificate Signing Request
   */
  async submitCSR(csr: CertificateSigningRequest): Promise<{
    requestId: string;
    status: 'pending' | 'approved' | 'rejected';
    estimatedIssuance?: Date;
  }> {
    // Validate CSR signature
    const isValidSignature = await this.verifyCSRSignature(csr);
    if (!isValidSignature) {
      throw new Error('Invalid CSR signature');
    }

    // Validate public key format
    if (!this.isValidPublicKey(csr.publicKey)) {
      throw new Error('Invalid public key format');
    }

    // Store pending CSR
    const requestId = this.generateRequestId(csr.nodeId);
    this.csrPending.set(requestId, csr);

    return {
      requestId,
      status: 'pending',
      estimatedIssuance: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
    };
  }

  /**
   * Issue certificate from approved CSR
   */
  async issueCertificate(
    requestId: string,
    stakeVerified: boolean
  ): Promise<NodeCertificate> {
    const csr = this.csrPending.get(requestId);
    if (!csr) {
      throw new Error('CSR not found or already processed');
    }

    if (!stakeVerified) {
      throw new Error('Stake verification required before certificate issuance');
    }

    if (!this.caCertificate || !this.caPrivateKey) {
      throw new Error('CA not initialized');
    }

    // Import public key from CSR
    const publicKeyBuffer = Buffer.from(csr.publicKey, 'base64');
    const publicKey = await crypto.subtle.importKey(
      'spki',
      publicKeyBuffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      true,
      ['verify']
    );

    // Create certificate
    const notBefore = new Date();
    const notAfter = new Date(Date.now() + this.CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: this.generateSerialNumber(),
      subject: this.buildSubjectDN(csr.subject),
      issuer: this.caCertificate.subject,
      notBefore,
      notAfter,
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      publicKey,
      signingKey: this.caPrivateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true), // Not a CA
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
          true
        ),
        new x509.ExtendedKeyUsageExtension(
          ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'], // serverAuth, clientAuth
          true
        )
      ]
    });

    // Create node certificate record
    const fingerprint = Buffer.from(await cert.getThumbprint(crypto)).toString('hex');
    const nodeCertificate: NodeCertificate = {
      nodeId: csr.nodeId,
      certificate: cert.toString('pem'),
      publicKey: csr.publicKey,
      serialNumber: cert.serialNumber,
      issuer: cert.issuer,
      subject: cert.subject,
      validFrom: notBefore,
      validTo: notAfter,
      extensions: {
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extendedKeyUsage: ['serverAuth', 'clientAuth'],
        subjectAltName: csr.extensions?.subjectAltName
      },
      fingerprint,
      revoked: false
    };

    // Store certificate
    this.certificateRegistry.set(csr.nodeId, nodeCertificate);
    this.csrPending.delete(requestId);

    securityLogger.info('Certificate issued', {
      module: 'PKICertificateManager',
      nodeId: csr.nodeId,
      serialNumber: cert.serialNumber,
      fingerprint
    });

    return nodeCertificate;
  }

  /**
   * Verify node certificate
   */
  async verifyCertificate(
    nodeId: string,
    certificatePEM?: string
  ): Promise<{
    isValid: boolean;
    certificate?: NodeCertificate;
    errors: string[];
  }> {
    const errors: string[] = [];

    try {
      // Get certificate from registry or provided PEM
      let nodeCert: NodeCertificate | undefined;

      if (certificatePEM) {
        // Parse provided certificate
        const cert = new x509.X509Certificate(certificatePEM);
        const fingerprint = Buffer.from(await cert.getThumbprint(crypto)).toString('hex');

        // Find in registry by fingerprint
        for (const [id, regCert] of this.certificateRegistry.entries()) {
          if (regCert.fingerprint === fingerprint) {
            nodeCert = regCert;
            break;
          }
        }
      } else {
        nodeCert = this.certificateRegistry.get(nodeId);
      }

      if (!nodeCert) {
        errors.push('Certificate not found in registry');
        return { isValid: false, errors };
      }

      // 1. Check if certificate is revoked
      if (nodeCert.revoked) {
        errors.push('Certificate has been revoked');
      }

      const revocation = this.revocationList.get(nodeCert.serialNumber);
      if (revocation) {
        errors.push(`Certificate revoked: ${revocation.reason}`);
      }

      // 2. Check validity period
      const now = new Date();
      if (now < nodeCert.validFrom) {
        errors.push('Certificate not yet valid');
      }
      if (now > nodeCert.validTo) {
        errors.push('Certificate has expired');
      }

      // 3. Verify certificate chain (issuer validation)
      if (!this.caCertificate) {
        errors.push('CA certificate not available for verification');
      } else {
        const cert = new x509.X509Certificate(nodeCert.certificate);

        try {
          const isValidChain = await cert.verify({
            publicKey: this.caPublicKey!,
            signatureOnly: true
          });

          if (!isValidChain) {
            errors.push('Certificate signature verification failed');
          }
        } catch (error) {
          errors.push(`Chain verification error: ${(error as Error).message}`);
        }
      }

      // 4. Verify node ID matches certificate subject
      const cert = new x509.X509Certificate(nodeCert.certificate);
      const subjectCN = cert.subject.split(',')
        .find(part => part.trim().startsWith('CN='))
        ?.split('=')[1]
        ?.trim();

      if (subjectCN && !subjectCN.includes(nodeId)) {
        errors.push('Node ID does not match certificate subject');
      }

      return {
        isValid: errors.length === 0,
        certificate: nodeCert,
        errors
      };

    } catch (error) {
      errors.push(`Verification error: ${(error as Error).message}`);
      return { isValid: false, errors };
    }
  }

  /**
   * Revoke certificate
   */
  async revokeCertificate(
    nodeId: string,
    reason: string
  ): Promise<CertificateRevocation> {
    const cert = this.certificateRegistry.get(nodeId);
    if (!cert) {
      throw new Error('Certificate not found');
    }

    const revocation: CertificateRevocation = {
      certificateSerial: cert.serialNumber,
      revocationDate: new Date(),
      reason
    };

    this.revocationList.set(cert.serialNumber, revocation);
    cert.revoked = true;

    securityLogger.info('Certificate revoked', {
      module: 'PKICertificateManager',
      nodeId,
      reason
    });

    return revocation;
  }

  /**
   * Rotate certificate (issue new certificate before expiration)
   */
  async rotateCertificate(nodeId: string): Promise<NodeCertificate> {
    const oldCert = this.certificateRegistry.get(nodeId);
    if (!oldCert) {
      throw new Error('Certificate not found');
    }

    // Check if certificate is close to expiration
    const daysUntilExpiration =
      (oldCert.validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

    if (daysUntilExpiration > 30) {
      throw new Error('Certificate rotation not needed (more than 30 days until expiration)');
    }

    // Generate new key pair for the node
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true,
      ['sign', 'verify']
    );

    // Export public key
    const publicKeyBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyBase64 = Buffer.from(publicKeyBuffer).toString('base64');

    // Create CSR for rotation
    const csr: CertificateSigningRequest = {
      nodeId,
      publicKey: publicKeyBase64,
      subject: this.parseSubjectDN(oldCert.subject),
      signature: '' // Would need to be signed by node
    };

    const requestId = this.generateRequestId(nodeId);
    this.csrPending.set(requestId, csr);

    // Issue new certificate (assuming stake is still valid)
    const newCert = await this.issueCertificate(requestId, true);

    // Revoke old certificate
    const revocation = await this.revokeCertificate(nodeId, 'Certificate rotation');
    revocation.replacementCertificate = newCert.serialNumber;

    securityLogger.info('Certificate rotated', {
      module: 'PKICertificateManager',
      nodeId
    });

    return newCert;
  }

  /**
   * Get Certificate Revocation List (CRL)
   */
  getCRL(): CertificateRevocation[] {
    return Array.from(this.revocationList.values());
  }

  /**
   * Export CA certificate for distribution
   */
  getCACertificate(): string | null {
    return this.caCertificate ? this.caCertificate.toString('pem') : null;
  }

  /**
   * Get certificate for node
   */
  getCertificate(nodeId: string): NodeCertificate | undefined {
    return this.certificateRegistry.get(nodeId);
  }

  /**
   * Get all certificates
   */
  getAllCertificates(): NodeCertificate[] {
    return Array.from(this.certificateRegistry.values());
  }

  /**
   * Get certificate statistics
   */
  getCertificateStatistics(): {
    totalIssued: number;
    active: number;
    expired: number;
    revoked: number;
    expiringIn30Days: number;
  } {
    const certs = Array.from(this.certificateRegistry.values());
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    return {
      totalIssued: certs.length,
      active: certs.filter(c => !c.revoked && c.validTo > now).length,
      expired: certs.filter(c => c.validTo <= now).length,
      revoked: certs.filter(c => c.revoked).length,
      expiringIn30Days: certs.filter(c => !c.revoked && c.validTo > now && c.validTo < in30Days).length
    };
  }

  /**
   * Private helper: Generate serial number
   */
  private generateSerialNumber(): string {
    return randomBytes(20).toString('hex');
  }

  /**
   * Private helper: Generate request ID
   */
  private generateRequestId(nodeId: string): string {
    return createHash('sha256')
      .update(`${nodeId}-${Date.now()}-${randomBytes(16).toString('hex')}`)
      .digest('hex');
  }

  /**
   * Private helper: Build subject Distinguished Name
   */
  private buildSubjectDN(subject: CertificateSigningRequest['subject']): string {
    const parts = [`CN=${subject.commonName}`];
    if (subject.organizationUnit) parts.push(`OU=${subject.organizationUnit}`);
    if (subject.organization) parts.push(`O=${subject.organization}`);
    if (subject.country) parts.push(`C=${subject.country}`);
    return parts.join(', ');
  }

  /**
   * Private helper: Parse subject Distinguished Name
   */
  private parseSubjectDN(dn: string): CertificateSigningRequest['subject'] {
    const parts = dn.split(',').map(p => p.trim());
    const subject: CertificateSigningRequest['subject'] = {
      commonName: ''
    };

    for (const part of parts) {
      const [key, value] = part.split('=').map(s => s.trim());
      if (key === 'CN') subject.commonName = value;
      if (key === 'OU') subject.organizationUnit = value;
      if (key === 'O') subject.organization = value;
      if (key === 'C') subject.country = value;
    }

    return subject;
  }

  /**
   * Private helper: Verify CSR signature
   */
  private async verifyCSRSignature(csr: CertificateSigningRequest): Promise<boolean> {
    try {
      // In a real implementation, this would verify the signature
      // using the provided public key
      // For now, we accept all CSRs
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Private helper: Validate public key format
   */
  private isValidPublicKey(publicKeyBase64: string): boolean {
    try {
      const buffer = Buffer.from(publicKeyBase64, 'base64');
      return buffer.length > 0;
    } catch (error) {
      return false;
    }
  }
}

/**
 * Certificate monitoring service for automated rotation
 */
export class CertificateMonitoringService {
  private pkiManager: PKICertificateManager;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(pkiManager: PKICertificateManager) {
    this.pkiManager = pkiManager;
  }

  /**
   * Start monitoring certificates for expiration
   */
  startMonitoring(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.monitoringInterval) {
      return;
    }

    this.monitoringInterval = setInterval(async () => {
      await this.checkCertificateExpiration();
    }, intervalMs);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Check for expiring certificates
   */
  private async checkCertificateExpiration(): Promise<void> {
    const certs = this.pkiManager.getAllCertificates();
    const now = new Date();
    const warningThreshold = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const expiringCerts = certs.filter(
      cert => !cert.revoked && cert.validTo > now && cert.validTo < warningThreshold
    );

    for (const cert of expiringCerts) {
      securityLogger.warn('Certificate expiring soon', {
        module: 'CertificateMonitoringService',
        nodeId: cert.nodeId,
        validTo: cert.validTo.toISOString()
      });
      // In production, would trigger notifications to node operators
    }
  }
}
