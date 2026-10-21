/**
 * Sybil Attack Prevention - IP Rate Limiting and Geographic Distribution
 *
 * Implements comprehensive rate limiting based on IP addresses, subnets,
 * geographic regions, and ASN diversity to prevent Sybil attacks.
 */

import { createHash } from 'crypto';
import * as geoip from 'geoip-lite';

export interface RateLimitConfig {
  maxNodesPerIP: number;
  maxNodesPerSubnet: number;
  maxNodesPerASN: number;
  maxNodesPerCountry: number;
  registrationWindow: number; // seconds
  minGeographicDiversity: number; // entropy threshold
}

export interface GeographicInfo {
  ip: string;
  country: string;
  region: string;
  city: string;
  ll: [number, number]; // [latitude, longitude]
  asn: number;
  isp: string;
}

export interface NodeRegistration {
  nodeId: string;
  ip: string;
  subnet: string;
  geographic: GeographicInfo;
  timestamp: Date;
  isVPN: boolean;
  isProxy: boolean;
  isTor: boolean;
}

export interface RateLimitViolation {
  type: 'ip' | 'subnet' | 'asn' | 'country' | 'geographic';
  limit: number;
  current: number;
  affectedNodes: string[];
}

/**
 * Rate Limiter for Sybil Prevention
 */
export class SybilRateLimiter {
  // SECURITY ENHANCEMENT (Task 92.8): Tightened rate limits for enhanced Sybil prevention
  private config: RateLimitConfig = {
    maxNodesPerIP: 1,        // Only 1 node per IP address
    maxNodesPerSubnet: 2,    // Reduced from 3 to 2 - stricter subnet limits
    maxNodesPerASN: 8,       // Reduced from 10 to 8 - stricter ASN limits
    maxNodesPerCountry: 500, // Reduced from 1000 - prevents geographic concentration
    registrationWindow: 3600, // 1 hour
    minGeographicDiversity: 2.5 // Increased from 2.0 - requires better distribution
  };

  private registrations = new Map<string, NodeRegistration>();
  private ipRegistry = new Map<string, Set<string>>(); // IP -> nodeIds
  private subnetRegistry = new Map<string, Set<string>>(); // subnet -> nodeIds
  private asnRegistry = new Map<number, Set<string>>(); // ASN -> nodeIds
  private countryRegistry = new Map<string, Set<string>>(); // country -> nodeIds

  private vpnDetectionList = new Set<string>();
  private torExitNodes = new Set<string>();

  constructor(config?: Partial<RateLimitConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.loadVPNList();
    this.loadTorExitNodes();
  }

  /**
   * Check if node registration is allowed under rate limits
   */
  async checkRateLimit(
    nodeId: string,
    ipAddress: string
  ): Promise<{
    allowed: boolean;
    violations: RateLimitViolation[];
    geographic: GeographicInfo;
  }> {
    const violations: RateLimitViolation[] = [];

    // Get geographic information
    const geographic = await this.getGeographicInfo(ipAddress);

    // Check IP-based rate limit
    const ipViolation = this.checkIPLimit(ipAddress);
    if (ipViolation) violations.push(ipViolation);

    // Check subnet-based rate limit (/24)
    const subnet = this.getSubnet(ipAddress);
    const subnetViolation = this.checkSubnetLimit(subnet);
    if (subnetViolation) violations.push(subnetViolation);

    // SECURITY ENHANCEMENT (Task 92.8): Check larger subnets to prevent spread attacks
    // Check /23 subnet (allows 4 nodes max across 2 adjacent /24s)
    const subnet23 = this.getSubnet23(ipAddress);
    const subnet23Violation = this.checkLargerSubnetLimit(subnet23, '/23', 4);
    if (subnet23Violation) violations.push(subnet23Violation);

    // Check /22 subnet (allows 6 nodes max across 4 adjacent /24s)
    const subnet22 = this.getSubnet22(ipAddress);
    const subnet22Violation = this.checkLargerSubnetLimit(subnet22, '/22', 6);
    if (subnet22Violation) violations.push(subnet22Violation);

    // Check ASN-based rate limit
    if (geographic.asn) {
      const asnViolation = this.checkASNLimit(geographic.asn);
      if (asnViolation) violations.push(asnViolation);
    }

    // Check country-based rate limit
    const countryViolation = this.checkCountryLimit(geographic.country);
    if (countryViolation) violations.push(countryViolation);

    // Check geographic diversity
    const diversityViolation = await this.checkGeographicDiversity(geographic);
    if (diversityViolation) violations.push(diversityViolation);

    return {
      allowed: violations.length === 0,
      violations,
      geographic
    };
  }

