/**
 * Layer 2 Enterprise Feedback Collection Middleware
 * Middleware functions for feedback collection integration and automation
 */

import { Request, Response, NextFunction } from 'express';
import {
  FeedbackCollectionService,
  CreateFeedbackSessionRequest,
} from '../services/feedback-collection-service.js';
import { Pool } from 'pg';
const { appLogger } = require('../server/utils/logger');

export interface FeedbackMiddlewareConfig {
  pool: Pool;
  enableAutoTriggers?: boolean;
  defaultSurveyMappings?: {
    [sessionType: string]: string;
  };
}

export class FeedbackMiddleware {
  private feedbackService: FeedbackCollectionService;
  private config: FeedbackMiddlewareConfig;

  constructor(config: FeedbackMiddlewareConfig) {
    this.config = config;
    // Create a mock OracleAPIService for the FeedbackCollectionService
    const mockOracleService = new (class {
      async createFeedbackSession(data: any) {
        return { sessionId: 'mock' };
      }
      async getFeedbackSession(id: string) {
        return { sessionId: id };
      }
      async getSurveysByType(type: string) {
        return [];
      }
      async getSurveyWithQuestions(id: string) {
        return { questions: [] };
      }
      async expireOldSessions() {
        return;
      }
    })();
    this.feedbackService = new FeedbackCollectionService(
      mockOracleService as any
    );
  }

  /**
   * Middleware to automatically trigger feedback collection after performance tests
   */
  autoTriggerPerformanceFeedback = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (!this.config.enableAutoTriggers) {
      return next();
    }

