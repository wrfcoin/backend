import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id?: string;
        userId?: string;
        address?: string;
        walletAddress?: string;
        email?: string;
        role?: string;
        roles?: string[];
        permissions?: string[];
        sessionId?: string;
        verified?: boolean;
      };
    }
  }
}