  /**
   * Register new node
   */
  async registerNode(
    nodeId: string,
    ipAddress: string
  ): Promise<NodeRegistration> {
    const rateCheck = await this.checkRateLimit(nodeId, ipAddress);

    if (!rateCheck.allowed) {
      const violationsStr = JSON.stringify(rateCheck.violations);
      throw new Error('Rate limit violations: ' + violationsStr);
    }

    const subnet = this.getSubnet(ipAddress);
    const isVPN = this.isVPNIP(ipAddress);
    const isProxy = await this.isProxyIP(ipAddress);
    const isTor = this.isTorExitNode(ipAddress);

    const registration: NodeRegistration = {
      nodeId,
      ip: ipAddress,
      subnet,
      geographic: rateCheck.geographic,
      timestamp: new Date(),
      isVPN,
      isProxy,
      isTor
    };

    // Store registration
    this.registrations.set(nodeId, registration);

    // Update registries
    if (!this.ipRegistry.has(ipAddress)) {
      this.ipRegistry.set(ipAddress, new Set());
    }
    this.ipRegistry.get(ipAddress)!.add(nodeId);

    if (!this.subnetRegistry.has(subnet)) {
      this.subnetRegistry.set(subnet, new Set());
    }
    this.subnetRegistry.get(subnet)!.add(nodeId);

    if (rateCheck.geographic.asn) {
      if (!this.asnRegistry.has(rateCheck.geographic.asn)) {
        this.asnRegistry.set(rateCheck.geographic.asn, new Set());
      }
      this.asnRegistry.get(rateCheck.geographic.asn)!.add(nodeId);
    }

    if (!this.countryRegistry.has(rateCheck.geographic.country)) {
      this.countryRegistry.set(rateCheck.geographic.country, new Set());
    }
    this.countryRegistry.get(rateCheck.geographic.country)!.add(nodeId);

    return registration;
  }

  /**
   * Deregister node
   */
  deregisterNode(nodeId: string): boolean {
    const registration = this.registrations.get(nodeId);
    if (!registration) {
      return false;
    }

    // Remove from registries
    this.ipRegistry.get(registration.ip)?.delete(nodeId);
    this.subnetRegistry.get(registration.subnet)?.delete(nodeId);
    if (registration.geographic.asn) {
      this.asnRegistry.get(registration.geographic.asn)?.delete(nodeId);
    }
    this.countryRegistry.get(registration.geographic.country)?.delete(nodeId);

    // Remove registration
    this.registrations.delete(nodeId);

    return true;
  }

  /**
   * Get geographic diversity entropy
   */
  getGeographicDiversity(): number {
    const countries = Array.from(this.countryRegistry.keys());
    const totalNodes = this.registrations.size;

    if (totalNodes === 0 || countries.length === 0) {
      return 0;
    }

    // Calculate Shannon entropy
    let entropy = 0;
    for (const country of countries) {
      const nodeCount = this.countryRegistry.get(country)!.size;
      const probability = nodeCount / totalNodes;
      entropy -= probability * Math.log2(probability);
    }

    return entropy;
  }

  /**
   * Get network diversity (ASN entropy)
   */
  getNetworkDiversity(): number {
    const asns = Array.from(this.asnRegistry.keys());
    const totalNodes = this.registrations.size;

    if (totalNodes === 0 || asns.length === 0) {
      return 0;
    }

    // Calculate Shannon entropy
    let entropy = 0;
    for (const asn of asns) {
      const nodeCount = this.asnRegistry.get(asn)!.size;
      const probability = nodeCount / totalNodes;
      entropy -= probability * Math.log2(probability);
    }

    return entropy;
  }

