/**
 * Developer Portal API Endpoints
 * Provides endpoints for the Developer Portal to manage API keys, check service status, and access documentation
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { appLogger } = require('../server/utils/logger');

const router = express.Router();

// Rate limiting for API key operations
const apiKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: 'Too many API key requests from this IP, please try again later.',
});

// Mock database for API keys (in production, use real database)
const apiKeys = [
  {
    id: '1',
    name: 'Production App',
    key: 'wrf_example_production_not_a_key',
    created: '2024-01-15T10:30:00Z',
    lastUsed: '2024-07-14T15:45:00Z',
    isActive: true,
    permissions: ['read', 'write'],
    rateLimitTier: 'premium',
  },
  {
    id: '2',
    name: 'Development',
    key: 'wrf_example_development_not_a_key',
    created: '2024-03-20T09:15:00Z',
    lastUsed: '2024-07-13T14:22:00Z',
    isActive: true,
    permissions: ['read'],
    rateLimitTier: 'standard',
  },
];

// Services to monitor
const SERVICES = [
  {
    name: 'Cross-Chain Protocol',
    port: 3000,
    path: '/health',
    description: 'Multi-blockchain bridge protocols',
  },
  {
    name: 'Enhanced Unified API',
    port: 3001,
    path: '/health',
    description: 'Primary application endpoints',
  },
  {
    name: 'IoT Sensor Networks',
    port: 3002,
    path: '/health',
    description: 'Environmental sensor management',
  },
  {
    name: 'Wallet Server',
    port: 4000,
    path: '/health',
    description: 'Wallet and key management',
  },
  {
    name: 'WebSocket Server',
    port: 5002,
    path: '/health',
    description: 'Real-time data streams',
  },
  {
    name: 'Governance Server',
    port: 8000,
    path: '/health',
    description: 'DAO governance and voting',
  },
  {
    name: 'Documentation Server',
    port: 3003,
    path: '/',
    description: 'API documentation and guides',
  },
];

// Helper function to check service health
const checkServiceHealth = async service => {
  const startTime = Date.now();

  try {
    const response = await fetch(
      `http://${process.env.SERVICE_HOST || 'localhost'}:${service.port}${service.path}`,
      {
        timeout: 5000,
        headers: { 'User-Agent': 'WRFCoin-Developer-Portal/1.0' },
      }
    );

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      // Service might not return JSON
    }

    return {
      name: service.name,
      status: response.ok ? 'healthy' : 'degraded',
      responseTime,
      uptime: data.uptime || null,
      port: service.port,
      description: service.description,
      lastChecked: new Date().toISOString(),
      version: data.version || '1.0.0',
      metadata: data,
    };
  } catch (error) {
    return {
      name: service.name,
      status: 'down',
      responseTime: null,
      uptime: null,
      port: service.port,
      description: service.description,
      lastChecked: new Date().toISOString(),
      error: error.message,
    };
  }
};

// API Routes

/**
 * @swagger
 * /developer/api-keys:
 *   get:
 *     summary: Get all API keys for current user
 *     tags: [Developer Portal]
 *     responses:
 *       200:
 *         description: List of API keys
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       key:
 *                         type: string
 *                       created:
 *                         type: string
 *                       lastUsed:
 *                         type: string
 *                       isActive:
 *                         type: boolean
 */
router.get('/api-keys', (req, res) => {
  // In production, filter by user ID
  const safeKeys = apiKeys.map(key => ({
    ...key,
    key: key.key.substring(0, 12) + '...', // Mask the key for security
  }));

  res.json({
    success: true,
    data: safeKeys,
  });
});

/**
 * @swagger
 * /developer/api-keys:
 *   post:
 *     summary: Create a new API key
 *     tags: [Developer Portal]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: API key created successfully
 */
