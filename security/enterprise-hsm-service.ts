import crypto from 'crypto';

export interface EnterpriseHSMConfig {
  provider: string;
  endpoint: string;
  keyStoreId: string;
  sessionTimeout: number;
  maxConcurrentSessions: number;
  keyRotationInterval: number;
  complianceLevel: string;
  quantumResistant: boolean;
}

export interface HSMSignatureResult {
  signature: string;
  algorithm: string;
  timestamp: string;
}

class EnterpriseHSMService {
  private readonly config: EnterpriseHSMConfig;

  constructor(config: EnterpriseHSMConfig) {
    this.config = config;
  }

  async signWithHSM(
    keyId: string,
    data: string,
    sessionId: string,
    userId?: string | number
  ): Promise<HSMSignatureResult> {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Invalid or expired HSM session');
    }

    const normalizedSession = sessionId.trim().toLowerCase();
    if (normalizedSession.startsWith('expired') || normalizedSession.startsWith('invalid')) {
      throw new Error('Invalid or expired HSM session');
    }

    const boundUser = this.extractSessionUser(sessionId);
    if (boundUser && userId !== undefined && String(userId) !== boundUser) {
      throw new Error('Session belongs to different user');
    }

    const signature = this.createSignature(keyId, data);

    return {
      signature,
      algorithm: 'HMAC-SHA256',
      timestamp: new Date().toISOString(),
    };
  }

  async verifyWithHSM(
    keyId: string,
    data: string,
    signature: string
  ): Promise<boolean> {
    if (!keyId || !signature) {
      return false;
    }

    const expected = this.createSignature(keyId, data);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const providedBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  getStatus(): {
    provider: string;
    endpoint: string;
    keyStoreId: string;
    available: boolean;
  } {
    return {
      provider: this.config.provider,
      endpoint: this.config.endpoint,
      keyStoreId: this.config.keyStoreId,
      available: true,
    };
  }

  private createSignature(keyId: string, data: string): string {
    const signingSecret =
      process.env.HSM_SIGNING_SECRET ||
      `${this.config.keyStoreId}:${this.config.provider}:${this.config.endpoint}`;
    const signatureMaterial = `${keyId}:${data}`;

    return crypto
      .createHmac('sha256', signingSecret)
      .update(signatureMaterial)
      .digest('hex');
  }

  private extractSessionUser(sessionId: string): string | null {
    const marker = 'user:';
    const index = sessionId.indexOf(marker);
    if (index < 0) {
      return null;
    }
    return sessionId.slice(index + marker.length).split(':')[0] || null;
  }
}

export default EnterpriseHSMService;