  /**
   * Get distribution statistics
   */
  getDistributionStats(): {
    totalNodes: number;
    uniqueIPs: number;
    uniqueSubnets: number;
    uniqueASNs: number;
    uniqueCountries: number;
    geographicEntropy: number;
    networkEntropy: number;
    vpnNodes: number;
    proxyNodes: number;
    torNodes: number;
  } {
    const vpnNodes = Array.from(this.registrations.values()).filter(r => r.isVPN).length;
    const proxyNodes = Array.from(this.registrations.values()).filter(r => r.isProxy).length;
    const torNodes = Array.from(this.registrations.values()).filter(r => r.isTor).length;

    return {
      totalNodes: this.registrations.size,
      uniqueIPs: this.ipRegistry.size,
      uniqueSubnets: this.subnetRegistry.size,
      uniqueASNs: this.asnRegistry.size,
      uniqueCountries: this.countryRegistry.size,
      geographicEntropy: this.getGeographicDiversity(),
      networkEntropy: this.getNetworkDiversity(),
      vpnNodes,
      proxyNodes,
      torNodes
    };
  }

  /**
   * Private: Check IP limit
   */
  private checkIPLimit(ip: string): RateLimitViolation | null {
    const nodes = this.ipRegistry.get(ip);
    if (!nodes) return null;

    if (nodes.size >= this.config.maxNodesPerIP) {
      return {
        type: 'ip',
        limit: this.config.maxNodesPerIP,
        current: nodes.size,
        affectedNodes: Array.from(nodes)
      };
    }

    return null;
  }

  /**
   * Private: Check subnet limit
   */
  private checkSubnetLimit(subnet: string): RateLimitViolation | null {
    const nodes = this.subnetRegistry.get(subnet);
    if (!nodes) return null;

    if (nodes.size >= this.config.maxNodesPerSubnet) {
      return {
        type: 'subnet',
        limit: this.config.maxNodesPerSubnet,
        current: nodes.size,
        affectedNodes: Array.from(nodes)
      };
    }

    return null;
  }

  /**
   * Private: Check ASN limit
   */
  private checkASNLimit(asn: number): RateLimitViolation | null {
    const nodes = this.asnRegistry.get(asn);
    if (!nodes) return null;

    if (nodes.size >= this.config.maxNodesPerASN) {
      return {
        type: 'asn',
        limit: this.config.maxNodesPerASN,
        current: nodes.size,
        affectedNodes: Array.from(nodes)
      };
    }

    return null;
  }

  /**
   * Private: Check country limit
   */
  private checkCountryLimit(country: string): RateLimitViolation | null {
    const nodes = this.countryRegistry.get(country);
    if (!nodes) return null;

    if (nodes.size >= this.config.maxNodesPerCountry) {
      return {
        type: 'country',
        limit: this.config.maxNodesPerCountry,
        current: nodes.size,
        affectedNodes: Array.from(nodes)
      };
    }

    return null;
  }

  /**
   * Private: Check geographic diversity
   */
  private async checkGeographicDiversity(
    geographic: GeographicInfo
  ): Promise<RateLimitViolation | null> {
    const entropy = this.getGeographicDiversity();

    if (entropy < this.config.minGeographicDiversity) {
      return {
        type: 'geographic',
        limit: this.config.minGeographicDiversity,
        current: entropy,
        affectedNodes: []
      };
    }

    return null;
  }

  /**
   * Private: Get geographic info for IP
   */
  private async getGeographicInfo(ip: string): Promise<GeographicInfo> {
    const geo = geoip.lookup(ip);

    if (!geo) {
      return {
        ip,
        country: 'UNKNOWN',
        region: 'UNKNOWN',
        city: 'UNKNOWN',
        ll: [0, 0],
        asn: 0,
        isp: 'UNKNOWN'
      };
    }

    return {
      ip,
      country: geo.country || 'UNKNOWN',
      region: geo.region || 'UNKNOWN',
      city: geo.city || 'UNKNOWN',
      ll: geo.ll || [0, 0],
      asn: 0, // Would need additional ASN lookup service
      isp: 'UNKNOWN'
    };
  }