    try {
      // Check if this is a performance test completion
      const isTestCompletion =
        req.path.includes('/performance') && req.method === 'POST';
      const testResults = req.body;

      if (
        isTestCompletion &&
        testResults?.completed &&
        testResults?.partner_id
      ) {
        // Create feedback session for performance testing
        const sessionRequest: CreateFeedbackSessionRequest = {
          sessionType: 'performance-testing',
          session_type: 'performance-testing',
          partner_id: testResults.partner_id,
          partner_name: testResults.partner_name || testResults.partner_id,
          metadata: {
            test_scenario_id: testResults.test_scenario_id,
            test_environment: testResults.environment,
            tps_target: testResults.tps_target,
            actual_tps: testResults.actual_tps,
            duration: testResults.duration,
            test_phase: testResults.phase || 'performance-benchmark',
          },
        };

        const session =
          await this.feedbackService.createFeedbackSession(sessionRequest);

        // Add session info to response for client to trigger survey
        (res as any).feedbackSession = session;

        appLogger.info('Auto-triggered feedback session', { sessionId: session.id, partnerId: testResults.partner_id });
      }

      next();
    } catch (error) {
      appLogger.error('Error in autoTriggerPerformanceFeedback', { error: error instanceof Error ? error.message : String(error) });
      // Don't fail the main request if feedback fails
      next();
    }
  };

  /**
   * Middleware to trigger feedback after integration milestones
   */
  autoTriggerIntegrationFeedback = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (!this.config.enableAutoTriggers) {
      return next();
    }

    try {
      const isIntegrationComplete =
        req.path.includes('/integration') &&
        req.method === 'POST' &&
        req.body?.status === 'completed';

      if (isIntegrationComplete && req.body?.partner_id) {
        const sessionRequest: CreateFeedbackSessionRequest = {
          sessionType: 'integration-testing',
          session_type: 'integration-testing',
          partner_id: req.body.partner_id,
          partner_name: req.body.partner_name || req.body.partner_id,
          metadata: {
            integration_type: req.body.integration_type,
            completion_time: new Date(),
            integration_steps: req.body.steps_completed,
            environment: req.body.environment || 'test',
          },
        };

        const session =
          await this.feedbackService.createFeedbackSession(sessionRequest);
        (res as any).feedbackSession = session;

        appLogger.info('Auto-triggered integration feedback session', { sessionId: session.id, partnerId: req.body.partner_id });
      }

      next();
    } catch (error) {
      appLogger.error('Error in autoTriggerIntegrationFeedback', { error: error instanceof Error ? error.message : String(error) });
      next();
    }
  };

  /**
   * Middleware to enrich responses with feedback session info
   */
  enrichWithFeedbackSession = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const originalSend = res.send;

    res.send = function (data: any) {
      if ((res as any).feedbackSession) {
        try {
          const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

          if (parsedData && typeof parsedData === 'object') {
            parsedData.feedback_session = {
              id: (res as any).feedbackSession.id,
              session_type: (res as any).feedbackSession.session_type,
              partner_id: (res as any).feedbackSession.partner_id,
              created_at: (res as any).feedbackSession.created_at,
              survey_url: `/api/feedback/sessions/${(res as any).feedbackSession.id}/survey`,
            };

            data =
              typeof data === 'string'
                ? JSON.stringify(parsedData)
                : parsedData;
          }
        } catch (error) {
          appLogger.error('Error enriching response with feedback session', { error: error instanceof Error ? error.message : String(error) });
        }
      }

      return originalSend.call(this, data);
    };

    next();
  };

  /**
   * Middleware to validate partner access to feedback data
   */
  validatePartnerAccess = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const partnerId =
        req.params.partnerId || req.body.partner_id || req.query.partner_id;
      const requestingPartnerId =
        (req as any).partner?.id || (req as any).user?.partner_id;

      // If no partner context, skip validation (admin access)
      if (!requestingPartnerId) {
        return next();
      }

      // Partners can only access their own data
      if (partnerId && partnerId !== requestingPartnerId) {
        res.status(403).json({
          success: false,
          error: 'Access denied: You can only access your own feedback data',
        });
        return;
      }

      // Add partner context to request
      (req as any).validatedPartnerId = requestingPartnerId;
      next();
    } catch (error) {
      appLogger.error('Error in validatePartnerAccess', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        success: false,
        error: 'Access validation failed',
      });
    }
  };

  /**
   * Middleware to log feedback events for analytics
   */
  logFeedbackEvents = (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.send;

    res.send = function (data: any) {
      try {
        // Log feedback events for analytics
        const event = {
          timestamp: new Date(),
          method: req.method,
          path: req.path,
          partner_id: req.params.partnerId || req.body.partner_id,
          session_id: req.params.sessionId,
          status_code: res.statusCode,
          user_agent: req.get('User-Agent'),
          ip: req.ip,
        };

        // Log to console or send to analytics service
        if (req.path.includes('/feedback/')) {
          appLogger.info('Feedback Event', { event });
        }
      } catch (error) {
        appLogger.error('Error logging feedback event', { error: error instanceof Error ? error.message : String(error) });
      }

      return originalSend.call(this, data);
    };

    next();
  };

  /**
   * Middleware to automatically expire old sessions
   */
  autoExpireSessions = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      // Run session expiration every hour (check timestamp)
      const lastExpiration = (req.app as any).lastSessionExpiration || 0;
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      if (now - lastExpiration > oneHour) {
        // Run in background
        this.feedbackService
          .expireOldSessions()
          .then(() => {
            appLogger.info('Expired old feedback sessions');
          })
          .catch(error => {
            appLogger.error('Error expiring sessions', { error: error instanceof Error ? error.message : String(error) });
          });

        (req.app as any).lastSessionExpiration = now;
      }

      next();
    } catch (error) {
      appLogger.error('Error in autoExpireSessions', { error: error instanceof Error ? error.message : String(error) });
      next();
    }
  };

  /**
   * Middleware to suggest surveys based on context
   */
  suggestSurvey = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.method === 'POST' && req.path.includes('/sessions')) {
        const sessionType = req.body.session_type;
        const surveys = await this.feedbackService.getSurveysByType(
          this.mapSessionTypeToSurveyType(sessionType)
        );

        if (surveys.length > 0) {
          (req.body as any).suggested_survey_id = surveys[0].id;
        }
      }

      next();
    } catch (error) {
      appLogger.error('Error in suggestSurvey', { error: error instanceof Error ? error.message : String(error) });
      next();
    }
  };

  /**
   * Map session types to survey types
   */
  private mapSessionTypeToSurveyType(sessionType: string): string {
    const mapping = {
      'performance-testing': 'performance',
      'integration-testing': 'integration',
      'general-experience': 'general',
      'post-deployment': 'general',
    };

    return mapping[sessionType as keyof typeof mapping] || 'general';
  }

  /**
   * Middleware factory for rate limiting feedback submissions
   */
  createRateLimiter(maxRequests: number = 10, windowMs: number = 60000) {
    const requests = new Map<string, { count: number; resetTime: number }>();

    return (req: Request, res: Response, next: NextFunction): void => {
      const key = req.ip + (req.body.partner_id || '');
      const now = Date.now();
      const windowStart = now - windowMs;

      // Clean old entries
      for (const [k, v] of requests.entries()) {
        if (v.resetTime < windowStart) {
          requests.delete(k);
        }
      }

      const current = requests.get(key) || {
        count: 0,
        resetTime: now + windowMs,
      };

      if (current.count >= maxRequests) {
        res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          retry_after: Math.ceil((current.resetTime - now) / 1000),
        });
        return;
      }

      current.count++;
      requests.set(key, current);
      next();
    };
  }

  /**
   * Middleware to validate survey responses
   */
  validateSurveyResponses = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (req.method === 'POST' && req.path.includes('/submit')) {
        const { responses } = req.body;
        const sessionId = req.params.sessionId;

        if (!responses || !Array.isArray(responses) || responses.length === 0) {
          res.status(400).json({
            success: false,
            error: 'Invalid responses format',
          });
          return;
        }

        // Get session to find survey
        const session =
          await this.feedbackService.getFeedbackSession(sessionId);
        if (!session) {
          res.status(404).json({
            success: false,
            error: 'Session not found',
          });
          return;
        }

        // If session has a survey, validate against survey questions
        if (session.survey_id) {
          const surveyWithQuestions =
            await this.feedbackService.getSurveyWithQuestions(
              session.survey_id
            );

          if (surveyWithQuestions) {
            const validationErrors = this.validateResponsesAgainstSurvey(
              responses,
              surveyWithQuestions.questions
            );

            if (validationErrors.length > 0) {
              res.status(400).json({
                success: false,
                error: 'Validation errors',
                details: validationErrors,
              });
              return;
            }
          }
        }
      }

      next();
    } catch (error) {
      appLogger.error('Error in validateSurveyResponses', { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({
        success: false,
        error: 'Response validation failed',
      });
      return;
    }
  };

  /**
   * Validate individual responses against survey questions
   */
  private validateResponsesAgainstSurvey(
    responses: any[],
    questions: any[]
  ): string[] {
    const errors: string[] = [];
    const questionMap = new Map(questions.map(q => [q.id, q]));

    // Check required questions
    const requiredQuestions = questions.filter(q => q.is_required);
    const responseQuestionIds = new Set(responses.map(r => r.question_id));

    for (const requiredQ of requiredQuestions) {
      if (!responseQuestionIds.has(requiredQ.id)) {
        errors.push(
          `Required question "${requiredQ.question_text}" is missing`
        );
      }
    }

    // Validate individual responses
    for (const response of responses) {
      const question = questionMap.get(response.question_id);
      if (!question) {
        errors.push(`Unknown question ID: ${response.question_id}`);
        continue;
      }

      const validationError = this.validateResponseValue(
        response.response_value,
        question
      );
      if (validationError) {
        errors.push(`Question "${question.question_text}": ${validationError}`);
      }
    }

    return errors;
  }

  /**
   * Validate response value against question type and rules
   */
  private validateResponseValue(value: any, question: any): string | null {
    const { question_type, validation_rules, options } = question;

    switch (question_type) {
      case 'rating':
        if (typeof value !== 'number') {
          return 'Rating must be a number';
        }
        if (validation_rules?.min && value < validation_rules.min) {
          return `Rating must be at least ${validation_rules.min}`;
        }
        if (validation_rules?.max && value > validation_rules.max) {
          return `Rating must be at most ${validation_rules.max}`;
        }
        break;

      case 'numeric':
        if (typeof value !== 'number') {
          return 'Response must be a number';
        }
        if (validation_rules?.min && value < validation_rules.min) {
          return `Value must be at least ${validation_rules.min}`;
        }
        if (validation_rules?.max && value > validation_rules.max) {
          return `Value must be at most ${validation_rules.max}`;
        }
        break;

      case 'text':
        if (typeof value !== 'string') {
          return 'Response must be text';
        }
        if (
          validation_rules?.maxLength &&
          value.length > validation_rules.maxLength
        ) {
          return `Text must be at most ${validation_rules.maxLength} characters`;
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return 'Response must be true or false';
        }
        break;

      case 'multiple-choice':
        if (Array.isArray(options)) {
          const validOptions = Array.isArray(options) ? options : [];
          if (Array.isArray(value)) {
            // Multiple selections
            for (const v of value) {
              if (!validOptions.includes(v)) {
                return `Invalid option: ${v}`;
              }
            }
          } else {
            // Single selection
            if (!validOptions.includes(value)) {
              return `Invalid option: ${value}`;
            }
          }
        }
        break;
    }

    return null;
  }
}

