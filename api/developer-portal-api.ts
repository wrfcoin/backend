/**
 * Developer Portal API - TypeScript Implementation
 * Comprehensive API key management endpoints for the developer portal
 */

import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, param, query, validationResult } from 'express-validator';
import {
  ApiKeyService,
  type CreateApiKeyRequest,
} from '../services/api-key-service.js';
import {
  apiKeyAuth,
  requireApiKey,
  requirePermissions,
} from '../middleware/api-key-auth.js';
import { API_PERMISSIONS, RATE_LIMIT_TIERS } from '../shared/schema-api-keys.js';
import { appLogger } from '../server/utils/logger.js';
import { createApiError } from '../server/utils/api-error.js';
import { corsMiddleware } from '../shared/middleware/cors-config.js';

const router = express.Router();

function sendDeveloperPortalError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return res.status(statusCode).json(createApiError(code, message, details));
}

// Apply security middleware
router.use(helmet());
router.use(corsMiddleware);

// Rate limiting for different operations
const createKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 API key creations per window
  message: {
    error: 'Too Many API Key Requests',
    message:
      'You can only create 5 API keys per 15 minutes. Please try again later.',
    retryAfter: 900,
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json(
      createApiError(
        'RATE_LIMIT_EXCEEDED',
        'You can only create 5 API keys per 15 minutes. Please try again later.',
        { retryAfter: 900 }
      )
    );
  },
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    error: 'Rate Limit Exceeded',
    message: 'Too many requests from this IP, please try again later.',
    retryAfter: 900,
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json(
      createApiError(
        'RATE_LIMIT_EXCEEDED',
        'Too many requests from this IP, please try again later.',
        { retryAfter: 900 }
      )
    );
  },
});

// Apply general rate limiting
(router as any).use(generalLimiter);

// Initialize services
const apiKeyService = new ApiKeyService();

// Validation middleware
const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    sendDeveloperPortalError(
      res,
      400,
      'VALIDATION_ERROR',
      'Validation Error',
      errors.array()
    );
    return;
  }
  next();
};

/**
 * @swagger
 * /developer/api-keys:
 *   get:
 *     summary: Get all API keys for current user
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
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
 *                     $ref: '#/components/schemas/ApiKey'
 */
router.get(
  '/api-keys',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.READ] }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;

      const apiKeys = await apiKeyService.getUserApiKeys(userId);

      // Sanitize keys for response (don't expose sensitive data)
      const sanitizedKeys = apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        description: key.description,
        keyPrefix: key.keyPrefix,
        permissions: key.permissions,
        scopes: key.scopes,
        rateLimitTier: key.rateLimitTier,
        isActive: key.isActive,
        environment: key.environment,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
        dailyRequestLimit: key.dailyRequestLimit,
        monthlyRequestLimit: key.monthlyRequestLimit,
      }));

      res.json({
        success: true,
        data: sanitizedKeys,
      });
    } catch (error) {
      appLogger.error('Error fetching API keys', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to fetch API keys');
    }
  }
);

/**
 * @swagger
 * /developer/api-keys:
 *   post:
 *     summary: Create a new API key
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 255
 *               description:
 *                 type: string
 *                 maxLength: 1000
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [read, write, admin]
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *               rateLimitTier:
 *                 type: string
 *                 enum: [basic, standard, premium, enterprise]
 *               expiryDays:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 3650
 *               allowedIps:
 *                 type: array
 *                 items:
 *                   type: string
 *               allowedDomains:
 *                 type: array
 *                 items:
 *                   type: string
 *               environment:
 *                 type: string
 *                 enum: [development, staging, production]
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/ApiKeyWithSecret'
 */
