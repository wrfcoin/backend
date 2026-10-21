/**
 * IPFS Network Adapter
 * Real IPFS implementation for distributed storage
 */

const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const { storageLogger } = require('../utils/logger');

class IPFSAdapter {
  constructor(options = {}) {
    this.apiEndpoint = options.apiEndpoint || 'http://127.0.0.1:5001';
    this.gateway = options.gateway || 'https://gateway.ipfs.io';
    this.fallbackGateways = [
      'https://cloudflare-ipfs.com',
      'https://dweb.link',
      'https://gateway.pinata.cloud',
    ];
    this.isConnected = false;
    this.nodeId = null;
  }

  async initialize() {
    try {
      // Test IPFS node connection
      const response = await axios.post(`${this.apiEndpoint}/api/v0/version`);
      if (response.data && response.data.Version) {
        this.isConnected = true;
        this.nodeId = await this.getNodeId();
        storageLogger.info('Connected to IPFS node', { version: response.data.Version });
        return {
          success: true,
          message: `IPFS node v${response.data.Version} ready`,
        };
      }
    } catch (error) {
      // Fallback to public IPFS gateway for read operations
      try {
        await axios.get(
          `${this.gateway}/ipfs/QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8D2GhfbSXc/readme`
        );
        this.isConnected = true;
        storageLogger.info('Connected to public IPFS gateway (read-only)');
        return {
          success: true,
          message: 'IPFS gateway connection established (read-only)',
        };
      } catch (gatewayError) {
        storageLogger.error('Failed to connect to IPFS', { error: error.message });
        return { success: false, error: 'No IPFS connection available' };
      }
    }
  }

  async getNodeId() {
    try {
      const response = await axios.post(`${this.apiEndpoint}/api/v0/id`);
      return response.data.ID;
    } catch (error) {
      return null;
    }
  }

  async store(data) {
    if (!this.isConnected) {
      throw new Error('IPFS adapter not initialized');
    }

    if (!this.nodeId) {
      throw new Error('Cannot store to IPFS: read-only gateway mode');
    }

    try {
      const form = new FormData();
      const dataBuffer = Buffer.from(JSON.stringify(data));
      form.append('file', dataBuffer, 'data.json');

      const response = await axios.post(
        `${this.apiEndpoint}/api/v0/add?pin=true`,
        form,
        { headers: form.getHeaders() }
      );

      const result = response.data.split('\n')[0];
      const parsed = JSON.parse(result);

      return {
        hash: parsed.Hash,
        size: parsed.Size,
        timestamp: new Date().toISOString(),
        pinned: true,
      };
    } catch (error) {
      storageLogger.error('IPFS store operation failed', { error: error.message });
      throw new Error(`IPFS store failed: ${error.message}`);
    }
  }

  async retrieve(hash) {
    if (!this.isConnected) {
      throw new Error('IPFS adapter not initialized');
    }

    // Try local node first if available
    if (this.nodeId) {
      try {
        const response = await axios.post(
          `${this.apiEndpoint}/api/v0/cat?arg=${hash}`
        );
        return {
          data: response.data,
          hash,
          retrieved_at: new Date().toISOString(),
          source: 'local_node',
        };
      } catch (error) {
        storageLogger.warn('IPFS local retrieval failed, trying gateways');
      }
    }

    // Try multiple gateways for resilience
    const gateways = [this.gateway, ...this.fallbackGateways];

    for (const gateway of gateways) {
      try {
        const response = await axios.get(`${gateway}/ipfs/${hash}`, {
          timeout: 5000,
        });
        return {
          data: response.data,
          hash,
          retrieved_at: new Date().toISOString(),
          source: gateway,
        };
      } catch (error) {
        storageLogger.warn('IPFS gateway retrieval failed', { gateway, error: error.message });
      }
    }

    throw new Error(`Failed to retrieve ${hash} from all IPFS gateways`);
  }

  async pin(hash) {
    if (!this.nodeId) {
      throw new Error('Pin operation requires local IPFS node');
    }

    try {
      await axios.post(`${this.apiEndpoint}/api/v0/pin/add?arg=${hash}`);
      return { success: true, hash, pinned_at: new Date().toISOString() };
    } catch (error) {
      throw new Error(`Pin operation failed: ${error.message}`);
    }
  }

  async unpin(hash) {
    if (!this.nodeId) {
      throw new Error('Unpin operation requires local IPFS node');
    }

    try {
      await axios.post(`${this.apiEndpoint}/api/v0/pin/rm?arg=${hash}`);
      return { success: true, hash, unpinned_at: new Date().toISOString() };
    } catch (error) {
      throw new Error(`Unpin operation failed: ${error.message}`);
    }
  }

  async listPins() {
    if (!this.nodeId) {
      return { pins: [], message: 'Read-only mode: cannot list pins' };
    }

    try {
      const response = await axios.post(`${this.apiEndpoint}/api/v0/pin/ls`);
      const pins = Object.keys(response.data.Keys || {});
      return { pins, count: pins.length };
    } catch (error) {
      throw new Error(`List pins failed: ${error.message}`);
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      node_id: this.nodeId,
      endpoint: this.apiEndpoint,
      gateway: this.gateway,
      mode: this.nodeId ? 'full' : 'gateway_only',
    };
  }
}

module.exports = IPFSAdapter;
