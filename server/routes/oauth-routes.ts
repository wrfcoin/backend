/**
 * OAuth Routes with State Validation
 * Task 102.13 - OAuth State Validation for Security Remediation
 *
 * SECURITY: This module implements OAuth authentication flows with
 * comprehensive CSRF protection via state parameter validation.
 *
 * Features:
 * - State parameter generation with HMAC signing
 * - State validation with session binding
 * - Support for multiple OAuth providers
 * - Comprehensive security logging
 * - Short-lived state tokens (5 minutes)
 * - Single-use state enforcement
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  OAuthStateValidator,
  OAuthStateValidationResult,
  logOAuthStateFailure,
} from '../../shared/utils/oauth-state-validator.js';
import {
  exchangeCodeForTokens,
  getUserInfo,
  isProviderConfigured,
  getConfiguredProviders,
} from '../services/oauth-service.js';
import { securityLogger, logError } from '../utils/logger.js';
import {
  isSafeRedirectUri,
  SAFE_DEFAULT_REDIRECT,
} from '../../shared/utils/redirect-uri-validator.js';

const router: Router = Router();

// OAuth initiation, callback, and status routes are public — the user
// is authenticating via an external provider and has no JWT yet.
// Keep authenticateJWT import available for future account-management endpoints.

// Initialize OAuth state validator
const stateValidator = new OAuthStateValidator();

/**
 * Supported OAuth providers configuration
 * In production, these would be loaded from environment variables
 */
interface OAuthProviderConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPath: string;
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
    redirectPath: '/api/oauth/callback/google',
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'user:email'],
    redirectPath: '/api/oauth/callback/github',
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'profile'],
    redirectPath: '/api/oauth/callback/microsoft',
  },
};

// =====================================================
// RATE LIMITING CONFIGURATION
// Security: Prevent abuse of OAuth endpoints
// =====================================================

/**
 * Rate limiter for OAuth initiation
 * - 10 requests per 15 minutes per IP
 * - Prevents enumeration and abuse
 */
const oauthInitRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: {
    error: 'Too many OAuth requests',
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many OAuth authentication attempts. Please try again later.',
    retryAfter: 15 * 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
  },
});

/**
 * Rate limiter for OAuth callbacks
 * - 20 requests per 15 minutes per IP
 * - Slightly higher as callbacks may be retried
 */
const oauthCallbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: {
    error: 'Too many OAuth callback requests',
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many OAuth callback attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Get current session ID from request
 * SECURITY: Session ID must come from HttpOnly cookie only
 *
 * @param req - Express request object
 * @returns Session ID or null if not found
 */
function getSessionId(req: Request): string | null {
  // SECURITY: Only accept session ID from cookies.
  // Fall back to parsing the raw Cookie header because the main server
  // does not install cookie-parser on this path.
  if (req.cookies?.sessionId) {
    return req.cookies.sessionId;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name === 'sessionId') {
      return valueParts.join('=') || null;
    }
  }

  return null;
}

/**
 * Standard API response helpers
 */
const successResponse = <T>(data: T) => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

const errorResponse = (message: string, code?: string) => ({
  success: false,
  error: {
    code: code || 'OAUTH_ERROR',
    message,
  },
  timestamp: new Date().toISOString(),
});

// =====================================================
// OAUTH INITIATION ENDPOINTS
// =====================================================

/**
 * GET /api/oauth/authorize/:provider
 *
 * Initiate OAuth flow for a specific provider.
 * Generates a secure state token and redirects to provider.
 *
 * SECURITY FEATURES:
 * 1. Validates provider is supported
 * 2. Requires valid session (state is bound to session)
 * 3. Generates cryptographically secure state with HMAC
 * 4. State expires in 5 minutes
 * 5. Rate limited
 *
 * @param provider - OAuth provider (google, github, microsoft)
 * @query redirectUri - Optional redirect URI after OAuth completion
 */