  /**
   * Private: Get subnet from IP (Class C /24)
   */
  private getSubnet(ip: string): string {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return ip;
    }
    return parts[0] + '.' + parts[1] + '.' + parts[2] + '.0/24';
  }

  /**
   * Private: Get /23 subnet from IP (SECURITY ENHANCEMENT - Task 92.8)
   * A /23 covers 2 adjacent /24 blocks
   */
  private getSubnet23(ip: string): string {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return ip;
    }
    // Round down the third octet to the nearest even number
    const thirdOctet = parseInt(parts[2]) & 0xFE; // Clear lowest bit
    return parts[0] + '.' + parts[1] + '.' + thirdOctet + '.0/23';
  }

  /**
   * Private: Get /22 subnet from IP (SECURITY ENHANCEMENT - Task 92.8)
   * A /22 covers 4 adjacent /24 blocks
   */
  private getSubnet22(ip: string): string {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return ip;
    }
    // Round down the third octet to the nearest multiple of 4
    const thirdOctet = parseInt(parts[2]) & 0xFC; // Clear lowest 2 bits
    return parts[0] + '.' + parts[1] + '.' + thirdOctet + '.0/22';
  }

  /**
   * Private: Check larger subnet limits (SECURITY ENHANCEMENT - Task 92.8)
   * Prevents attackers from spreading across adjacent /24 blocks
   */
  private checkLargerSubnetLimit(
    subnet: string,
    cidr: string,
    maxNodes: number
  ): RateLimitViolation | null {
    // Count nodes in this larger subnet by checking all /24 subnets within it
    let nodeCount = 0;
    const affectedNodes: string[] = [];

    const subnetEntries = Array.from(this.subnetRegistry.entries());
    for (const [registeredSubnet, nodes] of subnetEntries) {
      // Check if the registered /24 subnet falls within this larger subnet
      if (this.isSubnetWithin(registeredSubnet, subnet, cidr)) {
        nodeCount += nodes.size;
        affectedNodes.push(...Array.from(nodes));
      }
    }

    if (nodeCount >= maxNodes) {
      return {
        type: 'subnet',
        limit: maxNodes,
        current: nodeCount,
        affectedNodes: affectedNodes.slice(0, 10) // Limit to first 10 for response size
      };
    }

    return null;
  }

  /**
   * Private: Check if a /24 subnet is within a larger subnet
   */
  private isSubnetWithin(subnet24: string, largerSubnet: string, cidr: string): boolean {
    // Extract base addresses
    const subnet24Base = subnet24.replace('/24', '').split('.');
    const largerBase = largerSubnet.replace(cidr, '').split('.');

    if (subnet24Base.length !== 4 || largerBase.length !== 4) {
      return false;
    }

    // First two octets must match
    if (subnet24Base[0] !== largerBase[0] || subnet24Base[1] !== largerBase[1]) {
      return false;
    }

    const subnet24Third = parseInt(subnet24Base[2]);
    const largerThird = parseInt(largerBase[2]);

    if (cidr === '/23') {
      // /23 covers 2 consecutive /24s: base and base+1
      return subnet24Third >= largerThird && subnet24Third < largerThird + 2;
    } else if (cidr === '/22') {
      // /22 covers 4 consecutive /24s: base through base+3
      return subnet24Third >= largerThird && subnet24Third < largerThird + 4;
    }

    return false;
  }

  /**
   * Private: Check if IP is VPN
   */
  private isVPNIP(ip: string): boolean {
    return this.vpnDetectionList.has(ip);
  }

  /**
   * Private: Check if IP is proxy
   */
  private async isProxyIP(ip: string): Promise<boolean> {
    // Simplified proxy detection
    // In production, would use external proxy detection API
    return false;
  }

  /**
   * Private: Check if IP is Tor exit node
   */
  private isTorExitNode(ip: string): boolean {
    return this.torExitNodes.has(ip);
  }

  /**
   * Private: Load VPN IP list
   */
  private loadVPNList(): void {
    // In production, would load from external VPN detection service
    // For now, empty list
  }

  /**
   * Private: Load Tor exit nodes
   */
  private loadTorExitNodes(): void {
    // In production, would load from Tor Project exit node list
    // For now, empty list
  }
}