router.post('/api-keys', apiKeyLimiter, (req, res) => {
  const { name, permissions = ['read'] } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      error: 'API key name is required',
    });
  }

  // Additional input validation
  if (typeof name !== 'string' || name.length > 256) {
    return res.status(400).json({
      success: false,
      error: 'API key name must be a string under 256 chars',
    });
  }
  if (!Array.isArray(permissions)) {
    return res.status(400).json({
      success: false,
      error: 'permissions must be an array',
    });
  }
  const validPermissions = ['read', 'write', 'admin'];
  for (const perm of permissions) {
    if (typeof perm !== 'string' || !validPermissions.includes(perm)) {
      return res.status(400).json({
        success: false,
        error: `Each permission must be one of: ${validPermissions.join(', ')}`,
      });
    }
  }

  const newKey = {
    id: uuidv4(),
    name: name.trim(),
    key: `wrf_${generateRandomString(32)}`,
    created: new Date().toISOString(),
    lastUsed: 'Never',
    isActive: true,
    permissions,
    rateLimitTier: 'standard',
  };

  apiKeys.push(newKey);

  res.status(201).json({
    success: true,
    data: newKey,
  });
});

/**
 * @swagger
 * /developer/api-keys/{id}:
 *   delete:
 *     summary: Delete an API key
 *     tags: [Developer Portal]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: API key deleted successfully
 */
router.delete('/api-keys/:id', (req, res) => {
  const { id } = req.params;

  // Input validation
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    return res.status(400).json({
      success: false,
      error: 'id must be a non-empty string under 100 chars',
    });
  }

  const keyIndex = apiKeys.findIndex(key => key.id === id);
  if (keyIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'API key not found',
    });
  }

  apiKeys.splice(keyIndex, 1);

  res.json({
    success: true,
    message: 'API key deleted successfully',
  });
});

/**
 * @swagger
 * /developer/services/status:
 *   get:
 *     summary: Get status of all WRFCoin services
 *     tags: [Developer Portal]
 *     responses:
 *       200:
 *         description: Service status information
 */
