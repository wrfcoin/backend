/// <reference types="express" />

// Extend Express types to resolve conflicts between different @types/express versions
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
      file?: unknown;
      files?: unknown;
      session?: unknown;
      startTime?: Date;
    }
  }
}

export {};
