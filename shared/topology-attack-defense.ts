/**
 * Network Topology Attack Defense System
 *
 * Comprehensive defense against topology-based attacks including:
 * - Topology obfuscation with decoy nodes
 * - Dynamic network restructuring
 * - Geographic distribution enforcement
 * - Subnet diversity requirements
 * - Adaptive topology management
 *
 * SECURITY: Addresses Task 100.13 vulnerabilities
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { securityLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface TopologyDefenseConfig {
  /** Maximum peers allowed from the same /24 subnet */
  maxPeersPerSubnet: number;
  /** Interval for peer rotation (dynamic restructuring) */
  churnInterval: number;
  /** Percentage of peers to rotate during churn (0.0 to 1.0) */
  churnRate: number;
  /** Number of decoy peers to include in peer lists */
  decoyCount: number;
  /** Maximum anomaly score before banning */
  anomalyThreshold: number;
  /** Duration to ban suspicious IPs (ms) */
  banDuration: number;
  /** Minimum required geographic regions */
  minGeographicRegions: number;
  /** Minimum required unique ASNs */
  minUniqueASNs: number;
  /** Connection attempt rate limit (per minute) */
  connectionRateLimit: number;
  /** Enable topology obfuscation */
  enableObfuscation: boolean;
  /** Enable dynamic restructuring */
  enableRestructuring: boolean;
  /** Enforce geographic diversity (block connections that violate requirements) */
  enforceGeographicDiversity: boolean;
  /** Minimum redundant connections for critical nodes */
  minRedundantConnections: number;
  /** Betweenness centrality threshold to identify critical nodes */
  criticalBetweennessThreshold: number;
}

export interface PeerMetadata {
  peerId: string;
  address: string;
  ip: string;
  port: number;
  subnet: string;
  asn?: string;
  region?: string;
  country?: string;
  trustScore: number;
  isDecoy: boolean;
  connectedSince?: Date;
  lastSeen: Date;
  messageCount: number;
  latency: number;
}

export interface DecoyPeer {
  peerId: string;
  address: string;
  ip: string;
  port: number;
  subnet: string;
  region: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ConnectionAttempt {
  ip: string;
  timestamp: Date;
  success: boolean;
  reason?: string;
}

export interface BanRecord {
  ip: string;
  reason: string;
  bannedAt: Date;
  expiresAt: Date;
  violationCount: number;
}

export interface TopologyMetrics {
  totalPeers: number;
  activePeers: number;
  decoyPeers: number;
  bannedIPs: number;
  uniqueSubnets: number;
  uniqueRegions: number;
  uniqueASNs: number;
  averageTrustScore: number;
  churnCount: number;
  lastChurnTime?: Date;
  healthScore: number;
}

export interface ChurnResult {
  peersRemoved: string[];
  peersAdded: string[];
  timestamp: Date;
  reason: string;
}

export interface TopologyAlert {
  alertId: string;
  type: TopologyAlertType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  affectedPeers: string[];
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export enum TopologyAlertType {
  SUBNET_CONCENTRATION = 'SUBNET_CONCENTRATION',
  GEOGRAPHIC_ISOLATION = 'GEOGRAPHIC_ISOLATION',
  ASN_CONCENTRATION = 'ASN_CONCENTRATION',
  RAPID_CONNECTION_ATTEMPTS = 'RAPID_CONNECTION_ATTEMPTS',
  TOPOLOGY_CRAWLING_DETECTED = 'TOPOLOGY_CRAWLING_DETECTED',
  STRATEGIC_NODE_PLACEMENT = 'STRATEGIC_NODE_PLACEMENT',
  TRUST_SCORE_ANOMALY = 'TRUST_SCORE_ANOMALY',
  CHURN_THRESHOLD_EXCEEDED = 'CHURN_THRESHOLD_EXCEEDED',
  CRITICAL_NODE_AT_RISK = 'CRITICAL_NODE_AT_RISK',
  GEOGRAPHIC_DIVERSITY_VIOLATION = 'GEOGRAPHIC_DIVERSITY_VIOLATION',
  ASN_DIVERSITY_VIOLATION = 'ASN_DIVERSITY_VIOLATION',
  THREAT_LEVEL_ELEVATED = 'THREAT_LEVEL_ELEVATED',
}

/**
 * Threat level for adaptive topology management
 */
export enum ThreatLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Geographic region information for a peer
 */
export interface GeoInfo {
  region: string;
  country?: string;
  asn?: number;
  asnName?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: TopologyDefenseConfig = {
  maxPeersPerSubnet: 2,
  churnInterval: 10 * 60 * 1000, // 10 minutes
  churnRate: 0.1, // 10% rotation
  decoyCount: 10,
  anomalyThreshold: 10,
  banDuration: 60 * 60 * 1000, // 1 hour
  minGeographicRegions: 3,
  minUniqueASNs: 5,
  connectionRateLimit: 10, // per minute
  enableObfuscation: true,
  enableRestructuring: true,
  enforceGeographicDiversity: true,
  minRedundantConnections: 3,
  criticalBetweennessThreshold: 0.1,
};

// ============================================================================
// Topology Attack Defense System
// ============================================================================

export class TopologyAttackDefense extends EventEmitter {
  private config: TopologyDefenseConfig;
  private peers: Map<string, PeerMetadata> = new Map();
  private activePeers: Set<string> = new Set();
  private decoyPeers: Map<string, DecoyPeer> = new Map();
  private bannedIPs: Map<string, BanRecord> = new Map();
  private connectionAttempts: Map<string, ConnectionAttempt[]> = new Map();
  private suspiciousScores: Map<string, number> = new Map();
  private alerts: TopologyAlert[] = [];

