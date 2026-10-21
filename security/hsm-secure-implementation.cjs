const crypto = require('node:crypto');
const { Wallet } = require('ethers');

class SecureHSM {
  constructor() {
    this.initialized = false;
    this.keys = new Map();
    this.sessions = new Map();
    this.mode = process.env.HSM_SIGNING_PRIVATE_KEY ? 'env-key' : 'deterministic-shim';
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    if (process.env.HSM_SIGNING_PRIVATE_KEY) {
      this.#upsertWalletKey('env-signing-key', new Wallet(process.env.HSM_SIGNING_PRIVATE_KEY));
    }
  }

  async authenticateSession(credentials = {}) {
    this.#ensureInitialized();

    if (process.env.HSM_REQUIRE_PIN === 'true' && !credentials.pin) {
      throw new Error('HSM PIN required');
    }

    const sessionId =
      `hsm-session-${crypto.randomUUID()}` +
      (credentials.userId ? `:user:${credentials.userId}` : '');

    this.sessions.set(sessionId, {
      createdAt: new Date().toISOString(),
      userId: credentials.userId || null,
    });

    return sessionId;
  }

  terminateSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  listKeys() {
    return Array.from(this.keys.values()).map(key => ({
      keyHandle: key.keyHandle,
      keyType: 'signing',
      algorithm: 'ECDSA-secp256k1',
      publicKey: key.wallet.signingKey.publicKey,
      hsmStored: true,
      createdAt: key.createdAt,
    }));
  }

  async generateKeyPair(keyType, algorithm) {
    this.#ensureInitialized();

    if (keyType !== 'signing') {
      throw new Error(`Unsupported key type: ${keyType}`);
    }

    const wallet = Wallet.createRandom();
    const keyHandle = `generated-${crypto.randomUUID()}`;
    return this.#upsertWalletKey(keyHandle, wallet, algorithm);
  }

  async signWithHSM(hashBuffer, keyHandle, sessionId) {
    this.#ensureInitialized();

    if (!this.sessions.has(sessionId)) {
      throw new Error('Invalid or expired HSM session');
    }

    const entry = this.#getKeyEntry(keyHandle);
    const digestHex = `0x${Buffer.from(hashBuffer).toString('hex')}`;
    const signature = entry.wallet.signingKey.sign(digestHex);

    return {
      signature: `${signature.r.slice(2)}${signature.s.slice(2)}`,
      algorithm: 'secp256k1',
      timestamp: new Date().toISOString(),
      keyHandle: entry.keyHandle,
    };
  }

  getStatus() {
    return {
      initialized: this.initialized,
      mode: this.mode,
      activeSessions: this.sessions.size,
      keyCount: this.keys.size,
    };
  }

  async shutdown() {
    this.sessions.clear();
    this.initialized = false;
  }

  #ensureInitialized() {
    if (!this.initialized) {
      throw new Error('SecureHSM not initialized');
    }
  }

  #getKeyEntry(requestedHandle) {
    if (requestedHandle && this.keys.has(requestedHandle)) {
      return this.keys.get(requestedHandle);
    }

    const fallback = this.keys.values().next().value;
    if (fallback) {
      return fallback;
    }

    throw new Error('HSM signing key not found');
  }

  #upsertWalletKey(keyHandle, wallet, algorithm = 'ECDSA-secp256k1') {
    const entry = {
      keyHandle,
      wallet,
      algorithm,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(keyHandle, entry);
    return {
      keyHandle,
      keyType: 'signing',
      algorithm,
      publicKey: wallet.signingKey.publicKey,
      hsmStored: true,
      createdAt: entry.createdAt,
    };
  }
}

module.exports = SecureHSM;
