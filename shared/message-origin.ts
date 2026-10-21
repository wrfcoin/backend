/**
 * Message Origin Verification System
 * Implements sender authentication and peer identity validation
 *
 * SECURITY: Critical origin verification:
 * - Sender authentication and verification
 * - Peer identity validation with certificate-based auth
 * - Whitelist/blacklist management for message sources
 * - Certificate-based peer authentication
 * - IP address validation and spoofing prevention
 * - Certificate pinning for critical peers
 * - Accelerated reputation decay for malicious nodes
 * - IP geolocation anomaly detection
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { isIP } from 'net';

/**
 * IP binding information for a peer
 */
export interface PeerIPBinding {
  primaryIP: string;
  allowedIPs: Set<string>;
  lastKnownIP: string;
  ipChangeCount: number;
  lastIPChange: Date;
  geoLocation?: {
    country: string;
    region: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  };
}

/**
 * Certificate pin for trusted peers
 */
export interface CertificatePin {
  peerId: string;
  fingerprint: string; // SHA-256 hash of certificate
  algorithm: 'sha256' | 'sha384' | 'sha512';
  validFrom: Date;
  validTo: Date;
  isBackup: boolean;
  rotationScheduled?: Date;
}

/**
 * Reputation decay configuration per trust level
 */
export interface ReputationDecayConfig {
  baseDecayRate: number; // per hour
  lowTrustMultiplier: number; // multiplier for low-trust nodes
  maliciousAccelerationFactor: number; // additional acceleration for recently malicious nodes
  minimumReputationFloor: number; // floor value
  recentMaliciousWindow: number; // ms window for "recently malicious" status
}

/**
 * Known bad IP ranges (CIDR notation parsed)
 */
interface BadIPRange {
  network: string;
  prefix: number;
  reason: string;
  addedAt: Date;
}

/**
 * IP validation result
 */
export interface IPValidationResult {
  isValid: boolean;
  isKnownBad: boolean;
  hasUnexpectedChange: boolean;
  geoAnomalyDetected: boolean;
  reason?: string;
}

export interface PeerIdentity {
  peerId: string;
  publicKey: Buffer;
  certificate?: PeerCertificate;
  trustLevel: 'unknown' | 'low' | 'medium' | 'high' | 'trusted';
  firstSeen: Date;
  lastSeen: Date;
  reputationScore: number; // 0-100
  verificationMethod: 'publicKey' | 'certificate' | 'attestation';
  ipBinding?: PeerIPBinding;
  lastMaliciousActivity?: Date; // Track when node was last flagged as malicious
  maliciousActivityCount: number; // Count of malicious activities
}

export interface PeerCertificate {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  publicKey: Buffer;
  signature: Buffer;
  serialNumber: string;
}

export interface MessageOriginConfig {
  enableWhitelist: boolean;
  enableBlacklist: boolean;
  requireCertificates: boolean;
  minTrustLevel: 'unknown' | 'low' | 'medium' | 'high' | 'trusted';
  certificateValidationStrict: boolean;
  reputationDecayRate: number; // per hour
  reputationThreshold: number; // minimum score to accept messages
  enableIPValidation: boolean; // Enable IP address validation
  enableCertificatePinning: boolean; // Enable certificate pinning for known peers
  enableGeoAnomalyDetection: boolean; // Enable IP geolocation anomaly detection
  maxIPChangesPerHour: number; // Maximum allowed IP changes before flagging
  reputationDecayConfig: ReputationDecayConfig; // Tiered decay configuration
}

export interface OriginVerificationResult {
  verified: boolean;
  peerId: string;
  trustLevel: string;
  reputationScore: number;
  reason?: string;
  verificationMethod: string;
  ipValidation?: IPValidationResult;
  certificatePinned?: boolean;
}

/**
 * Message Origin Verification Service
 * SECURITY: Comprehensive sender authentication
 */
export class MessageOriginVerifier extends EventEmitter {
  private peers: Map<string, PeerIdentity> = new Map();
  private whitelist: Set<string> = new Set();
  private blacklist: Set<string> = new Set();
  private readonly config: MessageOriginConfig;
  private trustedCAs: Map<string, Buffer> = new Map(); // Certificate authorities
  private reputationDecayTimer: NodeJS.Timeout | null = null;

  // SECURITY: New security data structures
  private certificatePins: Map<string, CertificatePin[]> = new Map(); // Pinned certificates per peer
  private badIPRanges: BadIPRange[] = []; // Known bad IP ranges
  private ipBlacklist: Set<string> = new Set(); // Individual blacklisted IPs
  private geoLocationCache: Map<string, PeerIPBinding['geoLocation']> = new Map(); // IP geolocation cache

  private static readonly DEFAULT_REPUTATION_DECAY_CONFIG: ReputationDecayConfig = {
    baseDecayRate: 1, // 1 point per hour baseline
    lowTrustMultiplier: 10, // Low-trust nodes decay 10x faster
    maliciousAccelerationFactor: 5, // Recently malicious nodes decay 5x faster on top
    minimumReputationFloor: 0, // Minimum reputation value
    recentMaliciousWindow: 24 * 60 * 60 * 1000, // 24 hours
  };