/**
 * Factory function to create feedback middleware with configuration
 */
export function createFeedbackMiddleware(
  config: FeedbackMiddlewareConfig
): FeedbackMiddleware {
  return new FeedbackMiddleware(config);
}

export default FeedbackMiddleware;

// Individual exported functions for convenient usage
export const authenticatePartner = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Basic partner authentication middleware
  const apiKey = req.headers['x-api-key'] as string;
  const partnerId = req.headers['x-partner-id'] as string;

  if (!apiKey || !partnerId) {
    res.status(401).json({
      success: false,
      error: 'Missing API key or partner ID',
    });
    return;
  }

  // Add partner context to request
  (req as any).partner = { id: partnerId, apiKey };
  next();
};

export const extractFeedbackContext = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Extract feedback context from request
  const context = {
    sessionType: req.headers['x-session-type'] as string,
    testScenario: req.headers['x-test-scenario'] as string,
    environment: (req.headers['x-environment'] as string) || 'test',
    partnerId: (req as any).partner?.id,
  };

  (req as any).feedbackContext = context;
  next();
};

export const validateFeedbackData = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Basic validation for feedback data
  if (req.method === 'POST') {
    const { partner_id, session_type } = req.body;

    if (!partner_id) {
      res.status(400).json({
        success: false,
        error: 'partner_id is required',
      });
      return;
    }

    if (!session_type) {
      res.status(400).json({
        success: false,
        error: 'session_type is required',
      });
      return;
    }
  }

  next();
};