(router as any).get('/authorize/:provider', oauthInitRateLimiter, (req: Request, res: Response) => {
  const { provider } = req.params;
  const { redirectUri } = req.query;

  try {
    // Validate provider
    const providerConfig = OAUTH_PROVIDERS[provider];
    if (!providerConfig) {
      return res.status(400).json(
        errorResponse(`Unsupported OAuth provider: ${provider}`, 'INVALID_PROVIDER')
      );
    }

    // Check if provider is configured (both client ID and secret must be present)
    if (!isProviderConfigured(provider)) {
      securityLogger.error('OAuth provider not configured', { provider, service: 'oauth' });
      return res.status(503).json(
        errorResponse('OAuth provider not configured', 'PROVIDER_NOT_CONFIGURED')
      );
    }

    // SECURITY: Require a valid session for state binding
    const sessionId = getSessionId(req);
    if (!sessionId) {
      return res.status(401).json(
        errorResponse(
          'Session required for OAuth authentication. Please ensure cookies are enabled.',
          'SESSION_REQUIRED'
        )
      );
    }

    // Generate secure state token with session binding
    const state = stateValidator.generateState(
      sessionId,
      provider,
      typeof redirectUri === 'string' ? redirectUri : undefined
    );

    // Build authorization URL
    const authUrl = new URL(providerConfig.authorizationUrl);
    authUrl.searchParams.set('client_id', providerConfig.clientId);
    authUrl.searchParams.set('redirect_uri', getRedirectUri(req, provider));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', providerConfig.scopes.join(' '));
    authUrl.searchParams.set('state', state);

    // Provider-specific parameters
    if (provider === 'google') {
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
    }

    // Log OAuth initiation for security monitoring
    securityLogger.info('OAuth flow initiated', {
      provider,
      sessionId: sessionId.substring(0, 8) + '...',
      ip: req.ip,
      service: 'oauth',
    });

    // Redirect to provider's authorization page
    res.redirect(authUrl.toString());
  } catch (error) {
    logError(securityLogger, 'OAuth initiation error', error as Error, { service: 'oauth' });
    res.status(500).json(
      errorResponse('Failed to initiate OAuth flow', 'OAUTH_INIT_ERROR')
    );
  }
});

/**
 * Build the full redirect URI for OAuth callback
 *
 * @param req - Express request object
 * @param provider - OAuth provider name
 * @returns Full redirect URI
 */
function getRedirectUri(req: Request, provider: string): string {
  const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL ||
    `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}${OAUTH_PROVIDERS[provider].redirectPath}`;
}

// =====================================================
// OAUTH CALLBACK ENDPOINTS
// =====================================================

/**
 * GET /api/oauth/callback/:provider
 *
 * Handle OAuth callback from provider.
 * Validates state parameter and exchanges code for tokens.
 *
 * SECURITY FEATURES:
 * 1. Validates state parameter with HMAC verification
 * 2. Verifies state is bound to current session
 * 3. Enforces state expiry (5 minutes)
 * 4. Prevents state reuse (single-use)
 * 5. Rate limited
 * 6. Comprehensive error logging
 *
 * @param provider - OAuth provider (google, github, microsoft)
 * @query code - Authorization code from provider
 * @query state - State parameter for CSRF protection
 * @query error - Optional error from provider
 * @query error_description - Optional error description
 */