  private lastChurnTime: Date = new Date();
  private churnCount: number = 0;
  private churnTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private threatAssessmentTimer?: NodeJS.Timeout;

  // Critical node protection
  private criticalNodes: Set<string> = new Set();

  // Adaptive topology management
  private currentThreatLevel: ThreatLevel = ThreatLevel.LOW;
  private baseConfig: TopologyDefenseConfig;
  private lastThreatAssessment: Date = new Date();

  // IP to geographic info cache
  private geoCache: Map<string, GeoInfo> = new Map();

  constructor(config: Partial<TopologyDefenseConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.baseConfig = { ...this.config }; // Store original for adaptive management
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the topology defense system
   */
  public start(): void {
    securityLogger.info('Starting topology attack defense system', { module: 'TopologyDefense' });

    // Generate initial decoy peers
    if (this.config.enableObfuscation) {
      this.generateDecoyPeers();
    }

    // Start churn timer for dynamic restructuring
    if (this.config.enableRestructuring) {
      this.churnTimer = setInterval(
        () => this.performChurn(),
        this.config.churnInterval
      );
    }

    // Start cleanup timer for expired bans and decoys
    this.cleanupTimer = setInterval(
      () => this.performCleanup(),
      60000 // Every minute
    );

    this.emit('started');
  }

  /**
   * Stop the topology defense system
   */
  public stop(): void {
    if (this.churnTimer) {
      clearInterval(this.churnTimer);
      this.churnTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    securityLogger.info('Stopped topology attack defense system', { module: 'TopologyDefense' });
    this.emit('stopped');
  }

  // ============================================================================
  // Decoy Peer Management (Topology Obfuscation)
  // ============================================================================

  /**
   * Generate fake decoy peers to mislead topology crawlers
   */
  private generateDecoyPeers(): void {
    const regions = ['us-east', 'us-west', 'eu-west', 'eu-central', 'asia-east', 'asia-south'];

    for (let i = 0; i < this.config.decoyCount; i++) {
      const decoy = this.createDecoyPeer(regions[i % regions.length]);
      this.decoyPeers.set(decoy.peerId, decoy);
    }

    securityLogger.info('Generated decoy peers', { module: 'TopologyDefense', count: this.config.decoyCount });
  }

  /**
   * Create a single decoy peer
   */
  private createDecoyPeer(region: string): DecoyPeer {
    const ip = this.generateRandomIP();
    const port = 8000 + crypto.randomInt(1000);
    const peerId = `decoy_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date();

    return {
      peerId,
      address: `${ip}:${port}`,
      ip,
      port,
      subnet: this.extractSubnet(ip),
      region,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24 hours
    };
  }

  /**
   * Generate a random but realistic-looking IP address
   */
  private generateRandomIP(): string {
    // Avoid reserved ranges
    const firstOctet = crypto.randomInt(1, 224);
    if (firstOctet === 10 || firstOctet === 127) {
      return this.generateRandomIP(); // Retry for reserved ranges
    }

    return `${firstOctet}.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(256)}`;
  }

  /**
   * Rotate decoy peers periodically
   */
  public rotateDecoyPeers(): void {
    const expiredDecoys = Array.from(this.decoyPeers.values())
      .filter(d => d.expiresAt <= new Date());

    for (const decoy of expiredDecoys) {
      this.decoyPeers.delete(decoy.peerId);
      const newDecoy = this.createDecoyPeer(decoy.region);
      this.decoyPeers.set(newDecoy.peerId, newDecoy);
    }

    if (expiredDecoys.length > 0) {
      securityLogger.info('Rotated decoy peers', { module: 'TopologyDefense', count: expiredDecoys.length });
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Evaluate if an incoming connection should be accepted
   */
  public shouldAcceptConnection(address: string): { accept: boolean; reason?: string } {
    const ip = this.extractIP(address);

    // 1. Check if IP is banned
    const banRecord = this.bannedIPs.get(ip);
    if (banRecord && banRecord.expiresAt > new Date()) {
      this.recordConnectionAttempt(ip, false, 'IP is banned');
      return { accept: false, reason: `IP banned until ${banRecord.expiresAt.toISOString()}` };
    }

    // 2. Check rate limiting
    if (this.isRateLimited(ip)) {
      this.incrementSuspiciousScore(ip, 2);
      this.recordConnectionAttempt(ip, false, 'Rate limited');
      return { accept: false, reason: 'Connection rate limit exceeded' };
    }

    // 3. Check subnet diversity
    const subnet = this.extractSubnet(ip);
    const subnetCount = this.countPeersInSubnet(subnet);
    if (subnetCount >= this.config.maxPeersPerSubnet) {
      this.incrementSuspiciousScore(ip, 1);
      this.recordConnectionAttempt(ip, false, 'Subnet limit reached');
      return { accept: false, reason: `Subnet limit reached (${subnetCount}/${this.config.maxPeersPerSubnet})` };
    }

    // 4. Check geographic/ASN diversity enforcement (BLOCKING)
    if (this.config.enforceGeographicDiversity) {
      const geoCheck = this.checkGeographicEnforcement(ip);
      if (!geoCheck.accept) {
        this.recordConnectionAttempt(ip, false, geoCheck.reason || 'Geographic diversity violation');
        return geoCheck;
      }
    }

    // 5. Check for topology crawling behavior
    if (this.detectTopologyCrawling(ip)) {
      this.banIP(ip, 'Topology crawling detected');
      this.recordConnectionAttempt(ip, false, 'Topology crawling');
      return { accept: false, reason: 'Suspicious topology crawling behavior detected' };
    }

    this.recordConnectionAttempt(ip, true);
    return { accept: true };
  }

  /**
   * Check if accepting a new connection would violate geographic diversity requirements
   * This is a BLOCKING check - connections are rejected if they violate diversity
   */
  public checkGeographicEnforcement(ip: string): { accept: boolean; reason?: string } {
    // Get geographic info for the incoming IP
    const geoInfo = this.getGeoInfoForIP(ip);

    // Get current diversity metrics
    const metrics = this.getMetrics();

    // Check if we have minimum peers to enforce diversity
    const minPeersForEnforcement = Math.max(
      this.config.minGeographicRegions,
      this.config.minUniqueASNs
    );

    if (this.activePeers.size < minPeersForEnforcement) {
      // Not enough peers yet - allow connection to help build diversity
      return { accept: true };
    }

    // Check if this peer is from a new region (good for diversity)
    const existingRegions = this.getUniqueRegions();
    const isNewRegion = geoInfo.region && !existingRegions.has(geoInfo.region);

    // Check if this peer is from a new ASN (good for diversity)
    const existingASNs = this.getUniqueASNs();
    const isNewASN = geoInfo.asn !== undefined && !existingASNs.has(geoInfo.asn);

    // If peer brings diversity, always accept
    if (isNewRegion || isNewASN) {
      return { accept: true };
    }

    // Check if adding peer from same region would exceed concentration threshold
    if (geoInfo.region) {
      const regionCount = this.countPeersInRegion(geoInfo.region);
      const maxPerRegion = Math.ceil(this.activePeers.size / this.config.minGeographicRegions);

      if (regionCount >= maxPerRegion && existingRegions.size < this.config.minGeographicRegions) {
        this.createAlert(
          TopologyAlertType.GEOGRAPHIC_DIVERSITY_VIOLATION,
          'medium',
          `Connection rejected: Region ${geoInfo.region} would exceed concentration limit`,
          [],
          { ip, region: geoInfo.region, regionCount, maxPerRegion }
        );
        return {
          accept: false,
          reason: `Geographic diversity violation: Region ${geoInfo.region} over-represented (${regionCount}/${maxPerRegion})`
        };
      }
    }

    // Check if adding peer from same ASN would exceed concentration threshold
    if (geoInfo.asn !== undefined) {
      const asnCount = this.countPeersWithASN(geoInfo.asn);
      const maxPerASN = Math.ceil(this.activePeers.size / this.config.minUniqueASNs);

      if (asnCount >= maxPerASN && existingASNs.size < this.config.minUniqueASNs) {
        this.createAlert(
          TopologyAlertType.ASN_DIVERSITY_VIOLATION,
          'medium',
          `Connection rejected: ASN ${geoInfo.asn} would exceed concentration limit`,
          [],
          { ip, asn: geoInfo.asn, asnCount, maxPerASN }
        );
        return {
          accept: false,
          reason: `ASN diversity violation: ASN ${geoInfo.asn} over-represented (${asnCount}/${maxPerASN})`
        };
      }
    }

    return { accept: true };
  }

  /**
   * Get geographic info for an IP address
   * Uses cached values or derives from IP
   */
  private getGeoInfoForIP(ip: string): GeoInfo {
    // Check cache first
    const cached = this.geoCache.get(ip);
    if (cached) {
      return cached;
    }

    // Derive region from IP structure (simplified - real implementation would use GeoIP database)
    // This uses IP octets to simulate geographic distribution
    const octets = ip.split('.');
    if (octets.length === 4) {
      const firstOctet = parseInt(octets[0], 10);
      const secondOctet = parseInt(octets[1], 10);

      // Derive region from first octet (simulated)
      let region = 'unknown';
      if (firstOctet < 64) region = 'us-east';
      else if (firstOctet < 128) region = 'us-west';
      else if (firstOctet < 160) region = 'eu-west';
      else if (firstOctet < 192) region = 'eu-central';
      else if (firstOctet < 224) region = 'asia-east';
      else region = 'asia-south';

      // Derive ASN from second octet (simulated - represents different ISPs)
      const asn = secondOctet % 100 + 1000; // ASN range 1000-1099

      const geoInfo: GeoInfo = {
        region,
        asn,
        asnName: `AS${asn}`,
      };

      // Cache the result
      this.geoCache.set(ip, geoInfo);
      return geoInfo;
    }

    return { region: 'unknown' };
  }

  /**
   * Get set of unique regions from active peers
   */
  private getUniqueRegions(): Set<string> {
    const regions = new Set<string>();
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy && peer.region) {
        regions.add(peer.region);
      }
    }
    return regions;
  }

  /**
   * Get set of unique ASNs from active peers
   */
  private getUniqueASNs(): Set<number> {
    const asns = new Set<number>();
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy && peer.asn) {
        const asnNum = parseInt(peer.asn, 10);
        if (!isNaN(asnNum)) {
          asns.add(asnNum);
        }
      }
    }
    return asns;
  }

  /**
   * Count peers in a specific region
   */
  private countPeersInRegion(region: string): number {
    let count = 0;
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy && peer.region === region) {
        count++;
      }
    }
    return count;
  }

  /**
   * Count peers with a specific ASN
   */
  private countPeersWithASN(asn: number): number {
    let count = 0;
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy && peer.asn) {
        const peerASN = parseInt(peer.asn, 10);
        if (peerASN === asn) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Register a new peer connection
   */
  public registerPeer(peerId: string, address: string, metadata?: Partial<PeerMetadata>): void {
    const ip = this.extractIP(address);
    const port = this.extractPort(address);
    const subnet = this.extractSubnet(ip);

    const peer: PeerMetadata = {
      peerId,
      address,
      ip,
      port,
      subnet,
      asn: metadata?.asn,
      region: metadata?.region,
      country: metadata?.country,
      trustScore: 0.5, // Initial neutral score
      isDecoy: false,
      connectedSince: new Date(),
      lastSeen: new Date(),
      messageCount: 0,
      latency: metadata?.latency || 0,
    };

    this.peers.set(peerId, peer);
    this.activePeers.add(peerId);

    securityLogger.info('Registered peer', { module: 'TopologyDefense', peerId, subnet });
    this.emit('peer_registered', peer);

    // Check diversity requirements
    this.checkDiversityRequirements();
  }

  /**
   * Unregister a peer connection
   */
  public unregisterPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connectedSince = undefined;
      this.activePeers.delete(peerId);

      securityLogger.info('Unregistered peer', { module: 'TopologyDefense', peerId });
      this.emit('peer_unregistered', peerId);
    }
  }

  /**
   * Update peer metadata
   */
  public updatePeer(peerId: string, updates: Partial<PeerMetadata>): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      Object.assign(peer, updates, { lastSeen: new Date() });
    }
  }

  // ============================================================================
  // Dynamic Restructuring (Churn)
  // ============================================================================

  /**
   * Perform dynamic restructuring by rotating low-trust peers
   */
  public performChurn(): ChurnResult {
    if (this.activePeers.size < 5) {
      // Don't churn if we have few peers
      return {
        peersRemoved: [],
        peersAdded: [],
        timestamp: new Date(),
        reason: 'Insufficient peers for churn',
      };
    }

    const churnCount = Math.ceil(this.activePeers.size * this.config.churnRate);

    // Sort peers by trust score (lowest first)
    const activePeerList = Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy)
      .sort((a, b) => a.trustScore - b.trustScore);

    // Select lowest trust peers for removal
    const peersToRemove = activePeerList.slice(0, churnCount);
    const removedPeerIds: string[] = [];

    for (const peer of peersToRemove) {
      this.activePeers.delete(peer.peerId);
      removedPeerIds.push(peer.peerId);

      securityLogger.info('Churned peer', { module: 'TopologyDefense', peerId: peer.peerId, trustScore: peer.trustScore.toFixed(2) });
    }

    this.lastChurnTime = new Date();
    this.churnCount++;

    const result: ChurnResult = {
      peersRemoved: removedPeerIds,
      peersAdded: [], // New peers would be added through normal connection flow
      timestamp: this.lastChurnTime,
      reason: 'Scheduled churn rotation',
    };

    this.emit('churn_performed', result);

    // Rotate decoy peers during churn
    if (this.config.enableObfuscation) {
      this.rotateDecoyPeers();
    }

    return result;
  }

  /**
   * Get list of peers recommended for disconnection
   */
  public getPeersToChurn(): string[] {
    const timeSinceLastChurn = Date.now() - this.lastChurnTime.getTime();
    if (timeSinceLastChurn < this.config.churnInterval) {
      return [];
    }

    if (this.activePeers.size < 5) {
      return [];
    }

    const churnCount = Math.ceil(this.activePeers.size * this.config.churnRate);

    return Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy)
      .sort((a, b) => a.trustScore - b.trustScore)
      .slice(0, churnCount)
      .map(p => p.peerId);
  }

  // ============================================================================
  // Topology Obfuscation
  // ============================================================================

  /**
   * Get a list of peers to share with others (includes decoys for obfuscation)
   */
  public getShareablePeers(count: number): string[] {
    if (!this.config.enableObfuscation) {
      // Return only real peers if obfuscation is disabled
      return this.getRandomRealPeers(count);
    }

    // Mix real peers with decoys
    const realPeers = this.getRandomRealPeers(Math.floor(count * 0.7));
    const decoyAddresses = this.getRandomDecoys(Math.ceil(count * 0.3));

    // Combine and shuffle
    const combined = [...realPeers, ...decoyAddresses];
    return this.shuffleArray(combined).slice(0, count);
  }

  /**
   * Get random real peers
   */
  private getRandomRealPeers(count: number): string[] {
    const activePeerList = Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy);

    return this.shuffleArray(activePeerList)
      .slice(0, count)
      .map(p => `${p.peerId}@${p.address}`);
  }

  /**
   * Get random decoy peer addresses
   */
  private getRandomDecoys(count: number): string[] {
    const decoyList = Array.from(this.decoyPeers.values());
    return this.shuffleArray(decoyList)
      .slice(0, count)
      .map(d => `${d.peerId}@${d.address}`);
  }

  // ============================================================================
  // Suspicious Activity Detection
  // ============================================================================

  /**
   * Report suspicious behavior from a peer
   */
  public reportSuspicious(peerId: string, severity: number, reason: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Lower trust score
    peer.trustScore = Math.max(0, peer.trustScore - (severity * 0.1));

    // Track suspicious score by IP
    this.incrementSuspiciousScore(peer.ip, severity);

    const currentScore = this.suspiciousScores.get(peer.ip) || 0;

    securityLogger.warn('Suspicious activity from peer', {
      module: 'TopologyDefense',
      peerId,
      reason,
      currentScore,
    });

    // Ban if threshold exceeded
    if (currentScore >= this.config.anomalyThreshold) {
      this.banIP(peer.ip, reason);
      this.unregisterPeer(peerId);
    }

    this.emit('suspicious_activity', { peerId, severity, reason, totalScore: currentScore });
  }

  /**
   * Detect topology crawling behavior
   */
  private detectTopologyCrawling(ip: string): boolean {
    const attempts = this.connectionAttempts.get(ip) || [];
    const recentAttempts = attempts.filter(
      a => Date.now() - a.timestamp.getTime() < 60000 // Last minute
    );

    // High frequency of peer list requests is suspicious
    if (recentAttempts.length > this.config.connectionRateLimit * 2) {
      this.createAlert(
        TopologyAlertType.TOPOLOGY_CRAWLING_DETECTED,
        'high',
        `Potential topology crawling detected from ${ip}`,
        [],
        { ip, attemptCount: recentAttempts.length }
      );
      return true;
    }

    return false;
  }

  /**
   * Check if IP is rate limited
   */
  private isRateLimited(ip: string): boolean {
    const attempts = this.connectionAttempts.get(ip) || [];
    const recentAttempts = attempts.filter(
      a => Date.now() - a.timestamp.getTime() < 60000 // Last minute
    );
    return recentAttempts.length >= this.config.connectionRateLimit;
  }

  /**
   * Increment suspicious score for an IP
   */
  private incrementSuspiciousScore(ip: string, amount: number): void {
    const current = this.suspiciousScores.get(ip) || 0;
    this.suspiciousScores.set(ip, current + amount);
  }

  /**
   * Record a connection attempt
   */
  private recordConnectionAttempt(ip: string, success: boolean, reason?: string): void {
    const attempts = this.connectionAttempts.get(ip) || [];
    attempts.push({
      ip,
      timestamp: new Date(),
      success,
      reason,
    });

    // Keep only last 100 attempts
    if (attempts.length > 100) {
      attempts.shift();
    }

    this.connectionAttempts.set(ip, attempts);
  }

  // ============================================================================
  // IP Banning
  // ============================================================================

  /**
   * Ban an IP address
   */
  public banIP(ip: string, reason: string): void {
    const existing = this.bannedIPs.get(ip);
    const violationCount = existing ? existing.violationCount + 1 : 1;

    // Increase ban duration for repeat offenders
    const banMultiplier = Math.min(violationCount, 5);
    const banDuration = this.config.banDuration * banMultiplier;

    const banRecord: BanRecord = {
      ip,
      reason,
      bannedAt: new Date(),
      expiresAt: new Date(Date.now() + banDuration),
      violationCount,
    };

    this.bannedIPs.set(ip, banRecord);

    securityLogger.warn('Banned IP', {
      module: 'TopologyDefense',
      ip,
      banDurationSeconds: banDuration / 1000,
      reason,
      violationCount,
    });
    this.emit('ip_banned', banRecord);
  }

  /**
   * Unban an IP address
   */
  public unbanIP(ip: string): boolean {
    const existed = this.bannedIPs.delete(ip);
    if (existed) {
      securityLogger.info('Unbanned IP', { module: 'TopologyDefense', ip });
      this.emit('ip_unbanned', ip);
    }
    return existed;
  }

  /**
   * Check if IP is banned
   */
  public isIPBanned(ip: string): boolean {
    const record = this.bannedIPs.get(ip);
    if (!record) return false;
    if (record.expiresAt <= new Date()) {
      this.bannedIPs.delete(ip);
      return false;
    }
    return true;
  }

  /**
   * Get all banned IPs
   */
  public getBannedIPs(): BanRecord[] {
    return Array.from(this.bannedIPs.values())
      .filter(r => r.expiresAt > new Date());
  }

  // ============================================================================
  // Diversity Checking
  // ============================================================================

  /**
   * Check if network meets diversity requirements
   */
  public checkDiversityRequirements(): void {
    const metrics = this.getMetrics();

    // Check geographic diversity
    if (metrics.uniqueRegions < this.config.minGeographicRegions) {
      this.createAlert(
        TopologyAlertType.GEOGRAPHIC_ISOLATION,
        'medium',
        `Geographic diversity below threshold: ${metrics.uniqueRegions}/${this.config.minGeographicRegions} regions`,
        [],
        { currentRegions: metrics.uniqueRegions, required: this.config.minGeographicRegions }
      );
    }

    // Check ASN diversity
    if (metrics.uniqueASNs < this.config.minUniqueASNs) {
      this.createAlert(
        TopologyAlertType.ASN_CONCENTRATION,
        'medium',
        `ASN diversity below threshold: ${metrics.uniqueASNs}/${this.config.minUniqueASNs} ASNs`,
        [],
        { currentASNs: metrics.uniqueASNs, required: this.config.minUniqueASNs }
      );
    }

    // Check subnet concentration
    const subnetCounts = this.getSubnetCounts();
    for (const [subnet, count] of subnetCounts) {
      if (count > this.config.maxPeersPerSubnet) {
        this.createAlert(
          TopologyAlertType.SUBNET_CONCENTRATION,
          'high',
          `Subnet concentration detected: ${count} peers in ${subnet}`,
          Array.from(this.activePeers).filter(id => {
            const peer = this.peers.get(id);
            return peer && peer.subnet === subnet;
          }),
          { subnet, count, max: this.config.maxPeersPerSubnet }
        );
      }
    }
  }

  /**
   * Get counts of peers per subnet
   */
  private getSubnetCounts(): Map<string, number> {
    const counts = new Map<string, number>();

    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy) {
        const current = counts.get(peer.subnet) || 0;
        counts.set(peer.subnet, current + 1);
      }
    }

    return counts;
  }

  /**
   * Count peers in a specific subnet
   */
  private countPeersInSubnet(subnet: string): number {
    let count = 0;
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy && peer.subnet === subnet) {
        count++;
      }
    }
    return count;
  }

  // ============================================================================
  // Trust Score Management
  // ============================================================================

  /**
   * Increase trust score for good behavior
   */
  public increaseTrust(peerId: string, amount: number = 0.05): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.trustScore = Math.min(1.0, peer.trustScore + amount);
    }
  }

  /**
   * Decrease trust score for bad behavior
   */
  public decreaseTrust(peerId: string, amount: number = 0.1): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.trustScore = Math.max(0, peer.trustScore - amount);
    }
  }

  /**
   * Get peers sorted by trust score
   */
  public getPeersByTrust(ascending: boolean = false): PeerMetadata[] {
    const peers = Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy);

    return ascending
      ? peers.sort((a, b) => a.trustScore - b.trustScore)
      : peers.sort((a, b) => b.trustScore - a.trustScore);
  }

  // ============================================================================
  // Alerts
  // ============================================================================

  /**
   * Create a topology alert
   */
  private createAlert(
    type: TopologyAlertType,
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    affectedPeers: string[],
    metadata: Record<string, unknown>
  ): void {
    const alert: TopologyAlert = {
      alertId: crypto.randomBytes(8).toString('hex'),
      type,
      severity,
      message,
      affectedPeers,
      timestamp: new Date(),
      metadata,
    };

    this.alerts.push(alert);

    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts.shift();
    }

    securityLogger.warn('Topology defense alert', { module: 'TopologyDefense', severity, alertId: alert.alertId, type, message });
    this.emit('alert', alert);
  }

  /**
   * Get recent alerts
   */
  public getAlerts(since?: Date): TopologyAlert[] {
    if (!since) {
      return [...this.alerts];
    }
    return this.alerts.filter(a => a.timestamp >= since);
  }

  // ============================================================================
  // Metrics and Status
  // ============================================================================

  /**
   * Get current topology defense metrics
   */
  public getMetrics(): TopologyMetrics {
    const activePeerList = Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy);

    const uniqueSubnets = new Set(activePeerList.map(p => p.subnet)).size;
    const uniqueRegions = new Set(activePeerList.map(p => p.region).filter(Boolean)).size;
    const uniqueASNs = new Set(activePeerList.map(p => p.asn).filter(Boolean)).size;

    const avgTrust = activePeerList.length > 0
      ? activePeerList.reduce((sum, p) => sum + p.trustScore, 0) / activePeerList.length
      : 0;

    // Calculate health score
    let healthScore = 100;
    if (uniqueRegions < this.config.minGeographicRegions) {
      healthScore -= (this.config.minGeographicRegions - uniqueRegions) * 10;
    }
    if (uniqueASNs < this.config.minUniqueASNs) {
      healthScore -= (this.config.minUniqueASNs - uniqueASNs) * 5;
    }
    if (this.bannedIPs.size > 10) {
      healthScore -= 10;
    }
    healthScore = Math.max(0, Math.min(100, healthScore));

    return {
      totalPeers: this.peers.size,
      activePeers: this.activePeers.size,
      decoyPeers: this.decoyPeers.size,
      bannedIPs: this.bannedIPs.size,
      uniqueSubnets,
      uniqueRegions,
      uniqueASNs,
      averageTrustScore: avgTrust,
      churnCount: this.churnCount,
      lastChurnTime: this.lastChurnTime,
      healthScore,
    };
  }

  /**
   * Get detailed status
   */
  public getStatus(): {
    config: TopologyDefenseConfig;
    metrics: TopologyMetrics;
    recentAlerts: TopologyAlert[];
    topTrustedPeers: PeerMetadata[];
    bannedIPs: BanRecord[];
  } {
    return {
      config: this.config,
      metrics: this.getMetrics(),
      recentAlerts: this.alerts.slice(-10),
      topTrustedPeers: this.getPeersByTrust().slice(0, 5),
      bannedIPs: this.getBannedIPs(),
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Extract IP from address string (host:port)
   */
  private extractIP(address: string): string {
    return address.split(':')[0];
  }

  /**
   * Extract port from address string (host:port)
   */
  private extractPort(address: string): number {
    const parts = address.split(':');
    return parts.length > 1 ? parseInt(parts[1], 10) : 0;
  }

  /**
   * Extract /24 subnet from IP
   */
  private extractSubnet(ip: string): string {
    const octets = ip.split('.');
    if (octets.length === 4) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
    }
    return 'unknown';
  }

  /**
   * Shuffle an array (Fisher-Yates algorithm)
   */
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Perform cleanup of expired records
   */
  private performCleanup(): void {
    const now = new Date();

    // Cleanup expired bans
    for (const [ip, record] of this.bannedIPs) {
      if (record.expiresAt <= now) {
        this.bannedIPs.delete(ip);
      }
    }

    // Cleanup old connection attempts
    for (const [ip, attempts] of this.connectionAttempts) {
      const recentAttempts = attempts.filter(
        a => now.getTime() - a.timestamp.getTime() < 5 * 60 * 1000 // Last 5 minutes
      );
      if (recentAttempts.length === 0) {
        this.connectionAttempts.delete(ip);
      } else {
        this.connectionAttempts.set(ip, recentAttempts);
      }
    }

    // Cleanup expired decoys
    for (const [id, decoy] of this.decoyPeers) {
      if (decoy.expiresAt <= now) {
        this.decoyPeers.delete(id);
        const newDecoy = this.createDecoyPeer(decoy.region);
        this.decoyPeers.set(newDecoy.peerId, newDecoy);
      }
    }
  }

  // ============================================================================
  // Critical Node Protection
  // ============================================================================

  /**
   * Update the set of critical nodes based on connection centrality
   */
  public updateCriticalNodes(): void {
    this.criticalNodes.clear();

    const activePeerList = Array.from(this.activePeers)
      .map(id => this.peers.get(id)!)
      .filter(p => p && !p.isDecoy);

    if (activePeerList.length === 0) {
      return;
    }

    for (const peer of activePeerList) {
      // Calculate degree centrality as fraction of total peers
      const degreeCentrality = (activePeerList.length - 1) / Math.max(1, activePeerList.length);

      // Consider high-trust peers as potentially critical
      const trustFactor = peer.trustScore;

      // Combined score (simplified betweenness estimate)
      const betweennessEstimate = degreeCentrality * trustFactor;

      if (betweennessEstimate > this.config.criticalBetweennessThreshold) {
        this.criticalNodes.add(peer.peerId);
      }
    }

    securityLogger.info('Updated critical nodes', { module: 'TopologyDefense', count: this.criticalNodes.size });
  }

  /**
   * Check if critical nodes have sufficient redundant connections
   */
  public checkCriticalNodeRedundancy(): string[] {
    const atRiskNodes: string[] = [];

    for (const peerId of this.criticalNodes) {
      const peer = this.peers.get(peerId);
      if (!peer) continue;

      // Check if we have enough connections overall (simplified redundancy check)
      const activeCount = this.activePeers.size;

      if (activeCount < this.config.minRedundantConnections) {
        atRiskNodes.push(peerId);
        this.createAlert(
          TopologyAlertType.CRITICAL_NODE_AT_RISK,
          'high',
          `Critical node ${peerId} has insufficient redundancy: ${activeCount}/${this.config.minRedundantConnections}`,
          [peerId],
          { activeCount, required: this.config.minRedundantConnections }
        );
      }
    }

    return atRiskNodes;
  }

  /**
   * Get the current set of critical nodes
   */
  public getCriticalNodes(): string[] {
    return Array.from(this.criticalNodes);
  }

  /**
   * Check if a peer is critical
   */
  public isCriticalNode(peerId: string): boolean {
    return this.criticalNodes.has(peerId);
  }

  // ============================================================================
  // Adaptive Topology Management
  // ============================================================================

  /**
   * Assess the current threat level based on network activity
   */
  public assessThreatLevel(): ThreatLevel {
    const bannedCount = this.bannedIPs.size;
    const suspiciousHighCount = Array.from(this.suspiciousScores.values())
      .filter(score => score >= Math.floor(this.config.anomalyThreshold / 2))
      .length;

    // Calculate threat score based on multiple factors
    const threatScore = bannedCount + suspiciousHighCount * 2;

    let newLevel: ThreatLevel;
    if (threatScore <= 2) {
      newLevel = ThreatLevel.LOW;
    } else if (threatScore <= 5) {
      newLevel = ThreatLevel.MEDIUM;
    } else if (threatScore <= 10) {
      newLevel = ThreatLevel.HIGH;
    } else {
      newLevel = ThreatLevel.CRITICAL;
    }

    if (newLevel !== this.currentThreatLevel) {
      securityLogger.warn('Threat level changed', { module: 'TopologyDefense', oldLevel: this.currentThreatLevel, newLevel });
      this.currentThreatLevel = newLevel;
      this.adaptDefenseParameters();

      this.createAlert(
        TopologyAlertType.THREAT_LEVEL_ELEVATED,
        newLevel === ThreatLevel.CRITICAL ? 'critical' : newLevel === ThreatLevel.HIGH ? 'high' : 'medium',
        `Threat level elevated to ${newLevel}`,
        [],
        { previousLevel: this.currentThreatLevel, newLevel, bannedCount, suspiciousHighCount }
      );
    }

    return newLevel;
  }

  /**
   * Adapt defense parameters based on current threat level
   */
  private adaptDefenseParameters(): void {
    let multiplier: number;
    switch (this.currentThreatLevel) {
      case ThreatLevel.LOW:
        multiplier = 1.0;
        break;
      case ThreatLevel.MEDIUM:
        multiplier = 1.5;
        break;
      case ThreatLevel.HIGH:
        multiplier = 2.0;
        break;
      case ThreatLevel.CRITICAL:
        multiplier = 3.0;
        break;
      default:
        multiplier = 1.0;
    }

    // Adjust churn rate (higher threat = more frequent churn)
    this.config.churnRate = Math.min(this.baseConfig.churnRate * multiplier, 0.5);

    // Adjust decoy count (higher threat = more decoys)
    this.config.decoyCount = Math.ceil(this.baseConfig.decoyCount * multiplier);

    // Adjust max peers per subnet (higher threat = stricter limits)
    this.config.maxPeersPerSubnet = Math.max(
      1,
      Math.ceil(this.baseConfig.maxPeersPerSubnet / multiplier)
    );

    securityLogger.info('Adapted defense parameters', {
      module: 'TopologyDefense',
      threatLevel: this.currentThreatLevel,
      churnRate: this.config.churnRate.toFixed(2),
      decoyCount: this.config.decoyCount,
      maxPeersPerSubnet: this.config.maxPeersPerSubnet,
    });
  }

  /**
   * Get current threat level
   */
  public getThreatLevel(): ThreatLevel {
    return this.currentThreatLevel;
  }

  /**
   * Reset defense parameters to baseline
   */
  public resetDefenseParameters(): void {
    this.config.churnRate = this.baseConfig.churnRate;
    this.config.decoyCount = this.baseConfig.decoyCount;
    this.config.maxPeersPerSubnet = this.baseConfig.maxPeersPerSubnet;
    this.currentThreatLevel = ThreatLevel.LOW;
    securityLogger.info('Reset defense parameters to baseline', { module: 'TopologyDefense' });
  }

  /**
   * Start periodic threat assessment
   */
  public startThreatAssessment(intervalMs: number = 60000): void {
    if (this.threatAssessmentTimer) {
      clearInterval(this.threatAssessmentTimer);
    }

    this.threatAssessmentTimer = setInterval(() => {
      this.assessThreatLevel();
      this.updateCriticalNodes();
      this.checkCriticalNodeRedundancy();
    }, intervalMs);

    securityLogger.info('Started threat assessment', { module: 'TopologyDefense', intervalMs });
  }

  /**
   * Stop periodic threat assessment
   */
  public stopThreatAssessment(): void {
    if (this.threatAssessmentTimer) {
      clearInterval(this.threatAssessmentTimer);
      this.threatAssessmentTimer = undefined;
    }
  }

  // ============================================================================
  // Graph Analysis (Simplified)
  // ============================================================================

  /**
   * Calculate degree centrality for all peers
   */
  public calculateDegreeCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();
    const n = this.activePeers.size;

    if (n <= 1) {
      return centrality;
    }

    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (peer && !peer.isDecoy) {
        // Simplified: all active peers have similar degree
        // Real implementation would track actual connections
        const degree = (n - 1) / Math.max(1, n - 1);
        centrality.set(peerId, degree);
      }
    }

    return centrality;
  }

  /**
   * Identify potential bridge nodes (nodes connecting different regions)
   */
  public identifyBridgeNodes(): string[] {
    const bridgeNodes: string[] = [];
    const regions = this.getUniqueRegions();

    if (regions.size < 2) {
      return bridgeNodes;
    }

    // Nodes that are the only ones in their region are potential bridges
    for (const peerId of this.activePeers) {
      const peer = this.peers.get(peerId);
      if (!peer || peer.isDecoy) continue;

      if (peer.region) {
        const regionCount = this.countPeersInRegion(peer.region);
        if (regionCount === 1) {
          bridgeNodes.push(peerId);
        }
      }
    }

    return bridgeNodes;
  }
}

export default TopologyAttackDefense;
