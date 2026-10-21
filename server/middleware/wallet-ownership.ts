/**
 * Ownership rules for wallet-login callers (backend#1297).
 *
 * authenticateJWT now admits a wallet access token (role 'wallet', no session). Routes keyed by a
 * numeric users.id must not let such a caller read or write another user's data, so a wallet
 * caller is mapped to its own users row through users.wallet_address and compared. Session and
 * admin callers are untouched.
 */
import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';

type CallerUser = { role?: string; sessionId?: string; userId?: unknown; id?: unknown; address?: string } | undefined;

export function isWalletCaller(user: CallerUser): boolean {
  return !!user && user.role === 'wallet' && user.sessionId === undefined;
}

/** users.id owned by this wallet address, or null. */
export async function userIdForWallet(address: string): Promise<number | null> {
  // Loaded on first use so importing a router does not open the database module.
  const { db } = await import('../../database/index.js');
  const { users } = await import('../../shared/schema.js');
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.walletAddress}) = ${address.toLowerCase()}`)
    .limit(1);
  const id = Number(row?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The caller's users.id: a session caller's numeric id, or a wallet caller's own row.
 * Null when neither can be established.
 */
export async function resolveCallerUserId(req: Request): Promise<number | null> {
  const user = (req as Request & { user?: CallerUser }).user;
  if (isWalletCaller(user)) {
    const address = typeof user?.address === 'string' ? user.address : '';
    return address ? userIdForWallet(address) : null;
  }
  const candidate = user?.userId ?? user?.id;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
    const n = Number(candidate);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * router.param('userId', walletMayOnlyUseOwnUserId): a wallet caller may only address its own
 * user; anything else is 403. Non-wallet callers pass through unchanged.
 */
export async function walletMayOnlyUseOwnUserId(
  req: Request,
  res: Response,
  next: NextFunction,
  value: string,
): Promise<void> {
  const user = (req as Request & { user?: CallerUser }).user;
  if (!isWalletCaller(user)) {
    next();
    return;
  }
  try {
    const own = await resolveCallerUserId(req);
    // Canonical decimal only (no leading zero, sign, dot or space): a different spelling of the
    // same number is refused (#1388).
    if (own !== null && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) === own) {
      next();
      return;
    }
  } catch {
    // Any lookup failure refuses the wallet caller rather than admitting it.
  }
  res.status(403).json({ success: false, error: 'Forbidden: a wallet token may only access its own user' });
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

/** router.param('walletAddress', ...): a wallet caller may only address itself (case-insensitive). */
export function walletMayOnlyUseOwnAddress(req: Request, res: Response, next: NextFunction, value: string): void {
  const user = (req as Request & { user?: CallerUser }).user;
  if (!isWalletCaller(user) || sameAddress(value, user?.address)) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Forbidden: a wallet token may only access its own address' });
}

/** Route middleware: for a wallet caller, req.body[field] must be the caller's own address. */
export function walletMayOnlyActForOwnAddressInBody(field: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: CallerUser }).user;
    if (!isWalletCaller(user) || sameAddress((req.body ?? {})[field], user?.address)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Forbidden: a wallet token may only act for its own address' });
  };
}

/** Route middleware: for a wallet caller, req.query[field] must be the caller's own address. */
export function walletMayOnlyQueryOwnAddress(field: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: CallerUser }).user;
    const raw = (req.query ?? {})[field];
    if (!isWalletCaller(user) || sameAddress(Array.isArray(raw) ? raw[0] : raw, user?.address)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Forbidden: a wallet token may only query its own address' });
  };
}

/**
 * Route middleware: only an operator may proceed. "Operator" is a caller whose verified roles
 * include 'admin' or 'operator'; a wallet-login caller (roles ['wallet']) and an ordinary
 * session user are refused (403).
 */
export function requireOperatorCaller(req: Request, res: Response, next: NextFunction): void {
  const roles = (req as Request & { user?: { roles?: unknown } }).user?.roles;
  if (Array.isArray(roles) && (roles.includes('admin') || roles.includes('operator'))) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: 'Forbidden: operator role required' });
}