  private static readonly DEFAULT_CONFIG: MessageOriginConfig = {
    enableWhitelist: false,
    enableBlacklist: true,
    requireCertificates: false,
    minTrustLevel: 'low',
    certificateValidationStrict: true,
    reputationDecayRate: 1, // 1 point per hour (legacy, use reputationDecayConfig)
    reputationThreshold: 30,
    enableIPValidation: true,
    enableCertificatePinning: true,
    enableGeoAnomalyDetection: true,
    maxIPChangesPerHour: 5,
    reputationDecayConfig: MessageOriginVerifier.DEFAULT_REPUTATION_DECAY_CONFIG,
  };

  constructor(config?: Partial<MessageOriginConfig>) {
    super();
    this.config = { ...MessageOriginVerifier.DEFAULT_CONFIG, ...config };

    // Start reputation decay timer
    this.startReputationDecay();
  }

  /**
   * Register a new peer identity
   * SECURITY: Establishes peer trust relationship with IP binding
   */
  async registerPeer(
    peerId: string,
    publicKey: Buffer,
    certificate?: PeerCertificate,
    ipAddress?: string
  ): Promise<void> {
    // Validate certificate if provided
    if (certificate) {
      const certValid = await this.validateCertificate(certificate);
      if (!certValid && this.config.certificateValidationStrict) {
        throw new Error('Invalid peer certificate');
      }
    }

    // Validate IP address if provided
    let ipBinding: PeerIPBinding | undefined;
    if (ipAddress) {
      const ipValidation = await this.validateIPAddress(ipAddress);
      if (!ipValidation.isValid) {
        throw new Error(`Invalid IP address: ${ipValidation.reason}`);
      }
      if (ipValidation.isKnownBad) {
        throw new Error(`IP address is from known bad range: ${ipValidation.reason}`);
      }

      ipBinding = {
        primaryIP: ipAddress,
        allowedIPs: new Set([ipAddress]),
        lastKnownIP: ipAddress,
        ipChangeCount: 0,
        lastIPChange: new Date(),
        geoLocation: await this.getGeoLocation(ipAddress),
      };
    }

    const peer: PeerIdentity = {
      peerId,
      publicKey,
      certificate,
      trustLevel: certificate ? 'medium' : 'low',
      firstSeen: new Date(),
      lastSeen: new Date(),
      reputationScore: certificate ? 50 : 20, // Higher initial score with cert
      verificationMethod: certificate ? 'certificate' : 'publicKey',
      ipBinding,
      maliciousActivityCount: 0,
    };

    this.peers.set(peerId, peer);

    this.emit('peerRegistered', {
      peerId,
      trustLevel: peer.trustLevel,
      verificationMethod: peer.verificationMethod,
      ipAddress: ipAddress,
    });
  }

