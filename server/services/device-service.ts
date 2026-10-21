import { eq, and, gt, lt, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { UAParser } from 'ua-parser-js';
import {
  trustedDevices,
  securityEvents,
  type TrustedDevice,
  type InsertTrustedDevice,
  type InsertSecurityEvent,
} from '../../shared/schema.js';
import { db } from '../../database/connection.js';

export interface DeviceFingerprint {
  userAgent: string;
  screenResolution?: string;
  timezone?: string;
  language?: string;
  platform?: string;
  cookieEnabled?: boolean;
  doNotTrack?: boolean;
  colorDepth?: number;
  pixelRatio?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  webgl?: string;
  canvas?: string;
}

export interface ParsedDeviceInfo {
  fingerprint: string;
  deviceName: string;
  deviceType: string;
  browser: string;
  browserVersion: string;
  operatingSystem: string;
  osVersion: string;
}

export interface DeviceAlert {
  isNewDevice: boolean;
  isSuspicious: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
}

export class DeviceService {
  /**
   * Generate device fingerprint from request data
   */
  generateDeviceFingerprint(data: DeviceFingerprint): string {
    const fingerprintData = {
      userAgent: data.userAgent,
      screenResolution: data.screenResolution || '',
      timezone: data.timezone || '',
      language: data.language || '',
      platform: data.platform || '',
      cookieEnabled: data.cookieEnabled || false,
      doNotTrack: data.doNotTrack || false,
      colorDepth: data.colorDepth || 0,
      pixelRatio: data.pixelRatio || 1,
      hardwareConcurrency: data.hardwareConcurrency || 0,
      deviceMemory: data.deviceMemory || 0,
      webgl: data.webgl || '',
      canvas: data.canvas || '',
    };

    const fingerprintString = JSON.stringify(fingerprintData);
    return crypto.createHash('sha256').update(fingerprintString).digest('hex');
  }

  /**
   * Parse device information from user agent
   */
  parseDeviceInfo(
    userAgent: string,
    customFingerprint?: string
  ): ParsedDeviceInfo {
    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    const deviceType = this.determineDeviceType(result);
    const deviceName = this.generateDeviceName(result);

    return {
      fingerprint:
        customFingerprint || this.generateBasicFingerprint(userAgent),
      deviceName,
      deviceType,
      browser:
        `${result.browser.name || 'Unknown'} ${result.browser.version || ''}`.trim(),
      browserVersion: result.browser.version || '',
      operatingSystem:
        `${result.os.name || 'Unknown'} ${result.os.version || ''}`.trim(),
      osVersion: result.os.version || '',
    };
  }

  /**
   * Check if device is new and analyze risk
   */
  async analyzeDevice(
    userId: number,
    deviceInfo: ParsedDeviceInfo,
    ipAddress?: string,
    location?: any
  ): Promise<DeviceAlert> {
    // Check if device already exists
    const existingDevice = await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.deviceFingerprint, deviceInfo.fingerprint),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      )
      .limit(1);

    const isNewDevice = existingDevice.length === 0;

    // Analyze risk factors
    const riskFactors: string[] = [];
    let riskLevel: 'low' | 'medium' | 'high' = 'low';

    if (isNewDevice) {
      riskFactors.push('New device detected');
    }

    // Check for suspicious patterns
    const recentDevices = await this.getRecentDevices(userId, 24); // Last 24 hours

    if (recentDevices.length > 3) {
      riskFactors.push('Multiple new devices in short time');
      riskLevel = 'medium';
    }

    // Check IP address patterns
    if (ipAddress && isNewDevice) {
      const recentIPs = await this.getRecentIPAddresses(userId, 7); // Last 7 days
      const isNewIP = !recentIPs.includes(ipAddress);

      if (isNewIP) {
        riskFactors.push('New IP address');
        if (riskLevel === 'low') riskLevel = 'medium';
      }
    }

    // Check for unusual device characteristics
    if (this.isUnusualDevice(deviceInfo)) {
      riskFactors.push('Unusual device characteristics');
      riskLevel = 'medium';
    }

    // Check for automation/bot indicators
    if (this.isSuspiciousUserAgent(deviceInfo.browser)) {
      riskFactors.push('Suspicious user agent detected');
      riskLevel = 'high';
    }

    const isSuspicious = riskLevel === 'medium' || riskLevel === 'high';

    // Log security event if device is new or suspicious
    if (isNewDevice || isSuspicious) {
      await this.logSecurityEvent({
        userId,
        eventType: isNewDevice
          ? 'new_device_detected'
          : 'suspicious_device_activity',
        severity: riskLevel,
        description: `Device analysis: ${riskFactors.join(', ')}`,
        ipAddress,
        deviceFingerprint: deviceInfo.fingerprint,
        metadata: {
          deviceInfo,
          riskFactors,
          location,
        },
      });
    }

    return {
      isNewDevice,
      isSuspicious,
      riskLevel,
      reasons: riskFactors,
    };
  }

  /**
   * Add device as trusted
   */
  async addTrustedDevice(
    userId: number,
    deviceInfo: ParsedDeviceInfo,
    ipAddress?: string,
    location?: any,
    expiryDays: number = 30
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    await db.insert(trustedDevices).values({
      userId,
      deviceFingerprint: deviceInfo.fingerprint,
      deviceName: deviceInfo.deviceName,
      deviceType: deviceInfo.deviceType,
      browser: deviceInfo.browser,
      operatingSystem: deviceInfo.operatingSystem,
      ipAddress,
      location,
      expiresAt,
    });

    await this.logSecurityEvent({
      userId,
      eventType: 'device_trusted',
      severity: 'low',
      description: `Device marked as trusted: ${deviceInfo.deviceName}`,
      ipAddress,
      deviceFingerprint: deviceInfo.fingerprint,
    });
  }

  /**
   * Get user's trusted devices
   */
  async getTrustedDevices(userId: number): Promise<TrustedDevice[]> {
    return await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      );
  }

  /**
   * Remove trusted device
   */
  async removeTrustedDevice(
    userId: number,
    deviceId: number
  ): Promise<boolean> {
    // First check if device exists
    const existingDevice = await db
      .select()
      .from(trustedDevices)
      .where(
        and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, userId))
      );

    if (existingDevice.length > 0) {
      await db
        .update(trustedDevices)
        .set({
          isActive: false,
        })
        .where(
          and(
            eq(trustedDevices.id, deviceId),
            eq(trustedDevices.userId, userId)
          )
        );
      await this.logSecurityEvent({
        userId,
        eventType: 'device_untrusted',
        severity: 'low',
        description: 'Trusted device removed by user',
      });
      return true;
    }

    return false;
  }

  /**
   * Check if device is trusted
   */
  async isDeviceTrusted(
    userId: number,
    deviceFingerprint: string
  ): Promise<boolean> {
    const result = await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.deviceFingerprint, deviceFingerprint),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      )
      .limit(1);

    if (result.length > 0) {
      // Update last used timestamp
      await db
        .update(trustedDevices)
        .set({
          lastUsed: new Date(),
        })
        .where(eq(trustedDevices.id, result[0].id));

      return true;
    }

    return false;
  }

  /**
   * Generate device name based on parsed info
   */
  private generateDeviceName(parsedUA: UAParser.IResult): string {
    const device = parsedUA.device;
    const os = parsedUA.os;
    const browser = parsedUA.browser;

    if (device.model) {
      return `${device.vendor || ''} ${device.model || ''}`.trim();
    }

    if (device.type === 'mobile') {
      return `Mobile Device (${os.name || 'Unknown'})`;
    }

    if (device.type === 'tablet') {
      return `Tablet (${os.name || 'Unknown'})`;
    }

    return `${browser.name || 'Unknown Browser'} on ${os.name || 'Unknown OS'}`;
  }

  /**
   * Determine device type
   */
  private determineDeviceType(parsedUA: UAParser.IResult): string {
    if (parsedUA.device.type) {
      return parsedUA.device.type;
    }

    const userAgent = parsedUA.ua.toLowerCase();

    if (userAgent.includes('mobile') || userAgent.includes('android')) {
      return 'mobile';
    }

    if (userAgent.includes('tablet') || userAgent.includes('ipad')) {
      return 'tablet';
    }

    return 'desktop';
  }

  /**
   * Generate basic fingerprint from user agent
   */
  private generateBasicFingerprint(userAgent: string): string {
    return crypto
      .createHash('sha256')
      .update(userAgent)
      .digest('hex')
      .substring(0, 32);
  }

  /**
   * Check if device has unusual characteristics
   */
  private isUnusualDevice(deviceInfo: ParsedDeviceInfo): boolean {
    // Check for headless browsers or automation tools
    const suspiciousPatterns = [
      'headless',
      'phantom',
      'selenium',
      'webdriver',
      'puppeteer',
      'playwright',
      'chromedriver',
    ];

    const deviceString =
      `${deviceInfo.browser} ${deviceInfo.operatingSystem}`.toLowerCase();

    return suspiciousPatterns.some(pattern => deviceString.includes(pattern));
  }

  /**
   * Check for suspicious user agent patterns
   */
  private isSuspiciousUserAgent(browser: string): boolean {
    if (!browser || browser === 'Unknown') {
      return true;
    }

    const suspiciousPatterns = [
      'bot',
      'crawler',
      'spider',
      'scraper',
      'curl',
      'wget',
      'python',
      'go-http',
      'okhttp',
    ];

    const browserLower = browser.toLowerCase();
    return suspiciousPatterns.some(pattern => browserLower.includes(pattern));
  }

  /**
   * Get recent devices for user
   */
  private async getRecentDevices(
    userId: number,
    hours: number
  ): Promise<TrustedDevice[]> {
    const timeThreshold = new Date(Date.now() - hours * 60 * 60 * 1000);

    return await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          gt(trustedDevices.createdAt, timeThreshold)
        )
      );
  }

  /**
   * Get recent IP addresses for user
   */
  private async getRecentIPAddresses(
    userId: number,
    days: number
  ): Promise<string[]> {
    const timeThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const devices = await db
      .select({
        ipAddress: trustedDevices.ipAddress,
      })
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          gt(trustedDevices.createdAt, timeThreshold)
        )
      );

    return devices
      .map(d => d.ipAddress)
      .filter((ip): ip is string => ip !== null)
      .filter((ip, index, array) => array.indexOf(ip) === index); // Remove duplicates
  }

  /**
   * Log security event
   */
  private async logSecurityEvent(event: InsertSecurityEvent): Promise<void> {
    await db.insert(securityEvents).values(event);
  }

  /**
   * Clean up expired devices
   */
  async cleanupExpiredDevices(): Promise<void> {
    const now = new Date();

    await db
      .update(trustedDevices)
      .set({
        isActive: false,
      })
      .where(
        and(
          eq(trustedDevices.isActive, true),
          lt(trustedDevices.expiresAt, now)
        )
      );
  }

  /**
   * Get device statistics
   */
  async getDeviceStats(userId?: number): Promise<{
    totalTrusted: number;
    activeDevices: number;
    deviceTypes: Record<string, number>;
    browsers: Record<string, number>;
  }> {
    const whereCondition = userId
      ? and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      : and(
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        );

    const devices = await db
      .select()
      .from(trustedDevices)
      .where(whereCondition);

    const deviceTypes: Record<string, number> = {};
    const browsers: Record<string, number> = {};

    devices.forEach(device => {
      const type = device.deviceType || 'unknown';
      const browser = device.browser?.split(' ')[0] || 'unknown';

      deviceTypes[type] = (deviceTypes[type] || 0) + 1;
      browsers[browser] = (browsers[browser] || 0) + 1;
    });

    return {
      totalTrusted: devices.length,
      activeDevices: devices.length,
      deviceTypes,
      browsers,
    };
  }
}

export const deviceService = new DeviceService();
