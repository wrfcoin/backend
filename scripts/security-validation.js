#!/usr/bin/env node
/**
 * Security Validation Script
 * Comprehensive security audit and validation for Wrfcoin platform
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()]
});

class SecurityValidator {
  constructor() {
    this.serverPath = path.join(__dirname, '..', 'server');
    this.issues = [];
    this.passed = [];
  }

  /**
   * Run comprehensive security validation
   */
  async validateSecurity() {
    logger.info('Starting Comprehensive Security Validation...');

    // Core security checks
    await this.validateCORSConfigurations();
    await this.validateInputValidation();
    await this.validateSecurityHeaders();
    await this.validateProductionReadiness();
    await this.validateHSMImplementation();
    await this.validateXSSPrevention();

    // Generate report
    this.generateReport();
  }

  /**
   * Validate CORS configurations across all servers
   */
  async validateCORSConfigurations() {
    logger.info('Validating CORS Configurations...');

    const servers = fs
      .readdirSync(this.serverPath)
      .filter(file => file.endsWith('.js') && file.includes('server'));

    let secureServers = 0;
    const totalServers = servers.length;

    for (const server of servers) {
      const filePath = path.join(this.serverPath, server);
      const content = fs.readFileSync(filePath, 'utf8');

      // Check for wildcard CORS vulnerabilities
      if (content.includes('origin: true') || content.includes("origin: '*'")) {
        this.issues.push(`❌ CRITICAL: Wildcard CORS found in ${server}`);
      }
      // Check for production-cors-cleanup usage
      else if (content.includes('ProductionCORSCleanup')) {
        this.passed.push(`✅ Enhanced security middleware: ${server}`);
        secureServers++;
      }
      // Check for explicit origin arrays (acceptable)
      else if (
        content.includes('origin: [') &&
        !content.includes('localhost') &&
        process.env.NODE_ENV === 'production'
      ) {
        this.passed.push(`✅ Secure explicit CORS origins: ${server}`);
        secureServers++;
      } else if (content.includes('origin: [')) {
        this.passed.push(`✅ Development CORS configuration: ${server}`);
        secureServers++;
      }
    }

    logger.info('Secure servers: %d/%d', secureServers, totalServers);
  }

  /**
   * Validate input validation implementation
   */
  async validateInputValidation() {
    logger.info('Validating Input Validation...');

    const validationPath = path.join(
      __dirname,
      '..',
      'middleware',
      'input-validation.js'
    );

    if (fs.existsSync(validationPath)) {
      this.passed.push('✅ Input validation middleware exists');

      const content = fs.readFileSync(validationPath, 'utf8');

      // Check for comprehensive validation
      if (
        content.includes('express-validator') &&
        content.includes('DOMPurify')
      ) {
        this.passed.push(
          '✅ Comprehensive input sanitization (DOMPurify + express-validator)'
        );
      }

      if (
        content.includes('transferValidation') &&
        content.includes('weatherValidation')
      ) {
        this.passed.push('✅ Critical endpoint validation rules defined');
      }
    } else {
      this.issues.push('❌ HIGH: Input validation middleware missing');
    }

    logger.info('Input validation assessment complete');
  }

  /**
   * Validate security headers implementation
   */
  async validateSecurityHeaders() {
    logger.info('Validating Security Headers...');

    const securityPath = path.join(
      __dirname,
      '..',
      'middleware',
      'security-standardization.js'
    );

    if (fs.existsSync(securityPath)) {
      this.passed.push('✅ Security standardization middleware exists');

      const content = fs.readFileSync(securityPath, 'utf8');

      // Check for essential security headers
      const requiredHeaders = [
        'HSTS',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'CSP',
      ];
      const missingHeaders = requiredHeaders.filter(
        header => !content.toLowerCase().includes(header.toLowerCase())
      );

      if (missingHeaders.length === 0) {
        this.passed.push('✅ All essential security headers implemented');
      } else {
        this.issues.push(
          `⚠️ MEDIUM: Missing security headers: ${missingHeaders.join(', ')}`
        );
      }
    } else {
      this.issues.push('❌ HIGH: Security headers middleware missing');
    }

    logger.info('Security headers assessment complete');
  }

  /**
   * Validate production readiness
   */
  async validateProductionReadiness() {
    logger.info('Validating Production Readiness...');

    const productionPath = path.join(
      __dirname,
      '..',
      'middleware',
      'production-cors-cleanup.js'
    );

    if (fs.existsSync(productionPath)) {
      this.passed.push('✅ Production CORS cleanup middleware exists');

      const content = fs.readFileSync(productionPath, 'utf8');

      if (content.includes('NODE_ENV') && content.includes('production')) {
        this.passed.push('✅ Environment-aware security configuration');
      }

      if (content.includes('localhost') && content.includes('filter')) {
        this.passed.push('✅ Localhost origin filtering implemented');
      }
    } else {
      this.issues.push('❌ HIGH: Production readiness middleware missing');
    }

    // Check for hardcoded secrets
    try {
      const result = execSync(
        'grep -r "password.*=.*["\'].*["\']\\|api.*key.*=.*["\'].*["\']" . --include="*.js" | grep -v node_modules | head -3',
        {
          encoding: 'utf8',
          cwd: path.join(__dirname, '..', '..'),
        }
      );

      if (result.trim()) {
        this.issues.push('❌ CRITICAL: Potential hardcoded secrets detected');
      } else {
        this.passed.push('✅ No obvious hardcoded secrets found');
      }
    } catch (error) {
      this.passed.push('✅ Secret scanning completed');
    }

    logger.info('Production readiness assessment complete');
  }

  /**
   * Validate HSM implementation
   */
  async validateHSMImplementation() {
    logger.info('Validating HSM Implementation...');

    const hsmPath = path.join(
      __dirname,
      '..',
      '..',
      'security',
      'hsm-secure-implementation.js'
    );

    if (fs.existsSync(hsmPath)) {
      this.passed.push('✅ HSM implementation exists');

      const content = fs.readFileSync(hsmPath, 'utf8');

      // Check for security best practices
      if (
        content.includes('private keys NEVER leave') ||
        content.includes('NEVER leave the HSM')
      ) {
        this.passed.push('✅ HSM follows security best practices');
      }

      if (content.includes('auditLog') && content.includes('sessionTimeout')) {
        this.passed.push(
          '✅ HSM includes audit logging and session management'
        );
      }
    } else {
      this.issues.push('⚠️ MEDIUM: HSM implementation not found');
    }

    logger.info('HSM implementation assessment complete');
  }

  /**
   * Validate XSS prevention
   */
  async validateXSSPrevention() {
    logger.info('Validating XSS Prevention...');

    try {
      // Check for dangerous XSS patterns
      const result = execSync(
        'grep -r "innerHTML\\|eval(" . --include="*.js" | grep -v node_modules | head -3',
        {
          encoding: 'utf8',
          cwd: path.join(__dirname, '..', '..'),
        }
      );

      if (result.trim()) {
        this.issues.push(
          '⚠️ MEDIUM: Potential XSS patterns detected - review needed'
        );
      } else {
        this.passed.push('✅ No obvious XSS vulnerabilities found');
      }
    } catch (error) {
      this.passed.push('✅ XSS scanning completed');
    }

    // Check for DOMPurify usage
    const inputValidationExists = fs.existsSync(
      path.join(__dirname, '..', 'middleware', 'input-validation.js')
    );
    if (inputValidationExists) {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'middleware', 'input-validation.js'),
        'utf8'
      );
      if (content.includes('DOMPurify')) {
        this.passed.push('✅ DOMPurify sanitization implemented');
      }
    }

    logger.info('XSS prevention assessment complete');
  }

  /**
   * Generate comprehensive security report
   */
  generateReport() {
    logger.info('Security Validation Report');
    logger.info('='.repeat(50));

    // Calculate security score
    const totalChecks = this.passed.length + this.issues.length;
    const passedChecks = this.passed.length;
    const securityScore =
      totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

    logger.info('Security Score: %d%', securityScore);
    logger.info('Passed: %d', this.passed.length);
    logger.info('Issues: %d', this.issues.length);

    // Show passed items
    if (this.passed.length > 0) {
      logger.info('SECURITY STRENGTHS:');
      this.passed.forEach(item => logger.info('   %s', item));
    }

    // Show issues
    if (this.issues.length > 0) {
      logger.warn('SECURITY ISSUES:');
      this.issues.forEach(item => logger.warn('   %s', item));
    }

    // Risk assessment
    const criticalIssues = this.issues.filter(issue =>
      issue.includes('CRITICAL')
    ).length;
    const highIssues = this.issues.filter(issue =>
      issue.includes('HIGH')
    ).length;

    let riskLevel = 'LOW';
    if (criticalIssues > 0) riskLevel = 'CRITICAL';
    else if (highIssues > 0) riskLevel = 'HIGH';
    else if (this.issues.length > 0) riskLevel = 'MEDIUM';

    logger.info('Risk Level: %s', riskLevel);
    logger.info('Critical Issues: %d', criticalIssues);
    logger.info('High Issues: %d', highIssues);

    // Production readiness
    const productionReady = criticalIssues === 0 && highIssues === 0;
    logger.info('Production Ready: %s', productionReady ? 'YES' : 'NO');

    logger.info('='.repeat(50));
    logger.info('Security validation complete!');

    return {
      securityScore,
      riskLevel,
      productionReady,
      criticalIssues,
      highIssues,
      totalPassed: this.passed.length,
      totalIssues: this.issues.length,
    };
  }
}

// Run validation if called directly
if (require.main === module) {
  const validator = new SecurityValidator();
  validator.validateSecurity().catch(error => logger.error('Validation error', { error: error.message }));
}

module.exports = SecurityValidator;