  /**
   * Verify message origin
   * SECURITY: Multi-factor origin verification with IP validation and certificate pinning
   */
  async verifyOrigin(
    peerId: string,
    messageSignature: Buffer,
    message: Buffer,
    sourceIP?: string
  ): Promise<OriginVerificationResult> {
    // Check blacklist first
    if (this.config.enableBlacklist && this.blacklist.has(peerId)) {
      this.emit('originRejected', {
        peerId,
        reason: 'blacklisted',
      });

      return {
        verified: false,
        peerId,
        trustLevel: 'unknown',
        reputationScore: 0,
        reason: 'Peer is blacklisted',
        verificationMethod: 'blacklist',
      };
    }

    // Check whitelist if enabled
    if (this.config.enableWhitelist && !this.whitelist.has(peerId)) {
      this.emit('originRejected', {
        peerId,
        reason: 'not_whitelisted',
      });

      return {
        verified: false,
        peerId,
        trustLevel: 'unknown',
        reputationScore: 0,
        reason: 'Peer not in whitelist',
        verificationMethod: 'whitelist',
      };
    }

    // Get peer identity
    const peer = this.peers.get(peerId);
    if (!peer) {
      this.emit('originRejected', {
        peerId,
        reason: 'unknown_peer',
      });

      return {
        verified: false,
        peerId,
        trustLevel: 'unknown',
        reputationScore: 0,
        reason: 'Unknown peer identity',
        verificationMethod: 'identity',
      };
    }

    // SECURITY: IP Address Validation
    let ipValidationResult: IPValidationResult | undefined;
    if (this.config.enableIPValidation && sourceIP) {
      ipValidationResult = await this.validateIPForPeer(peerId, sourceIP, peer);
      if (!ipValidationResult.isValid || ipValidationResult.isKnownBad) {
        // Flag as malicious activity
        this.recordMaliciousActivity(peerId, 'ip_validation_failure');

        this.emit('originRejected', {
          peerId,
          reason: 'ip_validation_failed',
          ipValidation: ipValidationResult,
        });

        return {
          verified: false,
          peerId,
          trustLevel: peer.trustLevel,
          reputationScore: peer.reputationScore,
          reason: ipValidationResult.reason || 'IP validation failed',
          verificationMethod: 'ip_validation',
          ipValidation: ipValidationResult,
        };
      }

      // Check for geo anomaly
      if (this.config.enableGeoAnomalyDetection && ipValidationResult.geoAnomalyDetected) {
        // Decrease reputation but don't reject outright
        this.updateReputation(peerId, -5);
        this.emit('geoAnomalyDetected', {
          peerId,
          sourceIP,
          ipValidation: ipValidationResult,
        });
      }
    }

    // SECURITY: Certificate Pinning Verification
    let certificatePinned = false;
    if (this.config.enableCertificatePinning && peer.certificate) {
      const pinVerification = this.verifyCertificatePin(peerId, peer.certificate);
      certificatePinned = pinVerification.isPinned;

      if (pinVerification.isPinned && !pinVerification.isValid) {
        // Certificate pin violation - critical security event
        this.recordMaliciousActivity(peerId, 'certificate_pin_violation');

        this.emit('certificatePinViolation', {
          peerId,
          expectedFingerprint: pinVerification.expectedFingerprint,
          actualFingerprint: pinVerification.actualFingerprint,
        });

        return {
          verified: false,
          peerId,
          trustLevel: peer.trustLevel,
          reputationScore: peer.reputationScore,
          reason: 'Certificate pin verification failed',
          verificationMethod: 'certificate_pin',
          certificatePinned: true,
        };
      }
    }

    // Check certificate if required
    if (this.config.requireCertificates && !peer.certificate) {
      this.emit('originRejected', {
        peerId,
        reason: 'no_certificate',
      });

      return {
        verified: false,
        peerId,
        trustLevel: peer.trustLevel,
        reputationScore: peer.reputationScore,
        reason: 'Certificate required but not provided',
        verificationMethod: 'certificate',
      };
    }

    // Validate certificate if present
    if (peer.certificate) {
      const certValid = await this.validateCertificate(peer.certificate);
      if (!certValid) {
        this.emit('originRejected', {
          peerId,
          reason: 'invalid_certificate',
        });

        return {
          verified: false,
          peerId,
          trustLevel: peer.trustLevel,
          reputationScore: peer.reputationScore,
          reason: 'Invalid or expired certificate',
          verificationMethod: 'certificate',
        };
      }
    }

    // Verify signature with peer's public key
    const signatureValid = this.verifySignature(
      message,
      messageSignature,
      peer.publicKey
    );

    if (!signatureValid) {
      // Decrease reputation on failed verification
      this.updateReputation(peerId, -10);
      this.recordMaliciousActivity(peerId, 'invalid_signature');

      this.emit('originRejected', {
        peerId,
        reason: 'invalid_signature',
      });

      return {
        verified: false,
        peerId,
        trustLevel: peer.trustLevel,
        reputationScore: peer.reputationScore,
        reason: 'Invalid message signature',
        verificationMethod: 'signature',
      };
    }

    // Check trust level
    const trustLevels = ['unknown', 'low', 'medium', 'high', 'trusted'];
    const peerTrustIndex = trustLevels.indexOf(peer.trustLevel);
    const minTrustIndex = trustLevels.indexOf(this.config.minTrustLevel);

    if (peerTrustIndex < minTrustIndex) {
      this.emit('originRejected', {
        peerId,
        reason: 'insufficient_trust',
      });

      return {
        verified: false,
        peerId,
        trustLevel: peer.trustLevel,
        reputationScore: peer.reputationScore,
        reason: 'Insufficient trust level',
        verificationMethod: 'trust',
      };
    }

    // Check reputation score
    if (peer.reputationScore < this.config.reputationThreshold) {
      this.emit('originRejected', {
        peerId,
        reason: 'low_reputation',
      });

      return {
        verified: false,
        peerId,
        trustLevel: peer.trustLevel,
        reputationScore: peer.reputationScore,
        reason: 'Reputation score too low',
        verificationMethod: 'reputation',
      };
    }

    // Update peer last seen and IP if provided
    peer.lastSeen = new Date();
    if (sourceIP && peer.ipBinding) {
      this.updatePeerIPBinding(peer, sourceIP);
    }

    // Increase reputation on successful verification
    this.updateReputation(peerId, 1);

    this.emit('originVerified', {
      peerId,
      trustLevel: peer.trustLevel,
      reputationScore: peer.reputationScore,
      sourceIP,
    });

    return {
      verified: true,
      peerId,
      trustLevel: peer.trustLevel,
      reputationScore: peer.reputationScore,
      verificationMethod: peer.verificationMethod,
      ipValidation: ipValidationResult,
      certificatePinned,
    };
  }

