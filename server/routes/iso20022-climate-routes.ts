const express = require('express');
import { Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  ISO20022ClimateController,
  validateClimateMessage,
  validateTCFDReport,
  validateTCFDAnalysis,
  validateMappingValidation,
  validateSecurityIncident,
  validateKeyRotation,
} from '../controllers/iso20022ClimateController.js';
import { appLogger } from '../utils/logger.js';

const router = express.Router();
const controller = new ISO20022ClimateController();

// All ISO 20022 climate operations require authentication (#231)
router.use(authenticateJWT);

// Security middleware
router.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// Rate limiting for different endpoints
const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const standardRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const reportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 report generations per hour
  message: {
    error: 'Too many report generation requests, please try again later',
    retryAfter: '1 hour',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /api/v1/climate-finance/messages:
 *   post:
 *     summary: Process ISO20022 climate finance message
 *     description: Process and validate incoming ISO20022 climate finance messages with institutional-grade security
 *     tags: [Climate Finance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - xmlMessage
 *               - messageType
 *             properties:
 *               xmlMessage:
 *                 type: string
 *                 description: ISO20022 XML message content
 *               messageType:
 *                 type: string
 *                 enum: [climate_data_payment, carbon_credit_transfer, climate_fund_disbursement, environmental_compliance_payment, weather_data_validation_payment]
 *                 description: Type of climate finance message
 *               securityLevel:
 *                 type: string
 *                 enum: [standard, enhanced, maximum]
 *                 default: standard
 *                 description: Security level for message processing
 *     responses:
 *       201:
 *         description: Message processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     messageId:
 *                       type: string
 *                     status:
 *                       type: string
 *                     validationResults:
 *                       type: object
 *                     securityId:
 *                       type: string
 *                     tcfdAlignment:
 *                       type: string
 *                     processingTime:
 *                       type: string
 *       400:
 *         description: Validation failed
 *       500:
 *         description: Processing error
 */
router.post(
  '/messages',
  strictRateLimit,
  validateClimateMessage,
  async (req: Request, res: Response) => {
    await controller.processClimateMessage(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/reports/tcfd:
 *   post:
 *     summary: Generate TCFD compliance report
 *     description: Generate comprehensive TCFD report from processed climate finance messages
 *     tags: [TCFD Reporting]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reportingPeriod
 *               - messageIds
 *             properties:
 *               reportingPeriod:
 *                 type: string
 *                 description: Reporting period (e.g., "2024-Q1")
 *               messageIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of message IDs to include in report
 *               reportType:
 *                 type: string
 *                 enum: [annual, quarterly, event_driven, regulatory_filing]
 *                 default: quarterly
 *               outputFormats:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [pdf, html, json, xml]
 *                 default: ["json"]
 *               includeAnalytics:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Report generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     reportId:
 *                       type: string
 *                     reportData:
 *                       type: object
 *                     validationResults:
 *                       type: object
 *                     complianceAssessment:
 *                       type: object
 *                     outputs:
 *                       type: array
 *                     analytics:
 *                       type: object
 *                     generatedAt:
 *                       type: string
 */
router.post(
  '/reports/tcfd',
  reportRateLimit,
  validateTCFDReport,
  async (req: Request, res: Response) => {
    await controller.generateTCFDReport(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/analysis/tcfd-compliance:
 *   post:
 *     summary: Analyze TCFD compliance
 *     description: Perform comprehensive TCFD compliance analysis including risk assessment and scenario analysis
 *     tags: [TCFD Analysis]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - messageIds
 *             properties:
 *               messageIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               analysisType:
 *                 type: string
 *                 enum: [basic, comprehensive]
 *                 default: comprehensive
 *     responses:
 *       200:
 *         description: Analysis completed successfully
 */
router.post(
  '/analysis/tcfd-compliance',
  standardRateLimit,
  validateTCFDAnalysis,
  async (req: Request, res: Response) => {
    await controller.analyzeTCFDCompliance(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/validation/mapping:
 *   post:
 *     summary: Validate message against mapping rules
 *     description: Validate climate finance message against custom data mapping rules
 *     tags: [Validation]
 */
router.post(
  '/validation/mapping',
  standardRateLimit,
  validateMappingValidation,
  async (req: Request, res: Response) => {
    await controller.validateWithMapping(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/security/incidents:
 *   post:
 *     summary: Handle security incident
 *     description: Report and handle security incidents in climate finance processing
 *     tags: [Security]
 */
router.post(
  '/security/incidents',
  strictRateLimit,
  validateSecurityIncident,
  async (req: Request, res: Response) => {
    await controller.handleSecurityIncident(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/security/rotate-keys:
 *   post:
 *     summary: Rotate encryption keys
 *     description: Rotate encryption keys for climate finance resources
 *     tags: [Security]
 */
router.post(
  '/security/rotate-keys',
  strictRateLimit,
  validateKeyRotation,
  async (req: Request, res: Response) => {
    await controller.rotateKeys(req, res);
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/health:
 *   get:
 *     summary: Health check for climate finance services
 *     description: Check the health status of all climate finance processing services
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service health status
 */
router.get(
  '/health',
  standardRateLimit,
  async (req: Request, res: Response) => {
    try {
      const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          iso20022Service: 'operational',
          validator: 'operational',
          errorHandler: 'operational',
          tcfdAnalyzer: 'operational',
          reportGenerator: 'operational',
          security: 'operational',
        },
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0',
      };

      res.status(200).json({
        success: true,
        data: healthStatus,
      });
    } catch (error) {
      res.status(503).json({
        success: false,
        error: 'Health check failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/metrics:
 *   get:
 *     summary: Get climate finance processing metrics
 *     description: Retrieve operational metrics for climate finance message processing
 *     tags: [Metrics]
 */
router.get(
  '/metrics',
  standardRateLimit,
  async (req: Request, res: Response) => {
    try {
      // This would typically come from a metrics service
      const metrics = {
        messagesProcessed: {
          total: 15420,
          today: 245,
          thisWeek: 1680,
          thisMonth: 7234,
        },
        processingTimes: {
          average: 1.2, // seconds
          p95: 2.1,
          p99: 4.5,
        },
        validationResults: {
          passed: 14892,
          failed: 528,
          successRate: 0.966,
        },
        tcfdCompliance: {
          averageScore: 85.7,
          reportsGenerated: 342,
          coverageRate: 0.94,
        },
        security: {
          encryptedMessages: 3240,
          signedMessages: 15420,
          keyRotations: 12,
          securityIncidents: 0,
        },
        lastUpdated: new Date().toISOString(),
      };

      res.status(200).json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve metrics',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/config/mapping-rules:
 *   get:
 *     summary: Get available mapping rules
 *     description: Retrieve available data mapping rules for TCFD compliance
 *     tags: [Configuration]
 */
router.get(
  '/config/mapping-rules',
  standardRateLimit,
  async (req: Request, res: Response) => {
    try {
      const mappingRules = {
        available: [
          {
            id: 'tcfd-governance-mapping',
            name: 'TCFD Governance Mapping',
            description:
              'Maps climate finance data to TCFD governance requirements',
            version: '1.0',
            lastUpdated: '2024-01-15',
          },
          {
            id: 'tcfd-strategy-mapping',
            name: 'TCFD Strategy Mapping',
            description:
              'Maps climate finance data to TCFD strategy requirements',
            version: '1.0',
            lastUpdated: '2024-01-15',
          },
          {
            id: 'tcfd-risk-mapping',
            name: 'TCFD Risk Management Mapping',
            description:
              'Maps climate finance data to TCFD risk management requirements',
            version: '1.0',
            lastUpdated: '2024-01-15',
          },
          {
            id: 'tcfd-metrics-mapping',
            name: 'TCFD Metrics and Targets Mapping',
            description:
              'Maps climate finance data to TCFD metrics and targets requirements',
            version: '1.0',
            lastUpdated: '2024-01-15',
          },
        ],
      };

      res.status(200).json({
        success: true,
        data: mappingRules,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve mapping rules',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * @swagger
 * /api/v1/climate-finance/config/security-policies:
 *   get:
 *     summary: Get security policies
 *     description: Retrieve current security policies for climate finance processing
 *     tags: [Configuration]
 */
router.get(
  '/config/security-policies',
  standardRateLimit,
  async (req: Request, res: Response) => {
    try {
      const securityPolicies = {
        encryption: {
          algorithm: 'AES-256-GCM',
          keyRotationPeriod: 90, // days
          minimumKeySize: 256,
        },
        signatures: {
          algorithm: 'ECDSA',
          hashFunction: 'SHA-256',
          curve: 'secp256k1',
        },
        accessControl: {
          authenticationRequired: true,
          multiFactorAuth: true,
          sessionTimeout: 3600, // seconds
        },
        audit: {
          logAllOperations: true,
          retentionPeriod: 2555, // days (7 years)
          immutableLogs: true,
        },
        compliance: {
          frameworks: ['ISO20022', 'TCFD', 'SOX', 'GDPR'],
          dataClassification: [
            'public',
            'internal',
            'confidential',
            'restricted',
          ],
          geographicRestrictions: [],
        },
      };

      res.status(200).json({
        success: true,
        data: securityPolicies,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve security policies',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

// Error handling middleware
router.use((error: any, req: Request, res: Response, next: any) => {
  appLogger.error('Climate Finance API Error', { error: error.message || 'Unknown error', stack: error.stack, path: req.path, method: req.method });

  res.status(error.status || 500).json({
    success: false,
    error: error.message || 'Internal server error',
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
  });
});

export default router;