(router as any).post(
  '/api-keys',
  createKeyLimiter,
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.WRITE] }),
  [
    body('name')
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Name must be between 1 and 255 characters'),
    body('description')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Description must be less than 1000 characters'),
    body('permissions')
      .optional()
      .isArray()
      .custom((permissions: string[]) => {
        const validPermissions = Object.values(API_PERMISSIONS) as string[];
        return permissions.every(p => validPermissions.includes(p));
      })
      .withMessage('Invalid permissions provided'),
    body('scopes').optional().isArray().withMessage('Scopes must be an array'),
    body('rateLimitTier')
      .optional()
      .isIn(Object.values(RATE_LIMIT_TIERS))
      .withMessage('Invalid rate limit tier'),
    body('expiryDays')
      .optional()
      .isInt({ min: 1, max: 3650 })
      .withMessage('Expiry days must be between 1 and 3650'),
    body('allowedIps')
      .optional()
      .isArray()
      .withMessage('Allowed IPs must be an array'),
    body('allowedDomains')
      .optional()
      .isArray()
      .withMessage('Allowed domains must be an array'),
    body('environment')
      .optional()
      .isIn(['development', 'staging', 'production'])
      .withMessage('Invalid environment'),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;
      const createRequest: CreateApiKeyRequest = {
        userId,
        name: req.body.name,
        description: req.body.description,
        permissions: req.body.permissions || [API_PERMISSIONS.READ],
        scopes: req.body.scopes || ['*'],
        rateLimitTier: req.body.rateLimitTier || RATE_LIMIT_TIERS.STANDARD,
        expiryDays: req.body.expiryDays || 365,
        allowedIps: req.body.allowedIps || [],
        allowedDomains: req.body.allowedDomains || [],
        environment: req.body.environment || 'production',
      };

      const { apiKey, rawKey } =
        await apiKeyService.createApiKey(createRequest);

      res.status(201).json({
        success: true,
        data: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          key: rawKey, // Only returned on creation
          keyPrefix: apiKey.keyPrefix,
          permissions: apiKey.permissions,
          scopes: apiKey.scopes,
          rateLimitTier: apiKey.rateLimitTier,
          dailyRequestLimit: apiKey.dailyRequestLimit,
          monthlyRequestLimit: apiKey.monthlyRequestLimit,
          environment: apiKey.environment,
          expiresAt: apiKey.expiresAt,
          createdAt: apiKey.createdAt,
        },
        warning:
          'Store this API key securely. You will not be able to view it again.',
      });
    } catch (error) {
      appLogger.error('Error creating API key', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to create API key');
    }
  }
);

/**
 * @swagger
 * /developer/api-keys/{id}:
 *   get:
 *     summary: Get API key details with usage statistics
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: API key details
 */
router.get(
  '/api-keys/:id',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.READ] }),
  [param('id').isUUID().withMessage('Invalid API key ID')],
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;
      const apiKeyId = req.params.id;

      // Get all user's API keys to verify ownership
      const userApiKeys = await apiKeyService.getUserApiKeys(userId);
      const apiKey = userApiKeys.find(key => key.id === apiKeyId);

      if (!apiKey) {
        sendDeveloperPortalError(
          res,
          404,
          'API_KEY_NOT_FOUND',
          'The specified API key does not exist or you do not have access to it'
        );
        return;
      }

      // Get usage statistics
      const stats = await apiKeyService.getApiKeyStats(apiKeyId);

      res.json({
        success: true,
        data: {
          id: apiKey.id,
          name: apiKey.name,
          description: apiKey.description,
          keyPrefix: apiKey.keyPrefix,
          permissions: apiKey.permissions,
          scopes: apiKey.scopes,
          rateLimitTier: apiKey.rateLimitTier,
          dailyRequestLimit: apiKey.dailyRequestLimit,
          monthlyRequestLimit: apiKey.monthlyRequestLimit,
          isActive: apiKey.isActive,
          environment: apiKey.environment,
          allowedIps: apiKey.allowedIps,
          allowedDomains: apiKey.allowedDomains,
          expiresAt: apiKey.expiresAt,
          lastUsedAt: apiKey.lastUsedAt,
          createdAt: apiKey.createdAt,
          updatedAt: apiKey.updatedAt,
          stats,
        },
      });
    } catch (error) {
      appLogger.error('Error fetching API key details', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to fetch API key details');
    }
  }
);

