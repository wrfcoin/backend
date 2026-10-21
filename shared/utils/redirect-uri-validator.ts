import { resolveAllowedOrigins } from '../../server/utils/strict-cors-config.js';

const DEFAULT_ALLOWED_REDIRECT_ORIGINS = [
  'https://wrfcoin.replit.app',
  'https://wrfcoin.app',
  'https://www.wrfcoin.app',
  'https://api.wrfcoin.app',
  'https://dashboard.wrfcoin.app',
  'http://localhost:3000',
  'http://localhost:4001',
  'http://localhost:5000',
  'http://localhost:8080',
  'http://0.0.0.0:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
];

const ALLOWED_REDIRECT_ORIGINS = resolveAllowedOrigins({
  developmentDefaults: DEFAULT_ALLOWED_REDIRECT_ORIGINS,
});

const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/[\w-]+\.wrfcoin\.app$/,
  /^https:\/\/[\w-]+\.replit\.app$/,
  /^https:\/\/[\w-]+\.repl\.co$/,
  /^https:\/\/[\w-]+\.replit\.dev$/,
];

const LOCALHOST_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+$/;

export const SAFE_DEFAULT_REDIRECT = '/dashboard';

export function isSafeRedirectUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') {
    return false;
  }

  if (uri.startsWith('/') && !uri.startsWith('//')) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const origin = parsed.origin;
  if (ALLOWED_REDIRECT_ORIGINS.includes(origin)) {
    return true;
  }

  if (ALLOWED_REDIRECT_PATTERNS.some(pattern => pattern.test(origin))) {
    return true;
  }

  return process.env.NODE_ENV === 'development' && LOCALHOST_PATTERN.test(origin);
}

export function sanitizeRedirectUri(uri: string | undefined): string {
  return uri && isSafeRedirectUri(uri) ? uri : SAFE_DEFAULT_REDIRECT;
}