  /**
   * Verify digital signature
   * SECURITY: Cryptographic signature verification
   */
  private verifySignature(
    message: Buffer,
    signature: Buffer,
    publicKey: Buffer
  ): boolean {
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(message);
      verify.end();

      const publicKeyObject = crypto.createPublicKey({
        key: publicKey,
        format: 'der',
        type: 'spki',
      });

      return verify.verify(publicKeyObject, signature);
    } catch (error) {
      this.emit('signatureVerificationError', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Validate peer certificate
   * SECURITY: X.509 certificate validation
   */
  private async validateCertificate(
    certificate: PeerCertificate
  ): Promise<boolean> {
    const now = new Date();

    // Check validity period
    if (now < certificate.validFrom || now > certificate.validTo) {
      this.emit('certificateInvalid', {
        reason: 'expired',
        validFrom: certificate.validFrom,
        validTo: certificate.validTo,
      });
      return false;
    }

    // Verify certificate signature if we have the CA
    const ca = this.trustedCAs.get(certificate.issuer);
    if (ca) {
      const certData = this.serializeCertificate(certificate);
      const signatureValid = this.verifySignature(
        certData,
        certificate.signature,
        ca
      );

      if (!signatureValid) {
        this.emit('certificateInvalid', {
          reason: 'invalid_signature',
          issuer: certificate.issuer,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Serialize certificate for signature verification
   */
  private serializeCertificate(certificate: PeerCertificate): Buffer {
    const parts: Buffer[] = [
      Buffer.from(certificate.subject),
      Buffer.from(certificate.issuer),
      Buffer.from(certificate.validFrom.toISOString()),
      Buffer.from(certificate.validTo.toISOString()),
      certificate.publicKey,
      Buffer.from(certificate.serialNumber),
    ];

    return Buffer.concat(parts);
  }

  /**
   * Add peer to whitelist
   * SECURITY: Explicit trust management
   */
  addToWhitelist(peerId: string): void {
    this.whitelist.add(peerId);

    // Upgrade trust level if peer exists
    const peer = this.peers.get(peerId);
    if (peer && peer.trustLevel !== 'trusted') {
      peer.trustLevel = 'trusted';
      peer.reputationScore = Math.max(peer.reputationScore, 80);
    }

    this.emit('whitelistUpdated', { peerId, action: 'added' });
  }

  /**
   * Remove peer from whitelist
   */
  removeFromWhitelist(peerId: string): void {
    this.whitelist.delete(peerId);
    this.emit('whitelistUpdated', { peerId, action: 'removed' });
  }

  /**
   * Add peer to blacklist
   * SECURITY: Block malicious peers
   */
  addToBlacklist(peerId: string, reason?: string): void {
    this.blacklist.add(peerId);

    // Set trust level to unknown and zero reputation
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.trustLevel = 'unknown';
      peer.reputationScore = 0;
    }

    this.emit('blacklistUpdated', { peerId, action: 'added', reason });
  }

  /**
   * Remove peer from blacklist
   */
  removeFromBlacklist(peerId: string): void {
    this.blacklist.delete(peerId);
    this.emit('blacklistUpdated', { peerId, action: 'removed' });
  }

  /**
   * Update peer reputation score
   * SECURITY: Dynamic trust management based on behavior
   */
  updateReputation(peerId: string, delta: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }

    peer.reputationScore = Math.max(
      0,
      Math.min(100, peer.reputationScore + delta)
    );

    // Update trust level based on reputation
    if (peer.reputationScore >= 80) {
      peer.trustLevel = 'high';
    } else if (peer.reputationScore >= 60) {
      peer.trustLevel = 'medium';
    } else if (peer.reputationScore >= 30) {
      peer.trustLevel = 'low';
    } else {
      peer.trustLevel = 'unknown';
    }

    this.emit('reputationUpdated', {
      peerId,
      reputationScore: peer.reputationScore,
      trustLevel: peer.trustLevel,
      delta,
    });
  }

  /**
   * Register a trusted certificate authority
   */
  registerCA(issuer: string, publicKey: Buffer): void {
    this.trustedCAs.set(issuer, publicKey);
    this.emit('caRegistered', { issuer });
  }

  // ============================================================================
  // IP ADDRESS VALIDATION METHODS
  // ============================================================================

  /**
   * Validate IP address format and check against known bad ranges
   * SECURITY: Prevents IP spoofing and blocks known malicious IPs
   */
  async validateIPAddress(ipAddress: string): Promise<IPValidationResult> {
    // Validate IP format using Node.js net module
    const ipVersion = isIP(ipAddress);
    if (ipVersion === 0) {
      return {
        isValid: false,
        isKnownBad: false,
        hasUnexpectedChange: false,
        geoAnomalyDetected: false,
        reason: 'Invalid IP address format',
      };
    }

    // Check if IP is in blacklist
    if (this.ipBlacklist.has(ipAddress)) {
      return {
        isValid: false,
        isKnownBad: true,
        hasUnexpectedChange: false,
        geoAnomalyDetected: false,
        reason: 'IP address is blacklisted',
      };
    }

    // Check against known bad IP ranges
    for (const range of this.badIPRanges) {
      if (this.isIPInRange(ipAddress, range.network, range.prefix)) {
        return {
          isValid: false,
          isKnownBad: true,
          hasUnexpectedChange: false,
          geoAnomalyDetected: false,
          reason: `IP in known bad range: ${range.reason}`,
        };
      }
    }

    // Reject private/reserved IPs in production mode (but allow for localhost development)
    if (this.isPrivateIP(ipAddress) && process.env.NODE_ENV === 'production') {
      return {
        isValid: false,
        isKnownBad: false,
        hasUnexpectedChange: false,
        geoAnomalyDetected: false,
        reason: 'Private IP addresses not allowed in production',
      };
    }

    return {
      isValid: true,
      isKnownBad: false,
      hasUnexpectedChange: false,
      geoAnomalyDetected: false,
    };
  }

  /**
   * Validate IP address for a specific peer with binding checks
   * SECURITY: Prevents IP spoofing by verifying IP-to-node binding
   */
  async validateIPForPeer(
    peerId: string,
    sourceIP: string,
    peer: PeerIdentity
  ): Promise<IPValidationResult> {
    // First, validate the IP format and check against blacklists
    const baseValidation = await this.validateIPAddress(sourceIP);
    if (!baseValidation.isValid || baseValidation.isKnownBad) {
      return baseValidation;
    }

    // If peer has IP binding, validate against it
    if (peer.ipBinding) {
      const binding = peer.ipBinding;

      // Check if IP has changed unexpectedly
      if (!binding.allowedIPs.has(sourceIP) && sourceIP !== binding.lastKnownIP) {
        // Check rate of IP changes
        const hoursSinceLastChange =
          (Date.now() - binding.lastIPChange.getTime()) / (1000 * 60 * 60);

        if (hoursSinceLastChange < 1 && binding.ipChangeCount >= this.config.maxIPChangesPerHour) {
          return {
            isValid: false,
            isKnownBad: false,
            hasUnexpectedChange: true,
            geoAnomalyDetected: false,
            reason: `Too many IP changes: ${binding.ipChangeCount} in last hour`,
          };
        }

        // Check for geo anomaly if enabled
        let geoAnomalyDetected = false;
        if (this.config.enableGeoAnomalyDetection && binding.geoLocation) {
          const newGeoLocation = await this.getGeoLocation(sourceIP);
          if (newGeoLocation) {
            geoAnomalyDetected = await this.detectGeoAnomaly(binding.geoLocation, newGeoLocation);
          }
        }

        return {
          isValid: true, // Allow but flag the change
          isKnownBad: false,
          hasUnexpectedChange: true,
          geoAnomalyDetected,
          reason: geoAnomalyDetected
            ? 'IP change with geographic anomaly detected'
            : 'IP address changed from known binding',
        };
      }
    }

    return {
      isValid: true,
      isKnownBad: false,
      hasUnexpectedChange: false,
      geoAnomalyDetected: false,
    };
  }

  /**
   * Check if IP address is in a CIDR range
   */
  private isIPInRange(ip: string, network: string, prefix: number): boolean {
    const ipVersion = isIP(ip);
    const networkVersion = isIP(network);

    if (ipVersion !== networkVersion || ipVersion === 0) {
      return false;
    }

    if (ipVersion === 4) {
      return this.isIPv4InRange(ip, network, prefix);
    } else {
      return this.isIPv6InRange(ip, network, prefix);
    }
  }

  /**
   * Check if IPv4 address is in range
   */
  private isIPv4InRange(ip: string, network: string, prefix: number): boolean {
    const ipNum = this.ipv4ToNumber(ip);
    const networkNum = this.ipv4ToNumber(network);
    const mask = 0xffffffff << (32 - prefix);

    return (ipNum & mask) === (networkNum & mask);
  }

  /**
   * Convert IPv4 address to number
   */
  private ipv4ToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  }

  /**
   * Check if IPv6 address is in range (simplified implementation)
   */
  private isIPv6InRange(ip: string, network: string, prefix: number): boolean {
    const ipBytes = this.ipv6ToBytes(ip);
    const networkBytes = this.ipv6ToBytes(network);

    const fullBytes = Math.floor(prefix / 8);
    const remainingBits = prefix % 8;

    // Compare full bytes
    for (let i = 0; i < fullBytes; i++) {
      if (ipBytes[i] !== networkBytes[i]) {
        return false;
      }
    }

    // Compare remaining bits
    if (remainingBits > 0 && fullBytes < 16) {
      const mask = 0xff << (8 - remainingBits);
      if ((ipBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Convert IPv6 address to bytes
   */
  private ipv6ToBytes(ip: string): number[] {
    // Expand :: notation
    let expandedIP = ip;
    if (ip.includes('::')) {
      const parts = ip.split('::');
      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      const middle = Array(missing).fill('0');
      expandedIP = [...left, ...middle, ...right].join(':');
    }

    const parts = expandedIP.split(':');
    const bytes: number[] = [];

    for (const part of parts) {
      const num = parseInt(part || '0', 16);
      bytes.push((num >> 8) & 0xff);
      bytes.push(num & 0xff);
    }

    return bytes;
  }

  /**
   * Check if IP is a private/reserved address
   */
  private isPrivateIP(ip: string): boolean {
    const ipVersion = isIP(ip);

    if (ipVersion === 4) {
      const parts = ip.split('.').map(Number);

      // 10.0.0.0/8
      if (parts[0] === 10) return true;

      // 172.16.0.0/12
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

      // 192.168.0.0/16
      if (parts[0] === 192 && parts[1] === 168) return true;

      // 127.0.0.0/8 (loopback)
      if (parts[0] === 127) return true;

      // 169.254.0.0/16 (link-local)
      if (parts[0] === 169 && parts[1] === 254) return true;
    } else if (ipVersion === 6) {
      const lower = ip.toLowerCase();

      // ::1 (loopback)
      if (lower === '::1') return true;

      // fe80::/10 (link-local)
      if (lower.startsWith('fe80:')) return true;

      // fc00::/7 (unique local)
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    }

    return false;
  }

  /**
   * Add IP to blacklist
   * SECURITY: Block specific IP addresses
   */
  addIPToBlacklist(ip: string, reason?: string): void {
    this.ipBlacklist.add(ip);
    this.emit('ipBlacklisted', { ip, reason });
  }

  /**
   * Remove IP from blacklist
   */
  removeIPFromBlacklist(ip: string): void {
    this.ipBlacklist.delete(ip);
    this.emit('ipUnblacklisted', { ip });
  }

  /**
   * Add a known bad IP range
   * SECURITY: Block entire IP ranges (e.g., known malicious networks)
   */
  addBadIPRange(network: string, prefix: number, reason: string): void {
    this.badIPRanges.push({
      network,
      prefix,
      reason,
      addedAt: new Date(),
    });
    this.emit('badIPRangeAdded', { network, prefix, reason });
  }

  /**
   * Add allowed IP for a peer
   */
  addAllowedIPForPeer(peerId: string, ip: string): void {
    const peer = this.peers.get(peerId);
    if (peer?.ipBinding) {
      peer.ipBinding.allowedIPs.add(ip);
      this.emit('peerIPAllowed', { peerId, ip });
    }
  }

  /**
   * Update peer IP binding when IP changes
   */
  private updatePeerIPBinding(peer: PeerIdentity, newIP: string): void {
    if (!peer.ipBinding) return;

    const binding = peer.ipBinding;

    if (newIP !== binding.lastKnownIP) {
      const now = Date.now();
      const hoursSinceLastChange =
        (now - binding.lastIPChange.getTime()) / (1000 * 60 * 60);

      // Reset counter if more than an hour has passed
      if (hoursSinceLastChange >= 1) {
        binding.ipChangeCount = 1;
      } else {
        binding.ipChangeCount++;
      }

      binding.lastKnownIP = newIP;
      binding.lastIPChange = new Date();

      this.emit('peerIPChanged', {
        peerId: peer.peerId,
        previousIP: binding.lastKnownIP,
        newIP,
        changeCount: binding.ipChangeCount,
      });
    }
  }

  // ============================================================================
  // CERTIFICATE PINNING METHODS
  // ============================================================================

  /**
   * Pin a certificate for a peer
   * SECURITY: Establishes certificate pinning for known good peers
   */
  pinCertificate(
    peerId: string,
    certificate: PeerCertificate,
    isBackup: boolean = false,
    rotationScheduled?: Date
  ): void {
    const fingerprint = this.calculateCertificateFingerprint(certificate);

    const pin: CertificatePin = {
      peerId,
      fingerprint,
      algorithm: 'sha256',
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      isBackup,
      rotationScheduled,
    };

    const existingPins = this.certificatePins.get(peerId) || [];
    existingPins.push(pin);
    this.certificatePins.set(peerId, existingPins);

    this.emit('certificatePinned', {
      peerId,
      fingerprint,
      isBackup,
      validTo: certificate.validTo,
    });
  }

  /**
   * Remove a certificate pin
   */
  unpinCertificate(peerId: string, fingerprint: string): void {
    const pins = this.certificatePins.get(peerId);
    if (pins) {
      const filtered = pins.filter(pin => pin.fingerprint !== fingerprint);
      if (filtered.length > 0) {
        this.certificatePins.set(peerId, filtered);
      } else {
        this.certificatePins.delete(peerId);
      }
      this.emit('certificateUnpinned', { peerId, fingerprint });
    }
  }

  /**
   * Rotate certificate pin (for scheduled rotations)
   */
  rotateCertificatePin(peerId: string, newCertificate: PeerCertificate): void {
    const pins = this.certificatePins.get(peerId);
    if (!pins || pins.length === 0) {
      // No existing pins, just add new one
      this.pinCertificate(peerId, newCertificate, false);
      return;
    }

    // Mark old primary as backup (temporary)
    const primaryPins = pins.filter(p => !p.isBackup);
    for (const pin of primaryPins) {
      pin.isBackup = true;
    }

    // Add new certificate as primary
    this.pinCertificate(peerId, newCertificate, false);

    this.emit('certificatePinRotated', {
      peerId,
      newFingerprint: this.calculateCertificateFingerprint(newCertificate),
    });
  }

  /**
   * Verify certificate against pinned certificates
   * SECURITY: Ensures certificate matches expected fingerprint
   */
  private verifyCertificatePin(
    peerId: string,
    certificate: PeerCertificate
  ): {
    isPinned: boolean;
    isValid: boolean;
    expectedFingerprint?: string;
    actualFingerprint?: string;
  } {
    const pins = this.certificatePins.get(peerId);

    if (!pins || pins.length === 0) {
      // No pins for this peer
      return { isPinned: false, isValid: true };
    }

    const actualFingerprint = this.calculateCertificateFingerprint(certificate);
    const now = new Date();

    // Check against all valid pins (primary and backup)
    for (const pin of pins) {
      // Skip expired pins
      if (now > pin.validTo) continue;

      if (pin.fingerprint === actualFingerprint) {
        return {
          isPinned: true,
          isValid: true,
          expectedFingerprint: pin.fingerprint,
          actualFingerprint,
        };
      }
    }

    // Pin exists but doesn't match - violation!
    return {
      isPinned: true,
      isValid: false,
      expectedFingerprint: pins[0]?.fingerprint,
      actualFingerprint,
    };
  }

  /**
   * Calculate SHA-256 fingerprint of a certificate
   */
  private calculateCertificateFingerprint(certificate: PeerCertificate): string {
    const certData = this.serializeCertificate(certificate);
    return crypto.createHash('sha256').update(certData).digest('hex');
  }

  /**
   * Get all pinned certificates for a peer
   */
  getPinnedCertificates(peerId: string): CertificatePin[] {
    return this.certificatePins.get(peerId) || [];
  }

  /**
   * Check if peer has pinned certificates
   */
  hasPinnedCertificates(peerId: string): boolean {
    const pins = this.certificatePins.get(peerId);
    return pins !== undefined && pins.length > 0;
  }

  // ============================================================================
  // GEOLOCATION AND ANOMALY DETECTION METHODS
  // ============================================================================

  /**
   * Get geolocation for an IP address
   * Note: In production, this would integrate with a geolocation service
   */
  async getGeoLocation(ip: string): Promise<PeerIPBinding['geoLocation'] | undefined> {
    // Check cache first
    const cached = this.geoLocationCache.get(ip);
    if (cached) {
      return cached;
    }

    // In production, this would call an external geolocation service
    // For now, we provide a stub implementation
    // Example services: MaxMind GeoIP, IP-API, etc.

    // Placeholder - in real implementation, integrate with geolocation service
    const geoLocation: PeerIPBinding['geoLocation'] = {
      country: 'UNKNOWN',
      region: 'UNKNOWN',
    };

    // Cache the result
    this.geoLocationCache.set(ip, geoLocation);

    return geoLocation;
  }

  /**
   * Detect geographic anomaly between two locations
   * SECURITY: Identifies impossible travel or location inconsistencies
   */
  private async detectGeoAnomaly(
    previousLocation: PeerIPBinding['geoLocation'],
    newLocation: PeerIPBinding['geoLocation']
  ): Promise<boolean> {
    if (!previousLocation || !newLocation) {
      return false;
    }

    // Different country is a potential anomaly
    if (previousLocation.country !== newLocation.country) {
      // Check if both locations have coordinates for distance calculation
      if (
        previousLocation.latitude !== undefined &&
        previousLocation.longitude !== undefined &&
        newLocation.latitude !== undefined &&
        newLocation.longitude !== undefined
      ) {
        const distance = this.calculateGeoDistance(
          previousLocation.latitude,
          previousLocation.longitude,
          newLocation.latitude,
          newLocation.longitude
        );

        // If distance is greater than 500km, it's an anomaly worth noting
        // This could indicate a VPN/proxy change or impossible travel
        if (distance > 500) {
          return true;
        }
      } else {
        // No coordinates but different country - flag as anomaly
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate distance between two geographic points (Haversine formula)
   */
  private calculateGeoDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.degreesToRadians(lat2 - lat1);
    const dLon = this.degreesToRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.degreesToRadians(lat1)) *
        Math.cos(this.degreesToRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  }

  /**
   * Convert degrees to radians
   */
  private degreesToRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Set geolocation for an IP (for external geolocation service integration)
   */
  setGeoLocation(ip: string, geoLocation: PeerIPBinding['geoLocation']): void {
    this.geoLocationCache.set(ip, geoLocation);

    // Update any peer bindings that use this IP
    for (const peer of this.peers.values()) {
      if (peer.ipBinding?.lastKnownIP === ip) {
        peer.ipBinding.geoLocation = geoLocation;
      }
    }
  }

  /**
   * Clear geolocation cache
   */
  clearGeoLocationCache(): void {
    this.geoLocationCache.clear();
  }

  /**
   * Start reputation decay mechanism
   * SECURITY: Prevents stale high reputation scores with accelerated decay for low-trust nodes
   */
  private startReputationDecay(): void {
    this.reputationDecayTimer = setInterval(() => {
      const decayConfig = this.config.reputationDecayConfig;
      const now = Date.now();

      for (const peer of this.peers.values()) {
        // Decay reputation for inactive peers
        const hoursSinceLastSeen =
          (now - peer.lastSeen.getTime()) / (1000 * 60 * 60);

        if (hoursSinceLastSeen > 1) {
          // Calculate tiered decay rate based on trust level
          let decayMultiplier = 1;

          // Low-trust nodes decay faster (10x by default)
          if (peer.trustLevel === 'unknown' || peer.trustLevel === 'low') {
            decayMultiplier = decayConfig.lowTrustMultiplier;
          }

          // Recently malicious nodes decay even faster (additional 5x by default)
          if (peer.lastMaliciousActivity) {
            const timeSinceMalicious = now - peer.lastMaliciousActivity.getTime();
            if (timeSinceMalicious < decayConfig.recentMaliciousWindow) {
              decayMultiplier *= decayConfig.maliciousAccelerationFactor;
            }
          }

          // Apply higher decay for nodes with multiple malicious activities
          if (peer.maliciousActivityCount > 0) {
            decayMultiplier *= Math.min(3, 1 + peer.maliciousActivityCount * 0.5);
          }

          const decay = decayConfig.baseDecayRate * hoursSinceLastSeen * decayMultiplier;
          peer.reputationScore = Math.max(
            decayConfig.minimumReputationFloor,
            peer.reputationScore - decay
          );

          // Update trust level based on new reputation
          this.updateTrustLevelFromReputation(peer);

          // Emit decay event for monitoring
          if (decay > 0) {
            this.emit('reputationDecayed', {
              peerId: peer.peerId,
              decay,
              decayMultiplier,
              newReputationScore: peer.reputationScore,
              trustLevel: peer.trustLevel,
            });
          }
        }
      }
    }, 3600000); // Every hour
  }

  /**
   * Update trust level based on reputation score
   * SECURITY: Automatic trust level adjustment
   */
  private updateTrustLevelFromReputation(peer: PeerIdentity): void {
    const previousTrustLevel = peer.trustLevel;

    if (peer.reputationScore >= 80) {
      peer.trustLevel = 'high';
    } else if (peer.reputationScore >= 60) {
      peer.trustLevel = 'medium';
    } else if (peer.reputationScore >= 30) {
      peer.trustLevel = 'low';
    } else {
      peer.trustLevel = 'unknown';
    }

    // Don't downgrade from 'trusted' automatically - that requires explicit action
    if (previousTrustLevel === 'trusted' && peer.reputationScore >= 30) {
      peer.trustLevel = 'trusted';
    }

    if (previousTrustLevel !== peer.trustLevel) {
      this.emit('trustLevelChanged', {
        peerId: peer.peerId,
        previousTrustLevel,
        newTrustLevel: peer.trustLevel,
        reputationScore: peer.reputationScore,
      });
    }
  }

  /**
   * Record malicious activity for a peer
   * SECURITY: Track malicious behavior for accelerated reputation decay
   */
  private recordMaliciousActivity(peerId: string, activityType: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.lastMaliciousActivity = new Date();
    peer.maliciousActivityCount++;

    // Immediate reputation penalty based on activity type
    const penalties: Record<string, number> = {
      ip_validation_failure: 15,
      certificate_pin_violation: 30,
      invalid_signature: 10,
      unexpected_ip_change: 5,
      geo_anomaly: 5,
    };

    const penalty = penalties[activityType] || 10;
    this.updateReputation(peerId, -penalty);

    this.emit('maliciousActivityRecorded', {
      peerId,
      activityType,
      totalCount: peer.maliciousActivityCount,
      penalty,
    });

    // Auto-blacklist if too many malicious activities
    if (peer.maliciousActivityCount >= 5) {
      this.addToBlacklist(peerId, `Exceeded malicious activity threshold: ${peer.maliciousActivityCount} incidents`);
    }
  }

  /**
   * Get peer statistics
   */
  getPeerStatistics(): {
    totalPeers: number;
    whitelistedPeers: number;
    blacklistedPeers: number;
    averageReputation: number;
    trustLevelDistribution: Record<string, number>;
  } {
    let totalReputation = 0;
    const trustLevelDistribution: Record<string, number> = {
      unknown: 0,
      low: 0,
      medium: 0,
      high: 0,
      trusted: 0,
    };

    for (const peer of this.peers.values()) {
      totalReputation += peer.reputationScore;
      trustLevelDistribution[peer.trustLevel]++;
    }

    return {
      totalPeers: this.peers.size,
      whitelistedPeers: this.whitelist.size,
      blacklistedPeers: this.blacklist.size,
      averageReputation:
        this.peers.size > 0 ? totalReputation / this.peers.size : 0,
      trustLevelDistribution,
    };
  }

  /**
   * Get peer identity information
   */
  getPeerIdentity(peerId: string): PeerIdentity | null {
    return this.peers.get(peerId) || null;
  }

  /**
   * Remove a peer
   */
  removePeer(peerId: string): boolean {
    const removed = this.peers.delete(peerId);
    if (removed) {
      this.emit('peerRemoved', { peerId });
    }
    return removed;
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    if (this.reputationDecayTimer) {
      clearInterval(this.reputationDecayTimer);
      this.reputationDecayTimer = null;
    }

    this.peers.clear();
    this.whitelist.clear();
    this.blacklist.clear();
    this.trustedCAs.clear();

    // Clear new security data structures
    this.certificatePins.clear();
    this.badIPRanges.length = 0;
    this.ipBlacklist.clear();
    this.geoLocationCache.clear();

    this.emit('shutdown');
  }
}

/**
 * Helper function to generate peer ID from public key
 */
export function generatePeerId(publicKey: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .substring(0, 40); // 40-character hex string
}