/**
 * @swagger
 * /developer/api-keys/{id}:
 *   put:
 *     summary: Update API key properties
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 255
 *               description:
 *                 type: string
 *                 maxLength: 1000
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [read, write, admin]
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *               allowedIps:
 *                 type: array
 *                 items:
 *                   type: string
 *               allowedDomains:
 *                 type: array
 *                 items:
 *                   type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: API key updated successfully
 */
router.put(
  '/api-keys/:id',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.WRITE] }),
  [
    param('id').isUUID().withMessage('Invalid API key ID'),
    body('name')
      .optional()
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Name must be between 1 and 255 characters'),
    body('description')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Description must be less than 1000 characters'),
    body('permissions')
      .optional()
      .isArray()
      .custom((permissions: string[]) => {
        const validPermissions = Object.values(API_PERMISSIONS) as string[];
        return permissions.every(p => validPermissions.includes(p));
      })
      .withMessage('Invalid permissions provided'),
    body('scopes').optional().isArray().withMessage('Scopes must be an array'),
    body('allowedIps')
      .optional()
      .isArray()
      .withMessage('Allowed IPs must be an array'),
    body('allowedDomains')
      .optional()
      .isArray()
      .withMessage('Allowed domains must be an array'),
    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean'),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;
      const apiKeyId = req.params.id;

      // Verify ownership
      const userApiKeys = await apiKeyService.getUserApiKeys(userId);
      const apiKey = userApiKeys.find(key => key.id === apiKeyId);

      if (!apiKey) {
        sendDeveloperPortalError(
          res,
          404,
          'API_KEY_NOT_FOUND',
          'The specified API key does not exist or you do not have access to it'
        );
        return;
      }

      // Update the API key
      const updatedKey = await apiKeyService.updateApiKey(
        apiKeyId,
        {
          name: req.body.name,
          description: req.body.description,
          permissions: req.body.permissions,
          scopes: req.body.scopes,
          allowedIps: req.body.allowedIps,
          allowedDomains: req.body.allowedDomains,
          isActive: req.body.isActive,
        },
        userId
      );

      res.json({
        success: true,
        data: {
          id: updatedKey.id,
          name: updatedKey.name,
          description: updatedKey.description,
          keyPrefix: updatedKey.keyPrefix,
          permissions: updatedKey.permissions,
          scopes: updatedKey.scopes,
          rateLimitTier: updatedKey.rateLimitTier,
          isActive: updatedKey.isActive,
          environment: updatedKey.environment,
          allowedIps: updatedKey.allowedIps,
          allowedDomains: updatedKey.allowedDomains,
          updatedAt: updatedKey.updatedAt,
        },
      });
    } catch (error) {
      appLogger.error('Error updating API key', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to update API key');
    }
  }
);

/**
 * @swagger
 * /developer/api-keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: API key revoked successfully
 */
router.delete(
  '/api-keys/:id',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.WRITE] }),
  [
    param('id').isUUID().withMessage('Invalid API key ID'),
    body('reason')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Reason must be less than 500 characters'),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;
      const apiKeyId = req.params.id;

      // Verify ownership
      const userApiKeys = await apiKeyService.getUserApiKeys(userId);
      const apiKey = userApiKeys.find(key => key.id === apiKeyId);

      if (!apiKey) {
        sendDeveloperPortalError(
          res,
          404,
          'API_KEY_NOT_FOUND',
          'The specified API key does not exist or you do not have access to it'
        );
        return;
      }

      if (apiKey.revokedAt) {
        sendDeveloperPortalError(
          res,
          400,
          'API_KEY_ALREADY_REVOKED',
          'This API key has already been revoked'
        );
        return;
      }

      // Revoke the API key
      await apiKeyService.revokeApiKey(apiKeyId, userId, req.body.reason);

      res.json({
        success: true,
        message: 'API key revoked successfully',
      });
    } catch (error) {
      appLogger.error('Error revoking API key', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to revoke API key');
    }
  }
);