(router as any).get('/callback/:provider', oauthCallbackRateLimiter, async (req: Request, res: Response) => {
  const { provider } = req.params;
  const { code, state, error: oauthError, error_description } = req.query;

  try {
    // Validate provider
    const providerConfig = OAUTH_PROVIDERS[provider];
    if (!providerConfig) {
      return res.status(400).json(
        errorResponse(`Unsupported OAuth provider: ${provider}`, 'INVALID_PROVIDER')
      );
    }

    // Handle OAuth provider errors
    if (oauthError) {
      securityLogger.warn('OAuth provider returned error', {
        provider,
        error: oauthError,
        description: error_description,
        service: 'oauth',
      });

      return res.status(400).json(
        errorResponse(
          `OAuth authentication failed: ${error_description || oauthError}`,
          'OAUTH_PROVIDER_ERROR'
        )
      );
    }

    // Validate authorization code presence
    if (!code || typeof code !== 'string') {
      return res.status(400).json(
        errorResponse('Missing authorization code', 'MISSING_CODE')
      );
    }

    // SECURITY: Get current session ID for state validation
    const sessionId = getSessionId(req);
    if (!sessionId) {
      securityLogger.warn('OAuth callback without session', {
        provider,
        ip: req.ip,
        service: 'oauth',
      });
      return res.status(401).json(
        errorResponse(
          'Session not found. OAuth state validation requires a valid session.',
          'SESSION_REQUIRED'
        )
      );
    }

    // SECURITY: Validate state parameter
    const stateValidation: OAuthStateValidationResult = stateValidator.validateState(
      typeof state === 'string' ? state : undefined,
      sessionId
    );

    if (!stateValidation.isValid) {
      // Log the security event
      logOAuthStateFailure(stateValidation, {
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        provider,
      });

      // Return appropriate error based on failure type
      const statusCode = stateValidation.errorCode === 'EXPIRED' ? 410 : 400;
      return res.status(statusCode).json(
        errorResponse(
          stateValidation.error || 'Invalid state parameter',
          stateValidation.errorCode || 'STATE_VALIDATION_FAILED'
        )
      );
    }

    // State is valid - proceed with token exchange
    const parsedState = stateValidation.state!;

    // Verify provider matches
    if (parsedState.provider !== provider) {
      securityLogger.warn('OAuth provider mismatch', {
        expectedProvider: parsedState.provider,
        actualProvider: provider,
        ip: req.ip,
        service: 'oauth',
      });
      return res.status(400).json(
        errorResponse('Provider mismatch in OAuth state', 'PROVIDER_MISMATCH')
      );
    }

    // Exchange authorization code for tokens with actual provider API
    const tokenResult = await exchangeCodeForTokens(
      provider,
      code,
      getRedirectUri(req, provider)
    );

    if (!tokenResult.success) {
      securityLogger.warn('OAuth token exchange failed', {
        provider,
        error: tokenResult.error,
        description: tokenResult.errorDescription,
        service: 'oauth',
      });
      return res.status(400).json(
        errorResponse(
          tokenResult.errorDescription || 'Failed to exchange authorization code',
          tokenResult.error || 'TOKEN_EXCHANGE_FAILED'
        )
      );
    }

    // Get user info from the provider using the access token
    const userInfo = await getUserInfo(provider, tokenResult.accessToken!);

    if (!userInfo) {
      return res.status(400).json(
        errorResponse('Failed to retrieve user information', 'USER_INFO_FAILED')
      );
    }

    // Log successful OAuth authentication
    securityLogger.info('OAuth authentication successful', {
      provider,
      sessionId: sessionId.substring(0, 8) + '...',
      userId: userInfo?.id?.substring(0, 8) + '...',
      service: 'oauth',
    });

    // Handle redirect or return user info
    if (parsedState.redirectUri) {
      if (!isSafeRedirectUri(parsedState.redirectUri)) {
        securityLogger.warn('OAuth callback blocked unsafe redirect URI from state', {
          provider,
          redirectUri: parsedState.redirectUri,
          ip: req.ip,
          service: 'oauth',
          threat: 'open_redirect_blocked',
        });
        return res.redirect(SAFE_DEFAULT_REDIRECT);
      }

      const redirectUrl = new URL(
        parsedState.redirectUri,
        `${req.protocol}://${req.get('host')}`
      );
      redirectUrl.searchParams.set('oauth_success', 'true');
      redirectUrl.searchParams.set('provider', provider);
      return res.redirect(redirectUrl.toString());
    }

    // Return success response with user info
    res.json(successResponse({
      provider,
      user: {
        id: userInfo?.id,
        email: userInfo?.email,
        name: userInfo?.name,
        avatar: userInfo?.avatar,
      },
      message: 'OAuth authentication successful',
    }));

  } catch (error) {
    logError(securityLogger, 'OAuth callback error', error as Error, { service: `oauth-${provider}` });

    res.status(500).json(
      errorResponse('OAuth callback processing failed', 'OAUTH_CALLBACK_ERROR')
    );
  }
});

// =====================================================
// UTILITY ENDPOINTS
// =====================================================

/**
 * GET /api/oauth/providers
 *
 * Get list of configured OAuth providers
 */
router.get('/providers', (req: Request, res: Response) => {
  const configuredProviderNames = getConfiguredProviders();
  const providers = Object.entries(OAUTH_PROVIDERS)
    .filter(([name]) => configuredProviderNames.includes(name))
    .map(([name, config]) => ({
      name,
      authorizationUrl: config.authorizationUrl,
      scopes: config.scopes,
    }));

  res.json(successResponse({ providers }));
});

/**
 * GET /api/oauth/status
 *
 * Get OAuth configuration status (for debugging/admin)
 */
router.get('/status', (req: Request, res: Response) => {
  const status = Object.entries(OAUTH_PROVIDERS).map(([name, config]) => ({
    provider: name,
    configured: isProviderConfigured(name),
    scopes: config.scopes,
  }));

  res.json(successResponse({
    status,
    stateExpiryMs: stateValidator.getExpiryMs(),
    configuredProviders: getConfiguredProviders(),
    timestamp: new Date().toISOString(),
  }));
});

export default router;
