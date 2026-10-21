import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../../server/auth/jwt-constants.js';
const { logger } = require('../utils/logger');

interface TokenPayload {
  id: string;
  address: string;
  role: string;
  iat: number;
  exp: number;
}

interface User {
  id: string;
  address: string;
  role: string;
}

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable is required for WebSocket authentication'
  );
}

export async function authenticateWebSocketToken(
  token: string
): Promise<User | null> {
  try {
    // SECURITY FIX: Verify JWT with explicit algorithm to prevent 'none' algorithm attack
    const decoded = jwt.verify(token, JWT_SECRET!, {
      algorithms: ['HS256', 'HS384', 'HS512'], // Only allow HMAC algorithms
      issuer: JWT_ISSUER, // Verify issuer
      audience: JWT_AUDIENCE, // Verify audience
      clockTolerance: 30, // 30 second clock tolerance
    }) as jwt.JwtPayload & TokenPayload;

    // Validate token structure
    if (!decoded.id || !decoded.address || !decoded.role) {
      logger.warn('[WSS Auth] Invalid token structure', {
        hasId: !!decoded.id,
        hasAddress: !!decoded.address,
        hasRole: !!decoded.role,
      });
      return null;
    }

    // Check if token is not expired (additional check)
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      logger.warn('[WSS Auth] Token expired', {
        exp: decoded.exp,
        now,
      });
      return null;
    }

    // Additional security checks
    if (!isValidRole(decoded.role)) {
      logger.warn('[WSS Auth] Invalid role in token', {
        role: decoded.role,
        userId: decoded.id,
      });
      return null;
    }

    if (!isValidWalletAddress(decoded.address)) {
      logger.warn('[WSS Auth] Invalid wallet address in token', {
        address: decoded.address,
        userId: decoded.id,
      });
      return null;
    }

    // Optional: Check if user is still active in database
    // const isUserActive = await checkUserStatus(decoded.id);
    // if (!isUserActive) {
    //   logger.warn('[WSS Auth] User account inactive', { userId: decoded.id });
    //   return null;
    // }

    logger.debug('[WSS Auth] Token authenticated successfully', {
      userId: decoded.id,
      role: decoded.role,
    });

    return {
      id: decoded.id,
      address: decoded.address,
      role: decoded.role,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('[WSS Auth] Token expired', {
        expiredAt: error.expiredAt,
      });
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('[WSS Auth] Invalid token', {
        error: error.message,
      });
    } else {
      logger.error('[WSS Auth] Token verification error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function isValidRole(role: string): boolean {
  const validRoles = ['user', 'admin', 'validator', 'bridge_operator'];
  return validRoles.includes(role);
}

function isValidWalletAddress(address: string): boolean {
  // Validate wallet address format (example for Ethereum-style addresses)
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  return addressRegex.test(address);
}

// Optional: Database check for user status
// async function checkUserStatus(userId: string): Promise<boolean> {
//   try {
//     // Query database to check if user is active
//     // const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
//     // return user.length > 0 && user[0].status === 'active';
//     return true; // Placeholder
//   } catch (error) {
//     logger.error('[WSS Auth] Error checking user status', {
//       userId,
//       error: error instanceof Error ? error.message : String(error),
//     });
//     return false;
//   }
// }

export function generateWebSocketToken(
  user: User,
  expiresIn: string = '24h'
): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    id: user.id,
    address: user.address,
    role: user.role,
  };

  // SECURITY FIX: Explicitly specify algorithm and add issuer/audience claims
  return jwt.sign(payload as any, JWT_SECRET!, {
    algorithm: 'HS256', // Explicitly use HS256
    expiresIn: expiresIn as any,
    issuer: JWT_ISSUER, // Add issuer claim
    audience: JWT_AUDIENCE, // Add audience claim
  });
}
