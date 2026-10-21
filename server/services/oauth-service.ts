/**
 * OAuth Service - Token Exchange and User Info
 *
 * Task 80: Gap 5 - Implements actual OAuth token exchange with providers
 *
 * Supports:
 * - Google OAuth 2.0
 * - GitHub OAuth
 * - Microsoft Azure AD
 */

import { logger } from '../../utils/logger.js';

// OAuth Provider Configurations
interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

// Token Exchange Result
export interface TokenExchangeResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  idToken?: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

// User Info Result
export interface OAuthUserInfo {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  provider: string;
  rawData?: Record<string, any>;
}

// Provider configurations
const PROVIDER_CONFIGS: Record<string, OAuthProviderConfig> = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile'],
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'email', 'profile'],
  },
};

/**
 * Exchange authorization code for access tokens
 *
 * @param provider - OAuth provider name (google, github, microsoft)
 * @param code - Authorization code from OAuth callback
 * @param redirectUri - Redirect URI used in authorization request
 */
export async function exchangeCodeForTokens(
  provider: string,
  code: string,
  redirectUri: string
): Promise<TokenExchangeResult> {
  const config = PROVIDER_CONFIGS[provider];

  if (!config) {
    return {
      success: false,
      error: 'UNSUPPORTED_PROVIDER',
      errorDescription: `OAuth provider ${provider} is not supported`,
    };
  }

  if (!config.clientId || !config.clientSecret) {
    logger.error(`[OAuth] Provider ${provider} not configured: missing credentials`);
    return {
      success: false,
      error: 'PROVIDER_NOT_CONFIGURED',
      errorDescription: `OAuth provider ${provider} is not properly configured`,
    };
  }

  try {
    // Build token request based on provider
    const tokenRequestBody = buildTokenRequestBody(provider, config, code, redirectUri);
    const headers = buildTokenRequestHeaders(provider);

    logger.info(`[OAuth] Exchanging code for tokens with ${provider}`, {
      provider,
      redirectUri,
      codeLength: code.length,
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers,
      body: tokenRequestBody,
    });

    // GitHub returns non-JSON by default, need to parse differently
    let tokenData: Record<string, any>;
    if (provider === 'github') {
      const responseText = await response.text();
      tokenData = parseGitHubResponse(responseText);
    } else {
      tokenData = await response.json() as Record<string, any>;
    }

    // Check for error response
    if (tokenData.error) {
      logger.warn(`[OAuth] Token exchange failed for ${provider}`, {
        error: tokenData.error,
        description: tokenData.error_description,
      });
      return {
        success: false,
        error: tokenData.error,
        errorDescription: tokenData.error_description,
      };
    }

    logger.info(`[OAuth] Token exchange successful for ${provider}`);

    return {
      success: true,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      tokenType: tokenData.token_type,
      idToken: tokenData.id_token,
      scope: tokenData.scope,
    };
  } catch (error) {
    logger.error(`[OAuth] Token exchange error for ${provider}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: 'TOKEN_EXCHANGE_FAILED',
      errorDescription: error instanceof Error ? error.message : 'Unknown error during token exchange',
    };
  }
}

/**
 * Get user information from OAuth provider
 *
 * @param provider - OAuth provider name
 * @param accessToken - Access token from token exchange
 */
export async function getUserInfo(
  provider: string,
  accessToken: string
): Promise<OAuthUserInfo | null> {
  const config = PROVIDER_CONFIGS[provider];

  if (!config) {
    logger.error(`[OAuth] Cannot get user info: unsupported provider ${provider}`);
    return null;
  }

  try {
    logger.info(`[OAuth] Fetching user info from ${provider}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    };

    // GitHub requires User-Agent header
    if (provider === 'github') {
      headers['User-Agent'] = 'WRFCoin-Platform';
    }

    const response = await fetch(config.userInfoUrl, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      logger.warn(`[OAuth] User info request failed for ${provider}`, {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const userData = await response.json() as Record<string, any>;

    // Normalize user data based on provider
    const normalizedUser = normalizeUserData(provider, userData);

    // For GitHub, we may need to fetch email separately if not in profile
    if (provider === 'github' && !normalizedUser.email) {
      normalizedUser.email = await fetchGitHubEmail(accessToken);
    }

    logger.info(`[OAuth] User info fetched successfully from ${provider}`, {
      userId: normalizedUser.id.substring(0, 8) + '...',
    });

    return normalizedUser;
  } catch (error) {
    logger.error(`[OAuth] Error fetching user info from ${provider}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Build token request body based on provider
 */
function buildTokenRequestBody(
  provider: string,
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  return params.toString();
}

/**
 * Build request headers based on provider
 */
function buildTokenRequestHeaders(provider: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // GitHub requires Accept header for JSON response
  if (provider === 'github') {
    headers['Accept'] = 'application/json';
  }

  return headers;
}

/**
 * Parse GitHub's response (can be form-encoded or JSON)
 */
function parseGitHubResponse(responseText: string): Record<string, any> {
  try {
    // Try JSON first
    return JSON.parse(responseText);
  } catch {
    // Parse as form-encoded
    const params = new URLSearchParams(responseText);
    const result: Record<string, any> = {};
    params.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
}

/**
 * Normalize user data from different providers to common format
 */
function normalizeUserData(provider: string, userData: Record<string, any>): OAuthUserInfo {
  switch (provider) {
    case 'google':
      return {
        id: userData.id,
        email: userData.email,
        name: userData.name,
        avatar: userData.picture,
        provider: 'google',
        rawData: userData,
      };

    case 'github':
      return {
        id: String(userData.id),
        email: userData.email || '',
        name: userData.name || userData.login,
        avatar: userData.avatar_url,
        provider: 'github',
        rawData: userData,
      };

    case 'microsoft':
      return {
        id: userData.id,
        email: userData.mail || userData.userPrincipalName,
        name: userData.displayName,
        avatar: undefined, // Microsoft Graph requires separate call for photo
        provider: 'microsoft',
        rawData: userData,
      };

    default:
      return {
        id: userData.id || userData.sub,
        email: userData.email,
        name: userData.name,
        avatar: userData.picture || userData.avatar_url,
        provider,
        rawData: userData,
      };
  }
}

/**
 * Fetch GitHub user's primary email (private emails require separate API call)
 */
async function fetchGitHubEmail(accessToken: string): Promise<string> {
  try {
    const response = await fetch('https://api.github.com/user/emails', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'WRFCoin-Platform',
      },
    });

    if (!response.ok) {
      return '';
    }

    interface GitHubEmail {
      email: string;
      primary: boolean;
      verified: boolean;
    }

    const emails = await response.json() as GitHubEmail[];

    // Find primary email
    const primaryEmail = emails.find((e) => e.primary && e.verified);
    if (primaryEmail) {
      return primaryEmail.email;
    }

    // Fallback to first verified email
    const verifiedEmail = emails.find((e) => e.verified);
    return verifiedEmail ? verifiedEmail.email : '';
  } catch (error) {
    logger.warn('[OAuth] Failed to fetch GitHub email', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * Validate provider configuration
 */
export function isProviderConfigured(provider: string): boolean {
  const config = PROVIDER_CONFIGS[provider];
  return !!(config && config.clientId && config.clientSecret);
}

/**
 * Get list of configured providers
 */
export function getConfiguredProviders(): string[] {
  return Object.keys(PROVIDER_CONFIGS).filter(isProviderConfigured);
}

export default {
  exchangeCodeForTokens,
  getUserInfo,
  isProviderConfigured,
  getConfiguredProviders,
};
