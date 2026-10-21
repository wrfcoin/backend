#!/usr/bin/env node

/**
 * API Connectivity Fix Tool
 * Diagnoses and resolves API connectivity issues affecting the frontend
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

class APIConnectivityFix {
  constructor() {
    this.issues = [];
    this.fixes = [];
    this.testResults = [];
  }

  async diagnoseAndFix() {
    logger.info('Diagnosing API Connectivity Issues...');

    await this.checkRunningServers();
    await this.testAPIEndpoints();
    await this.fixCommonIssues();
    await this.generateReport();
  }

  async checkRunningServers() {
    logger.info('Checking server status...');

    const expectedServers = [
      { name: 'Unified API Server', port: 3000 },
      { name: 'Cross-Chain Protocol', port: 8001 },
      { name: 'Enhanced Weather Rewards', port: 6004 },
      { name: 'WebSocket Server', port: 8080 },
      { name: 'Storage Networks', port: 6002 },
      { name: 'IoT Sensor Networks', port: 6003 },
    ];

    for (const server of expectedServers) {
      try {
        const isRunning = await this.testPort(server.port);
        if (isRunning) {
          logger.info(`${server.name} (port ${server.port}) - Running`);
        } else {
          logger.warn(`${server.name} (port ${server.port}) - Not responding`);
          this.issues.push(
            `${server.name} not responding on port ${server.port}`
          );
        }
      } catch (error) {
        logger.error(`${server.name} (port ${server.port}) - Error`, { error: error.message });
        this.issues.push(`${server.name} error: ${error.message}`);
      }
    }
  }

  async testAPIEndpoints() {
    logger.info('Testing API endpoints...');

    const endpoints = [
      'http://localhost:3000/api/blockchain/status',
      'http://localhost:3000/api/mining/cross-chain-rewards',
      'http://localhost:3000/api/wallet/balance',
      'http://localhost:6004/api/weather/rewards',
      'http://localhost:8001/api/cross-chain/status',
    ];

    for (const endpoint of endpoints) {
      try {
        const result = await this.makeRequest(endpoint);
        logger.info(`${endpoint} - Status: ${result.status}`);
        this.testResults.push({
          endpoint,
          status: result.status,
          success: true,
        });
      } catch (error) {
        logger.error(`${endpoint} - Error`, { error: error.message });
        this.testResults.push({
          endpoint,
          error: error.message,
          success: false,
        });

        if (error.message.includes('426')) {
          this.issues.push(`HTTP 426 error on ${endpoint} - Upgrade Required`);
        } else if (error.message.includes('ECONNREFUSED')) {
          this.issues.push(
            `Connection refused to ${endpoint} - Server not running`
          );
        }
      }
    }
  }

  async fixCommonIssues() {
    logger.info('Applying fixes...');

    // Fix 1: Update API endpoints to use correct ports
    await this.updateAPIConfiguration();

    // Fix 2: Fix CORS issues after our security update
    await this.ensureCORSCompatibility();

    // Fix 3: Fix circuit breaker configuration
    await this.fixCircuitBreakerConfig();

    // Fix 4: Add HTTP/HTTPS protocol handling
    await this.fixProtocolHandling();
  }

  async updateAPIConfiguration() {
    logger.info('Updating API configuration...');

    const apiConfigFile = 'frontend/src/services/api.js';
    if (!fs.existsSync(apiConfigFile)) {
      logger.warn('API config file not found, skipping...');
      return;
    }

    try {
      let content = fs.readFileSync(apiConfigFile, 'utf8');

      // Update API base URLs to use correct ports
      const updates = [
        {
          pattern: /baseURL:\s*['"](http:\/\/[^'"]*)['"]/g,
          replacement: "baseURL: 'http://localhost:3000/api'",
        },
        {
          pattern: /const\s+API_BASE_URL\s*=\s*['"](http:\/\/[^'"]*)['"]/g,
          replacement: "const API_BASE_URL = 'http://localhost:3000/api'",
        },
      ];

      let hasChanges = false;
      for (const update of updates) {
        if (content.match(update.pattern)) {
          content = content.replace(update.pattern, update.replacement);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        fs.writeFileSync(apiConfigFile, content);
        logger.info('Updated API configuration');
        this.fixes.push('Updated API base URLs to use correct ports');
      }
    } catch (error) {
      logger.error('Failed to update API config', { error: error.message });
    }
  }

  async ensureCORSCompatibility() {
    logger.info('Ensuring CORS compatibility...');

    // Check if our CORS fixes broke frontend connectivity
    const unifiedServerFile = 'backend/server/unified_api_server.js';
    if (!fs.existsSync(unifiedServerFile)) {
      logger.warn('Unified API server file not found');
      return;
    }

    try {
      let content = fs.readFileSync(unifiedServerFile, 'utf8');

      // Ensure localhost is included in CORS origins
      if (content.includes('cors') && !content.includes('localhost:5000')) {
        content = content.replace(
          /'http:\/\/localhost:5000'/g,
          "'http://localhost:5000', 'http://0.0.0.0:5000'"
        );

        // Add the frontend dev server origin
        if (!content.includes('localhost:5173')) {
          content = content.replace(
            /'http:\/\/0\.0\.0\.0:5000'/g,
            "'http://0.0.0.0:5000', 'http://localhost:5173'"
          );
        }

        fs.writeFileSync(unifiedServerFile, content);
        logger.info('Updated CORS configuration for frontend compatibility');
        this.fixes.push('Added frontend development server to CORS origins');
      }
    } catch (error) {
      logger.error('Failed to update CORS config', { error: error.message });
    }
  }

  async fixCircuitBreakerConfig() {
    logger.info('Fixing circuit breaker configuration...');

    const apiServiceFile = 'frontend/src/services/api.js';
    if (!fs.existsSync(apiServiceFile)) {
      logger.warn('API service file not found');
      return;
    }

    try {
      let content = fs.readFileSync(apiServiceFile, 'utf8');

      // Fix circuit breaker timeouts and thresholds
      const circuitBreakerFixes = [
        {
          pattern: /timeout:\s*\d+/g,
          replacement: 'timeout: 10000',
        },
        {
          pattern: /errorThresholdPercentage:\s*\d+/g,
          replacement: 'errorThresholdPercentage: 70',
        },
        {
          pattern: /resetTimeout:\s*\d+/g,
          replacement: 'resetTimeout: 30000',
        },
      ];

      let hasChanges = false;
      for (const fix of circuitBreakerFixes) {
        if (content.match(fix.pattern)) {
          content = content.replace(fix.pattern, fix.replacement);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        fs.writeFileSync(apiServiceFile, content);
        logger.info('Updated circuit breaker configuration');
        this.fixes.push('Relaxed circuit breaker timeouts and thresholds');
      }
    } catch (error) {
      logger.error('Failed to update circuit breaker config', { error: error.message });
    }
  }

  async fixProtocolHandling() {
    logger.info('Fixing HTTP/HTTPS protocol handling...');

    // Add protocol detection and fallback
    const protocolFix = `
// Protocol detection and fallback
const detectProtocol = () => {
    if (typeof window !== 'undefined') {
        return window.location.protocol;
    }
    return 'http:';
};

const getBaseURL = () => {
    const protocol = detectProtocol();
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    const port = protocol === 'https:' ? '443' : '3000';
    
    if (host.includes('replit.dev')) {
        return \`\${protocol}//\${host}/api\`;
    }
    
    return \`\${protocol}//\${host}:\${port}/api\`;
};
`;

    const apiServiceFile = 'frontend/src/services/api.js';
    if (fs.existsSync(apiServiceFile)) {
      try {
        let content = fs.readFileSync(apiServiceFile, 'utf8');

        if (!content.includes('detectProtocol')) {
          // Add protocol detection at the top
          content = protocolFix + '\n' + content;

          // Replace static baseURL with dynamic one
          content = content.replace(
            /baseURL:\s*['"][^'"]*['"]/g,
            'baseURL: getBaseURL()'
          );

          fs.writeFileSync(apiServiceFile, content);
          logger.info('Added protocol detection and dynamic base URL');
          this.fixes.push('Added dynamic protocol and host detection');
        }
      } catch (error) {
        logger.error('Failed to add protocol handling', { error: error.message });
      }
    }
  }

  async testPort(port) {
    return new Promise(resolve => {
      const server = http.createServer();

      server.listen(port, () => {
        server.close(() => {
          resolve(false); // Port is available, so nothing is running on it
        });
      });

      server.on('error', () => {
        resolve(true); // Port is in use, so something is running
      });
    });
  }

  async makeRequest(url) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: 5000,
      };

      const req = http.request(options, res => {
        resolve({ status: res.statusCode });
      });

      req.on('error', error => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  async generateReport() {
    logger.info('='.repeat(60));
    logger.info('API CONNECTIVITY FIX REPORT');
    logger.info('='.repeat(60));

    logger.info('SUMMARY:', {
      issuesFound: this.issues.length,
      fixesApplied: this.fixes.length,
      endpointsTested: this.testResults.length
    });

    if (this.issues.length > 0) {
      logger.warn('ISSUES FOUND:', { issues: this.issues });
    }

    if (this.fixes.length > 0) {
      logger.info('FIXES APPLIED:', { fixes: this.fixes });
    }

    logger.info('ENDPOINT TEST RESULTS:');
    for (const result of this.testResults) {
      if (result.success) {
        logger.info(`${result.endpoint} - Status: ${result.status}`);
      } else {
        logger.error(`${result.endpoint} - Error`, { error: result.error });
      }
    }

    logger.info('NEXT STEPS:', {
      steps: [
        '1. Restart the Frontend Application workflow',
        '2. Test the dashboard for improved connectivity',
        '3. Monitor circuit breaker status',
        '4. Check browser console for remaining errors'
      ]
    });

    logger.info('='.repeat(60));
  }
}

// Run fix if called directly
if (require.main === module) {
  const fix = new APIConnectivityFix();
  fix.diagnoseAndFix().catch(error => logger.error('Fix failed', { error: error.message }));
}

module.exports = APIConnectivityFix;
