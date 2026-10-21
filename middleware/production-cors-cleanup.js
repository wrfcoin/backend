/**
 * Production CORS Configuration Cleanup
 * Removes localhost and development origins in production environment
 */

import SecurityStandardization from './security-standardization.js';
import { securityLogger, appLogger } from '../server/utils/logger.js';

class ProductionCORSCleanup {
  /**
   * Get environment-appropriate CORS configuration
   * Automatically removes localhost origins in production
   */
  static getSecurityMiddleware(options = {}) {
    const environment = process.env.NODE_ENV || 'development';

    if (environment === 'production') {
      securityLogger.info('Production mode detected - removing localhost origins from CORS');

      // Use strict security level for production
      return SecurityStandardization.getSecurityMiddleware({
        level: 'strict',
        customOrigins: options.customOrigins || [],
      });
    } else {
      appLogger.info('Development mode - allowing localhost origins');

      // Use standard security level for development
      return SecurityStandardization.getSecurityMiddleware({
        level: 'standard',
        customOrigins: options.customOrigins || [],
      });
    }
  }

  /**
   * Validate production CORS configuration
   * Warns if localhost origins are detected in production
   */
  static validateProductionCORS() {
    const validation = SecurityStandardization.validateSecurityConfig();
    const environment = process.env.NODE_ENV || 'development';

    if (environment === 'production') {
      const issues = [];

      // Check for localhost origins
      if (validation.issues.some(issue => issue.includes('localhost'))) {
        issues.push(
          '❌ CRITICAL: localhost origins detected in production CORS configuration'
        );
      }

      // Check for development domains
      if (validation.issues.some(issue => issue.includes('dev.'))) {
        issues.push(
          '⚠️  WARNING: development domains detected in production CORS configuration'
        );
      }

      if (issues.length > 0) {
        securityLogger.error('Production CORS Security Issues detected');
        issues.forEach(issue => securityLogger.error('CORS issue', { issue }));

        // In strict mode, exit process for critical issues
        if (process.env.STRICT_PRODUCTION_MODE === 'true') {
          securityLogger.error('Exiting due to critical production security issues');
          process.exit(1);
        }
      } else {
        appLogger.info('Production CORS configuration validated successfully');
      }
    }

    return {
      environment,
      valid: validation.valid,
      productionReady:
        environment !== 'production' || validation.issues.length === 0,
    };
  }

  /**
   * Auto-configure CORS based on environment
   * Provides seamless transition between development and production
   */
  static autoConfigureCORS(app, options = {}) {
    const middlewares = this.getSecurityMiddleware(options);

    // Apply all security middlewares
    middlewares.forEach(middleware => app.use(middleware));

    // Validate configuration
    const validation = this.validateProductionCORS();

    // Log configuration summary
    appLogger.info('CORS auto-configuration complete', {
      securityLevel: validation.environment === 'production' ? 'STRICT' : 'STANDARD',
      environment: validation.environment.toUpperCase(),
      productionReady: validation.productionReady ? 'YES' : 'NO'
    });

    return validation;
  }

  /**
   * Get production-safe origin list
   * Filters out localhost and development origins for production
   */
  static getProductionOrigins(baseOrigins = []) {
    const environment = process.env.NODE_ENV || 'development';

    if (environment === 'production') {
      // Filter out localhost and development origins
      return baseOrigins.filter(origin => {
        const isLocalhost =
          origin.includes('localhost') || origin.includes('127.0.0.1');
        const isDevelopment =
          origin.includes('dev.') || origin.includes('-dev.');

        return !isLocalhost && !isDevelopment;
      });
    }

    // In development, allow all origins
    return baseOrigins;
  }
}

export default ProductionCORSCleanup;