router.get('/services/status', async (req, res) => {
  try {
    const statusPromises = SERVICES.map(service => checkServiceHealth(service));
    const statuses = await Promise.all(statusPromises);

    const overallStatus = statuses.every(s => s.status === 'healthy')
      ? 'healthy'
      : statuses.some(s => s.status === 'degraded')
        ? 'degraded'
        : 'down';

    res.json({
      success: true,
      data: {
        overall: overallStatus,
        services: statuses,
        lastUpdated: new Date().toISOString(),
        totalServices: SERVICES.length,
        healthyServices: statuses.filter(s => s.status === 'healthy').length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to check service status',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /developer/api-spec:
 *   get:
 *     summary: Get OpenAPI specification
 *     tags: [Developer Portal]
 *     responses:
 *       200:
 *         description: OpenAPI specification
 */
let cachedSpec = null;
let cachedSpecMtime = 0;

router.get('/api-spec', (req, res) => {
  try {
    const openApiPath = path.join(__dirname, '../documentation/openapi.yaml');

    if (fs.existsSync(openApiPath)) {
      const mtime = fs.statSync(openApiPath).mtimeMs;
      if (!cachedSpec || mtime !== cachedSpecMtime) {
        const openApiContent = fs.readFileSync(openApiPath, 'utf8');
        cachedSpec = yaml.load(openApiContent);
        cachedSpecMtime = mtime;
      }

      res.json({
        success: true,
        data: cachedSpec,
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'OpenAPI specification not found',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load API specification',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /developer/endpoints:
 *   get:
 *     summary: Get available API endpoints with examples
 *     tags: [Developer Portal]
 *     responses:
 *       200:
 *         description: List of available endpoints
 */
router.get('/endpoints', (req, res) => {
  const endpoints = [
    {
      group: 'Blockchain',
      endpoints: [
        {
          path: '/api/blockchain/status',
          method: 'GET',
          description: 'Get current blockchain status and health',
          example: {
            request: 'GET /api/blockchain/status',
            response: {
              status: 'healthy',
              blockHeight: 12345,
              networkHashrate: '123.4 TH/s',
              difficulty: 1234567890,
            },
          },
        },
        {
          path: '/api/blockchain/blocks',
          method: 'GET',
          description: 'Get blockchain blocks with pagination',
          parameters: ['limit', 'offset', 'order'],
          example: {
            request: 'GET /api/blockchain/blocks?limit=10&offset=0',
            response: {
              blocks: [],
              pagination: { total: 12345, limit: 10, offset: 0 },
            },
          },
        },
      ],
    },
    {
      group: 'Weather Data',
      endpoints: [
        {
          path: '/api/weather/stations',
          method: 'GET',
          description: 'Get list of registered weather stations',
          example: {
            request: 'GET /api/weather/stations',
            response: {
              stations: [
                {
                  id: 'station-1',
                  name: 'Bryan AcuRite Station',
                  location: { lat: 30.628, lon: -96.3344 },
                  isActive: true,
                },
              ],
            },
          },
        },
        {
          path: '/api/weather/data',
          method: 'POST',
          description: 'Submit weather data from station',
          example: {
            request: 'POST /api/weather/data',
            body: {
              stationId: 'station-1',
              temperature: 25.5,
              humidity: 65,
              pressure: 1013.25,
              timestamp: '2024-07-14T18:00:00Z',
            },
          },
        },
      ],
    },
    {
      group: 'Cross-Chain Bridge',
      endpoints: [
        {
          path: '/api/bridge/status',
          method: 'GET',
          description: 'Get status of all bridge protocols',
          example: {
            request: 'GET /api/bridge/status',
            response: {
              bridges: [
                {
                  name: 'ethereum-polygon',
                  status: 'active',
                  volume24h: '1,234,567 USD',
                },
              ],
            },
          },
        },
      ],
    },
    {
      group: 'Governance',
      endpoints: [
        {
          path: '/api/governance/proposals',
          method: 'GET',
          description: 'Get active governance proposals',
          example: {
            request: 'GET /api/governance/proposals',
            response: {
              proposals: [
                {
                  id: 'prop-1',
                  title: 'Increase Block Rewards',
                  status: 'active',
                  votesFor: 1000,
                  votesAgainst: 500,
                },
              ],
            },
          },
        },
      ],
    },
  ];

  res.json({
    success: true,
    data: endpoints,
  });
});

/**
 * @swagger
 * /developer/sdk/download/{language}:
 *   get:
 *     summary: Download SDK package for specified language
 *     tags: [Developer Portal]
 *     parameters:
 *       - in: path
 *         name: language
 *         schema:
 *           type: string
 *         required: true
 *         description: Programming language (javascript, python, rust, go, react)
 *     responses:
 *       200:
 *         description: SDK package download
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/sdk/download/:language', async (req, res) => {
  const { language } = req.params;

  // Input validation
  const validLanguages = ['javascript', 'typescript', 'python', 'rust', 'go', 'react'];
  if (typeof language !== 'string' || !validLanguages.includes(language.toLowerCase())) {
    return res.status(400).json({
      success: false,
      error: `language must be one of: ${validLanguages.join(', ')}`,
    });
  }

  // Map of available SDKs with their file paths
  const sdkPackages = {
    javascript: {
      path: path.join(__dirname, '../../sdks/generated/typescript'),
      filename: 'wrfcoin-sdk-javascript-v1.2.3.zip',
      version: '1.2.3',
    },
    typescript: {
      path: path.join(__dirname, '../../sdks/generated/typescript'),
      filename: 'wrfcoin-sdk-typescript-v1.2.3.zip',
      version: '1.2.3',
    },
    python: {
      path: path.join(__dirname, '../../sdks/generated/python'),
      filename: 'wrfcoin-sdk-python-v1.0.5.zip',
      version: '1.0.5',
    },
    rust: {
      path: path.join(__dirname, '../../sdks/generated/rust'),
      filename: 'wrfcoin-sdk-rust-v0.3.0.zip',
      version: '0.3.0',
    },
    go: {
      path: path.join(__dirname, '../../sdks/generated/go'),
      filename: 'wrfcoin-sdk-go-v1.0.2.zip',
      version: '1.0.2',
    },
    react: {
      path: path.join(__dirname, '../../sdks/extensions/components/react'),
      filename: 'wrfcoin-react-components-v1.1.0.zip',
      version: '1.1.0',
    },
  };

  const sdkInfo = sdkPackages[language.toLowerCase()];

  if (!sdkInfo) {
    return res.status(404).json({
      success: false,
      error: 'SDK not found for the specified language',
      availableLanguages: Object.keys(sdkPackages),
    });
  }

  try {
    // Check if SDK directory exists
    if (!fs.existsSync(sdkInfo.path)) {
      return res.status(404).json({
        success: false,
        error: 'SDK package not found on server',
      });
    }

    // For demo purposes, create a simple zip response
    // In production, you would create an actual zip file
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sdkInfo.filename}"`
    );

    archive.pipe(res);

    // Add SDK files to the archive
    archive.directory(sdkInfo.path, false);

    // Add README with installation instructions
    const readmeContent = `# WRFCoin ${language.toUpperCase()} SDK v${sdkInfo.version}

## Installation

${getInstallationInstructions(language)}

## Quick Start

${getQuickStartGuide(language)}

## Documentation

For complete documentation, visit: https://docs.wrfcoin.org/sdk/${language}

## Support

- GitHub: https://github.com/wrfcoin/sdk-${language}
- Discord: https://discord.gg/wrfcoin
- Email: developers@wrfcoin.org
`;

    archive.append(readmeContent, { name: 'README.md' });

    // Finalize the archive
    archive.finalize();
  } catch (error) {
    appLogger.error('SDK download error', { api: 'developer-portal', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create SDK package',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /developer/sdk-info:
 *   get:
 *     summary: Get information about available SDKs
 *     tags: [Developer Portal]
 *     responses:
 *       200:
 *         description: SDK information
 */
router.get('/sdk-info', (req, res) => {
  const sdks = [
    {
      name: 'JavaScript/TypeScript',
      status: 'available',
      version: '1.2.3',
      description:
        'Complete SDK with TypeScript support for Node.js and browser environments',
      installCommand: 'npm install @wrfcoin/sdk',
      docsUrl: '/docs/sdk/javascript',
      repositoryUrl: 'https://github.com/wrfcoin/sdk-js',
      examples: [
        {
          title: 'Initialize SDK',
          code: `import { WRFCoinSDK } from '@wrfcoin/sdk';

const sdk = new WRFCoinSDK({
  apiKey: 'your-api-key',
  network: 'mainnet'
});`,
        },
        {
          title: 'Get Weather Data',
          code: `const weatherData = await sdk.weather.getStations();
console.log(weatherData);`,
        },
      ],
    },
    {
      name: 'React Components',
      status: 'available',
      version: '1.1.0',
      description: 'Pre-built React components for rapid dApp development',
      installCommand: 'npm install @wrfcoin/react-components',
      docsUrl: '/docs/sdk/react',
      examples: [
        {
          title: 'Weather Station Component',
          code: `import { WeatherStation } from '@wrfcoin/react-components';

<WeatherStation stationId="station-1" />`,
        },
      ],
    },
    {
      name: 'Python',
      status: 'available',
      version: '1.0.5',
      description: 'Comprehensive Python SDK with async/await support',
      installCommand: 'pip install wrfcoin-sdk',
      docsUrl: '/docs/sdk/python',
      examples: [
        {
          title: 'Basic Usage',
          code: `from wrfcoin_sdk import WRFCoinClient

client = WRFCoinClient(api_key='your-api-key')
status = await client.blockchain.get_status()
print(status)`,
        },
      ],
    },
    {
      name: 'Rust',
      status: 'available',
      version: '0.3.0',
      description: 'High-performance Rust SDK for system-level integration',
      installCommand: 'cargo add wrfcoin-sdk',
      docsUrl: '/docs/sdk/rust',
      examples: [
        {
          title: 'Blockchain Client',
          code: `use wrfcoin_sdk::BlockchainClient;

let client = BlockchainClient::new("your-api-key");
let status = client.get_status().await?;`,
        },
      ],
    },
    {
      name: 'Go',
      status: 'available',
      version: '1.0.2',
      description: 'Idiomatic Go SDK for microservice integration',
      installCommand: 'go get github.com/wrfcoin/sdk-go',
      docsUrl: '/docs/sdk/go',
    },
    {
      name: 'Java',
      status: 'coming_soon',
      version: null,
      description: 'Enterprise Java SDK for Spring Boot applications',
      eta: 'Q4 2024',
    },
    {
      name: 'C#',
      status: 'coming_soon',
      version: null,
      description: '.NET SDK for Windows and cross-platform applications',
      eta: 'Q1 2025',
    },
    {
      name: 'Swift',
      status: 'coming_soon',
      version: null,
      description: 'iOS SDK for mobile applications',
      eta: 'Q2 2025',
    },
  ];

  res.json({
    success: true,
    data: sdks,
  });
});

// Helper function to generate random strings
const generateRandomString = length => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Helper function to get installation instructions for different languages
const getInstallationInstructions = language => {
  const instructions = {
    javascript: `\`\`\`bash
npm install @wrfcoin/sdk
# or
yarn add @wrfcoin/sdk
\`\`\``,
    typescript: `\`\`\`bash
npm install @wrfcoin/sdk
# or
yarn add @wrfcoin/sdk
\`\`\``,
    python: `\`\`\`bash
pip install wrfcoin-sdk
# or
poetry add wrfcoin-sdk
\`\`\``,
    rust: `Add to your \`Cargo.toml\`:
\`\`\`toml
[dependencies]
wrfcoin-sdk = "0.3.0"
\`\`\``,
    go: `\`\`\`bash
go get github.com/wrfcoin/sdk-go
\`\`\``,
    react: `\`\`\`bash
npm install @wrfcoin/react-components
# or
yarn add @wrfcoin/react-components
\`\`\``,
  };
  return instructions[language] || 'Installation instructions not available.';
};

// Helper function to get quick start guide for different languages
const getQuickStartGuide = language => {
  const guides = {
    javascript: `\`\`\`javascript
import { WRFCoinSDK } from '@wrfcoin/sdk';

const sdk = new WRFCoinSDK({
  apiKey: 'your-api-key',
  network: 'mainnet'
});

async function main() {
  const status = await sdk.blockchain.getStatus();
  console.log('Blockchain Status:', status);
}

main();
\`\`\``,
    typescript: `\`\`\`typescript
import { WRFCoinSDK, BlockchainStatus } from '@wrfcoin/sdk';

const sdk = new WRFCoinSDK({
  apiKey: 'your-api-key',
  network: 'mainnet'
});

async function main(): Promise<void> {
  const status: BlockchainStatus = await sdk.blockchain.getStatus();
  console.log('Blockchain Status:', status);
}

main();
\`\`\``,
    python: `\`\`\`python
from wrfcoin_sdk import WRFCoinClient
import asyncio

async def main():
    client = WRFCoinClient(api_key='your-api-key')
    status = await client.blockchain.get_status()
    print("Blockchain Status:", status)

asyncio.run(main())
\`\`\``,
    rust: `\`\`\`rust
use wrfcoin_sdk::BlockchainClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = BlockchainClient::new("your-api-key");
    let status = client.get_status().await?;
    println!("Blockchain Status: {:?}", status);
    Ok(())
}
\`\`\``,
    go: `\`\`\`go
package main

import (
    "fmt"
    "github.com/wrfcoin/sdk-go"
)

func main() {
    client := wrfcoin.NewClient("your-api-key")
    status, err := client.Blockchain.GetStatus()
    if err != nil {
        panic(err)
    }
    fmt.Printf("Blockchain Status: %+v\\n", status)
}
\`\`\``,
    react: `\`\`\`jsx
import React from 'react';
import { WRFCoinProvider, WeatherStation } from '@wrfcoin/react-components';

function App() {
  return (
    <WRFCoinProvider apiKey="your-api-key">
      <WeatherStation stationId="station-1" />
    </WRFCoinProvider>
  );
}

export default App;
\`\`\``,
  };
  return guides[language] || 'Quick start guide not available.';
};

/**
 * @swagger
 * /developer/tutorials:
 *   get:
 *     summary: Get available tutorials
 *     tags: [Developer Portal]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category (beginner, intermediate, advanced)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search tutorials by title or description
 *     responses:
 *       200:
 *         description: List of tutorials
 */
router.get('/tutorials', (req, res) => {
  const { category, search } = req.query;

  // Input validation
  const validCategories = ['beginner', 'intermediate', 'advanced'];
  if (category !== undefined && (typeof category !== 'string' || !validCategories.includes(category))) {
    return res.status(400).json({
      success: false,
      error: `category must be one of: ${validCategories.join(', ')}`,
    });
  }
  if (search !== undefined && (typeof search !== 'string' || search.length > 200)) {
    return res.status(400).json({
      success: false,
      error: 'search must be a string under 200 chars',
    });
  }

  let tutorials = [
    {
      id: 'getting-started',
      title: 'Getting Started with WRFCoin API',
      description:
        "Learn the basics of integrating with WRFCoin's blockchain and weather data APIs",
      category: 'beginner',
      duration: '15 minutes',
      difficulty: 'Beginner',
      rating: 4.8,
      completions: 2847,
      tags: ['api', 'blockchain', 'weather'],
      steps: [
        {
          id: 1,
          title: 'API Key Setup',
          description: 'Learn how to obtain and configure your API key',
        },
        {
          id: 2,
          title: 'First API Call',
          description: 'Make your first successful API call',
        },
        {
          id: 3,
          title: 'Error Handling',
          description: 'Implement proper error handling',
        },
        {
          id: 4,
          title: 'Rate Limiting',
          description: 'Understand and respect rate limits',
        },
      ],
    },
    {
      id: 'weather-integration',
      title: 'Weather Data Integration',
      description:
        'Build a weather station integration that submits data to the blockchain',
      category: 'intermediate',
      duration: '30 minutes',
      difficulty: 'Intermediate',
      rating: 4.9,
      completions: 1523,
      tags: ['weather', 'iot', 'sensors'],
      steps: [
        {
          id: 1,
          title: 'Station Registration',
          description: 'Register your weather station',
        },
        {
          id: 2,
          title: 'Data Collection',
          description: 'Collect weather data from sensors',
        },
        {
          id: 3,
          title: 'Validation & Submission',
          description: 'Validate and submit data',
        },
        {
          id: 4,
          title: 'Reward Claiming',
          description: 'Claim rewards for quality data',
        },
      ],
    },
    {
      id: 'cross-chain-bridge',
      title: 'Cross-Chain Asset Transfers',
      description:
        "Implement cross-chain transfers using WRFCoin's bridge protocols",
      category: 'advanced',
      duration: '45 minutes',
      difficulty: 'Advanced',
      rating: 4.7,
      completions: 892,
      tags: ['cross-chain', 'defi', 'bridges'],
      steps: [
        {
          id: 1,
          title: 'Bridge Selection',
          description: 'Choose the right bridge protocol',
        },
        {
          id: 2,
          title: 'Asset Preparation',
          description: 'Prepare assets for transfer',
        },
        {
          id: 3,
          title: 'Transfer Execution',
          description: 'Execute the cross-chain transfer',
        },
        {
          id: 4,
          title: 'Confirmation Handling',
          description: 'Handle transfer confirmations',
        },
      ],
    },
  ];

  // Apply filters
  if (category) {
    tutorials = tutorials.filter(tutorial => tutorial.category === category);
  }

  if (search) {
    const searchLower = search.toLowerCase();
    tutorials = tutorials.filter(
      tutorial =>
        tutorial.title.toLowerCase().includes(searchLower) ||
        tutorial.description.toLowerCase().includes(searchLower) ||
        tutorial.tags.some(tag => tag.toLowerCase().includes(searchLower))
    );
  }

  res.json({
    success: true,
    data: tutorials,
  });
});

/**
 * @swagger
 * /developer/tutorials/{id}:
 *   get:
 *     summary: Get tutorial details by ID
 *     tags: [Developer Portal]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: Tutorial ID
 *     responses:
 *       200:
 *         description: Tutorial details
 */
router.get('/tutorials/:id', (req, res) => {
  const { id } = req.params;

  // Input validation
  if (typeof id !== 'string' || id.length === 0 || id.length > 100 || !/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({
      success: false,
      error: 'Tutorial id must be a non-empty alphanumeric string with hyphens, under 100 chars',
    });
  }

  // Mock tutorial content - in production this would come from a database
  const tutorialContent = {
    'getting-started': {
      id: 'getting-started',
      title: 'Getting Started with WRFCoin API',
      description: 'Complete guide to get you started with WRFCoin development',
      steps: [
        {
          id: 1,
          title: 'API Key Setup',
          content: `# API Key Setup

To get started with the WRFCoin API, you'll need to obtain an API key:

1. Visit the Developer Portal
2. Create a new API key
3. Copy the key and store it securely

## Example Usage

\`\`\`javascript
const sdk = new WRFCoinSDK({
  apiKey: 'your-api-key-here',
  network: 'mainnet'
});
\`\`\``,
          codeExample: `import { WRFCoinSDK } from '@wrfcoin/sdk';

const sdk = new WRFCoinSDK({
  apiKey: process.env.WRFCOIN_API_KEY,
  network: 'mainnet'
});

console.log('SDK initialized successfully!');`,
        },
        {
          id: 2,
          title: 'First API Call',
          content: `# Making Your First API Call

Now that you have your API key set up, let's make your first API call to get the blockchain status.`,
          codeExample: `async function getBlockchainStatus() {
  try {
    const status = await sdk.blockchain.getStatus();
    console.log('Blockchain Status:', status);
    return status;
  } catch (error) {
    console.error('Error:', error);
  }
}`,
        },
      ],
    },
  };

  const tutorial = tutorialContent[id];

  if (!tutorial) {
    return res.status(404).json({
      success: false,
      error: 'Tutorial not found',
    });
  }

  res.json({
    success: true,
    data: tutorial,
  });
});

/**
 * @swagger
 * /developer/playground/execute:
 *   post:
 *     summary: Execute code in the playground
 *     tags: [Developer Portal]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               code:
 *                 type: string
 *               language:
 *                 type: string
 *     responses:
 *       200:
 *         description: Code execution result
 */
router.post('/playground/execute', async (req, res) => {
  const { code, language = 'javascript' } = req.body;

  if (!code) {
    return res.status(400).json({
      success: false,
      error: 'Code is required',
    });
  }

  // Additional input validation
  if (typeof code !== 'string' || code.length > 10000) {
    return res.status(400).json({
      success: false,
      error: 'code must be a string under 10000 chars',
    });
  }
  const validPlaygroundLanguages = ['javascript', 'python', 'typescript'];
  if (typeof language !== 'string' || !validPlaygroundLanguages.includes(language.toLowerCase())) {
    return res.status(400).json({
      success: false,
      error: `language must be one of: ${validPlaygroundLanguages.join(', ')}`,
    });
  }

  try {
    // Simulate code execution
    await new Promise(resolve =>
      setTimeout(resolve, Math.random() * 2000 + 500)
    );

    // Mock execution result
    const result = {
      success: true,
      output:
        language === 'javascript'
          ? `// Output
Blockchain Status: {
  "status": "healthy",
  "blockHeight": ${Math.floor(Math.random() * 10000) + 10000},
  "networkHashrate": "${(Math.random() * 500 + 100).toFixed(1)} TH/s",
  "difficulty": ${Math.floor(Math.random() * 1000000000) + 1000000000},
  "timestamp": "${new Date().toISOString()}"
}`
          : `# Output
Blockchain Status: {
  'status': 'healthy',
  'blockHeight': ${Math.floor(Math.random() * 10000) + 10000},
  'networkHashrate': '${(Math.random() * 500 + 100).toFixed(1)} TH/s',
  'difficulty': ${Math.floor(Math.random() * 1000000000) + 1000000000},
  'timestamp': '${new Date().toISOString()}'
}`,
      executionTime: Math.random() * 2 + 0.5,
    };

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Code execution failed',
      details: error.message,
    });
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  appLogger.error('Developer Portal API Error', { api: 'developer-portal', error: error.message, stack: error.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined,
  });
});

module.exports = router;