// Persistent rate limiting storage (in production, use Redis)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export const feedbackRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Simple rate limiting implementation
  const maxRequests = 50;
  const windowMs = 60000; // 1 minute

  const key = req.ip + ((req as any).partner?.id || '');
  const now = Date.now();
  const windowStart = now - windowMs;

  // Clean old entries
  for (const [k, v] of rateLimitStore.entries()) {
    if (v.resetTime < windowStart) {
      rateLimitStore.delete(k);
    }
  }

  const current = rateLimitStore.get(key) || {
    count: 0,
    resetTime: now + windowMs,
  };

  if (current.count >= maxRequests) {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      retry_after: Math.ceil((current.resetTime - now) / 1000),
    });
    return;
  }

  current.count++;
  rateLimitStore.set(key, current);
  next();
};

export const trackFeedbackMetrics = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Track metrics for feedback operations
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const metric = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      partner_id: (req as any).partner?.id,
      timestamp: new Date().toISOString(),
    };

    // Log metrics (in production, send to metrics service)
    appLogger.info('Feedback Metrics', { metric });
  });

  next();
};

export const setupFeedbackWebSocket = (server: any) => {
  // WebSocket setup for real-time feedback
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ server, path: '/feedback-ws' });

  wss.on('connection', (ws: any, req: any) => {
    appLogger.info('Feedback WebSocket connected');

    ws.on('message', (data: any) => {
      try {
        const message = JSON.parse(data);
        // Handle feedback WebSocket messages
        appLogger.info('Feedback WS message', { message });
      } catch (error) {
        appLogger.error('Invalid WebSocket message', { error: error instanceof Error ? error.message : String(error) });
      }
    });

    ws.on('close', () => {
      appLogger.info('Feedback WebSocket disconnected');
    });
  });

  return wss;
};

export const feedbackIntegrationHooks = {
  beforeCreate: (data: any) => {
    // Hook before creating feedback session
    appLogger.info('Before feedback session create', { data });
    return data;
  },

  afterCreate: (session: any) => {
    // Hook after creating feedback session
    appLogger.info('After feedback session create', { session });
    return session;
  },

  beforeSubmit: (data: any) => {
    // Hook before submitting feedback
    appLogger.info('Before feedback submit', { data });
    return data;
  },

  afterSubmit: (response: any) => {
    // Hook after submitting feedback
    appLogger.info('After feedback submit', { response });
    return response;
  },

  triggerPostTestFeedback: async (testData: any) => {
    // Trigger feedback collection after performance tests
    appLogger.info('Triggering post-test feedback', { testData });
    // This would create a feedback session and potentially send notifications
    return { triggered: true, testData };
  },

  triggerIntegrationFeedback: async (integrationData: any) => {
    // Trigger feedback collection after integration milestones
    appLogger.info('Triggering integration feedback', { integrationData });
    // This would create a feedback session for integration completion
    return { triggered: true, integrationData };
  },

  triggerErrorFeedback: async (errorData: any) => {
    // Trigger feedback collection after errors or issues
    appLogger.info('Triggering error feedback', { errorData });
    // This would create a feedback session for error investigation
    return { triggered: true, errorData };
  },
};

export const feedbackSecurity = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Security middleware for feedback operations

  // Check for suspicious patterns
  const suspiciousPatterns = [
    /<script/i,
    /javascript:/i,
    /vbscript:/i,
    /onload=/i,
    /onerror=/i,
  ];

  const checkData = (obj: any): boolean => {
    if (typeof obj === 'string') {
      return suspiciousPatterns.some(pattern => pattern.test(obj));
    }
    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj).some(value => checkData(value));
    }
    return false;
  };

  if (checkData(req.body) || checkData(req.query)) {
    res.status(400).json({
      success: false,
      error: 'Potentially malicious content detected',
    });
    return;
  }

  next();
};

export const feedbackErrorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Error handler for feedback operations
  appLogger.error('Feedback Error', { error: error?.message || error });

  // Don't expose internal errors in production
  const isDevelopment = process.env.NODE_ENV !== 'production';

  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Internal server error',
    ...(isDevelopment && { stack: error.stack }),
  });
};