/**
 * @swagger
 * /developer/api-keys/{id}/stats:
 *   get:
 *     summary: Get detailed usage statistics for an API key
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [day, week, month, year]
 *         description: Time period for statistics
 *     responses:
 *       200:
 *         description: Usage statistics
 */
router.get(
  '/api-keys/:id/stats',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.READ] }),
  [
    param('id').isUUID().withMessage('Invalid API key ID'),
    query('period')
      .optional()
      .isIn(['day', 'week', 'month', 'year'])
      .withMessage('Invalid period'),
  ],
  validateRequest,
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;
      const apiKeyId = req.params.id;

      // Verify ownership
      const userApiKeys = await apiKeyService.getUserApiKeys(userId);
      const apiKey = userApiKeys.find(key => key.id === apiKeyId);

      if (!apiKey) {
        sendDeveloperPortalError(
          res,
          404,
          'API_KEY_NOT_FOUND',
          'The specified API key does not exist or you do not have access to it'
        );
        return;
      }

      const stats = await apiKeyService.getApiKeyStats(apiKeyId);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      appLogger.error('Error fetching API key stats', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to fetch API key statistics');
    }
  }
);

/**
 * @swagger
 * /developer/usage-analytics:
 *   get:
 *     summary: Get usage analytics dashboard data
 *     tags: [Developer Portal]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Usage analytics data
 */
router.get(
  '/usage-analytics',
  requireApiKey({ required: true, permissions: [API_PERMISSIONS.READ] }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.apiKey!.userId;

      // Get all user's API keys
      const apiKeys = await apiKeyService.getUserApiKeys(userId);

      // Get stats for each API key
      const keyStats = await Promise.all(
        apiKeys.map(async key => ({
          id: key.id,
          name: key.name,
          stats: await apiKeyService.getApiKeyStats(key.id),
        }))
      );

      // Calculate aggregate stats
      const totalRequests = keyStats.reduce(
        (sum, key) => sum + key.stats.totalRequests,
        0
      );
      const requestsToday = keyStats.reduce(
        (sum, key) => sum + key.stats.requestsToday,
        0
      );
      const requestsThisMonth = keyStats.reduce(
        (sum, key) => sum + key.stats.requestsThisMonth,
        0
      );
      const avgResponseTime =
        keyStats.length > 0
          ? keyStats.reduce(
              (sum, key) => sum + key.stats.averageResponseTime,
              0
            ) / keyStats.length
          : 0;
      const avgErrorRate =
        keyStats.length > 0
          ? keyStats.reduce((sum, key) => sum + key.stats.errorRate, 0) /
            keyStats.length
          : 0;

      res.json({
        success: true,
        data: {
          overview: {
            totalApiKeys: apiKeys.length,
            activeApiKeys: apiKeys.filter(key => key.isActive).length,
            totalRequests,
            requestsToday,
            requestsThisMonth,
            averageResponseTime: Math.round(avgResponseTime),
            errorRate: Math.round(avgErrorRate * 100) / 100,
          },
          apiKeys: keyStats,
        },
      });
    } catch (error) {
      appLogger.error('Error fetching usage analytics', { api: 'developer-portal', error: (error as Error).message });
      sendDeveloperPortalError(res, 500, 'DEVELOPER_PORTAL_ERROR', 'Failed to fetch usage analytics');
    }
  }
);

// Error handling middleware
router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  appLogger.error('Developer Portal API Error', { api: 'developer-portal', error: error.message, stack: error.stack });
  sendDeveloperPortalError(
    res,
    500,
    'DEVELOPER_PORTAL_ERROR',
    process.env.NODE_ENV === 'development'
      ? error.message
      : 'An unexpected error occurred'
  );
});

export { router as developerPortalApiRoutes };
export default router;
