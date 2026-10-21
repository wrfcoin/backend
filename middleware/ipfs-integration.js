const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { storageLogger } = require('../server/utils/logger');

/**
 * IPFS Integration for Wrfcoin Decentralized Storage
 * Handles storage of large environmental datasets off-chain
 */

class IPFSIntegration {
  constructor() {
    this.ipfsEndpoint = process.env.IPFS_ENDPOINT || 'http://127.0.0.1:5001';
    this.pinataApiKey = process.env.PINATA_API_KEY;
    this.pinataSecretKey = process.env.PINATA_SECRET_KEY;
    this.useLocal = !this.pinataApiKey;
  }

  /**
   * Store weather data in IPFS/Pinata
   */
  async storeWeatherData(weatherData, stationId) {
    try {
      const dataPackage = {
        timestamp: new Date().toISOString(),
        stationId: stationId,
        data: weatherData,
        metadata: {
          format: 'wrfcoin-weather-v1',
          schema: 'environmental-sensor-reading',
        },
      };

      const jsonData = JSON.stringify(dataPackage, null, 2);
      const contentHash = this.generateContentHash(jsonData);

      let ipfsHash;
      if (this.useLocal) {
        ipfsHash = await this.storeToLocalIPFS(
          jsonData,
          `weather-${stationId}-${Date.now()}.json`
        );
      } else {
        ipfsHash = await this.storeToPinata(
          jsonData,
          `weather-${stationId}-${Date.now()}.json`
        );
      }

      return {
        ipfsHash,
        contentHash,
        size: Buffer.byteLength(jsonData),
        metadata: dataPackage.metadata,
      };
    } catch (error) {
      storageLogger.error('IPFS storage error', { error: error.message });
      throw error;
    }
  }

  /**
   * Store forecast model data
   */
  async storeForecastData(forecastData, modelId) {
    try {
      const dataPackage = {
        timestamp: new Date().toISOString(),
        modelId: modelId,
        forecast: forecastData,
        metadata: {
          format: 'wrfcoin-forecast-v1',
          schema: 'environmental-forecast',
        },
      };

      const jsonData = JSON.stringify(dataPackage, null, 2);
      const contentHash = this.generateContentHash(jsonData);

      let ipfsHash;
      if (this.useLocal) {
        ipfsHash = await this.storeToLocalIPFS(
          jsonData,
          `forecast-${modelId}-${Date.now()}.json`
        );
      } else {
        ipfsHash = await this.storeToPinata(
          jsonData,
          `forecast-${modelId}-${Date.now()}.json`
        );
      }

      return {
        ipfsHash,
        contentHash,
        size: Buffer.byteLength(jsonData),
        metadata: dataPackage.metadata,
      };
    } catch (error) {
      storageLogger.error('IPFS forecast storage error', { modelId, error: error.message });
      throw error;
    }
  }

  /**
   * Store to local IPFS node
   */
  async storeToLocalIPFS(data, filename) {
    try {
      // Create temporary file
      const tempDir = path.join(__dirname, '../../temp');
      await fs.mkdir(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, filename);
      await fs.writeFile(tempFile, data);

      // Simulate IPFS add (in production, use actual IPFS client)
      const hash = this.generateIPFSHash(data);

      // Store in local cache with IPFS-like hash
      const cacheDir = path.join(__dirname, '../../storage/ipfs-cache');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, hash), data);

      // Cleanup temp file
      await fs.unlink(tempFile);

      storageLogger.info('Stored to local IPFS', { hash });
      return hash;
    } catch (error) {
      storageLogger.error('Local IPFS storage error', { filename, error: error.message });
      throw error;
    }
  }

  /**
   * Store to Pinata IPFS service
   */
  async storeToPinata(data, filename) {
    if (!this.pinataApiKey) {
      throw new Error('Pinata API keys not configured');
    }

    try {
      const form = new FormData();
      form.append('file', Buffer.from(data), {
        filename: filename,
        contentType: 'application/json',
      });

      const metadata = JSON.stringify({
        name: filename,
        keyvalues: {
          project: 'wrfcoin',
          type: 'environmental-data',
        },
      });
      form.append('pinataMetadata', metadata);

      const response = await axios.post(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        form,
        {
          headers: {
            ...form.getHeaders(),
            pinata_api_key: this.pinataApiKey,
            pinata_secret_api_key: this.pinataSecretKey,
          },
        }
      );

      const ipfsHash = response.data.IpfsHash;
      storageLogger.info('Stored to Pinata IPFS', { ipfsHash });
      return ipfsHash;
    } catch (error) {
      storageLogger.error('Pinata storage error', { filename, error: error.message });
      throw error;
    }
  }

  /**
   * Retrieve data from IPFS
   */
  async retrieveData(ipfsHash) {
    try {
      if (this.useLocal) {
        const cacheDir = path.join(__dirname, '../../storage/ipfs-cache');
        const filePath = path.join(cacheDir, ipfsHash);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
      } else {
        const response = await axios.get(
          `https://gateway.pinata.cloud/ipfs/${ipfsHash}`
        );
        return response.data;
      }
    } catch (error) {
      storageLogger.error('IPFS retrieval error', { ipfsHash, error: error.message });
      throw error;
    }
  }

  /**
   * Generate content hash for verification
   */
  generateContentHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Generate IPFS-like hash for local storage
   * Uses proper multihash format with base58 encoding
   */
  generateIPFSHash(data) {
    const hash = crypto.createHash('sha256').update(data).digest();

    // Create proper multihash format (type: sha2-256, length: 32 bytes)
    const multihash = Buffer.concat([
      Buffer.from([0x12]), // sha2-256 code
      Buffer.from([0x20]), // 32 byte length
      hash,
    ]);

    // Base58 encode (simplified - for production use proper base58 library)
    const base58Chars =
      '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    let num = BigInt('0x' + multihash.toString('hex'));

    while (num > 0) {
      result = base58Chars[Number(num % 58n)] + result;
      num = num / 58n;
    }

    return 'Qm' + result.padStart(44, '1');
  }

  /**
   * Verify data integrity
   */
  async verifyDataIntegrity(ipfsHash, expectedContentHash) {
    try {
      const data = await this.retrieveData(ipfsHash);
      const actualContentHash = this.generateContentHash(JSON.stringify(data));
      return actualContentHash === expectedContentHash;
    } catch (error) {
      storageLogger.error('Data verification error', { ipfsHash, error: error.message });
      return false;
    }
  }

  /**
   * Create Merkle proof for data validation
   */
  createMerkleProof(dataHashes) {
    // Simplified Merkle tree implementation
    if (dataHashes.length === 0) return null;
    if (dataHashes.length === 1) return dataHashes[0];

    const tree = [];
    let currentLevel = dataHashes;

    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        const combined = crypto
          .createHash('sha256')
          .update(left + right)
          .digest('hex');
        nextLevel.push(combined);
      }
      tree.push(currentLevel);
      currentLevel = nextLevel;
    }

    return {
      root: currentLevel[0],
      tree: tree,
      proof: this.generateProofPath(tree),
    };
  }

  /**
   * Generate proof path for Merkle verification
   */
  generateProofPath(tree) {
    // Return path for verification (simplified)
    return tree.map(level => level[0]);
  }
}

module.exports = IPFSIntegration;
