import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const WALLET_DERIVE_PREFIX = 'wrfcoin-eoa:';
const SMART_ACCOUNT_DERIVE_PREFIX = 'wrfcoin-aa:';

export type SocialProvider = 'google' | 'github' | 'apple';

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type SocialIdentity = {
  provider: SocialProvider;
  sub: string;
  email?: string;
};

export type SocialAuthResult = {
  token: string;
  provider: SocialProvider;
  sub: string;
  email?: string;
  walletAddress: string;
  smartAccountAddress: string;
  isNewUser: boolean;
};

function defaultDb(): DbExecutor {
  const { executeQuery } = require('../../database/db');
  return { execute: (sql: string, params?: unknown[]) => executeQuery(sql, params) };
}

export function deriveWallet(sub: string): string {
  return '0x' + ethers.keccak256(ethers.toUtf8Bytes(WALLET_DERIVE_PREFIX + sub)).slice(-40);
}

export function deriveSmartAccount(sub: string): string {
  return '0x' + ethers.keccak256(ethers.toUtf8Bytes(SMART_ACCOUNT_DERIVE_PREFIX + sub)).slice(-40);
}

function signSession(identity: SocialIdentity, walletAddress: string, smartAccountAddress: string) {
  const secret = process.env.JWT_SECRET;
  const testMode = (process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true';
  if (!secret && !testMode) {
    throw new Error('JWT_SECRET is required');
  }
  return jwt.sign(
    {
      sub: identity.sub,
      provider: identity.provider,
      email: identity.email,
      walletAddress,
      smartAccountAddress,
    },
    secret || 'test-jwt-secret',
    { expiresIn: '7d', issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
  );
}

export async function verifyGoogleIdToken(idToken: string): Promise<{ sub: string; email?: string }> {
  if (!idToken) {
    throw new Error('idToken required');
  }

  if ((process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true') {
    throw new Error('Use mockSub in route test mode');
  }

  const audience = process.env.GOOGLE_CLIENT_ID;
  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  };
  if (audience) {
    verifyOptions.audience = audience;
  }

  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, verifyOptions);
  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email) : undefined,
  };
}

async function exchangeGithubCodeForToken(code: string): Promise<string> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('GitHub token exchange did not return access_token');
  }
  return payload.access_token;
}

export async function verifyGithubIdentity(input: {
  code?: string;
  accessToken?: string;
}): Promise<{ sub: string; email?: string }> {
  if ((process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true') {
    throw new Error('Use mockSub in route test mode');
  }

  let accessToken = input.accessToken;
  if (!accessToken) {
    if (!input.code) {
      throw new Error('code or accessToken required');
    }
    accessToken = await exchangeGithubCodeForToken(input.code);
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'wrfcoin-backend',
  };

  const userResp = await fetch('https://api.github.com/user', { headers });
  if (!userResp.ok) {
    throw new Error(`GitHub user lookup failed with status ${userResp.status}`);
  }
  const user = (await userResp.json()) as { id?: number; email?: string | null };
  const sub = String(user.id || '');
  if (!sub) {
    throw new Error('GitHub user response missing id');
  }

  if (user.email) {
    return { sub, email: user.email };
  }

  const emailResp = await fetch('https://api.github.com/user/emails', { headers });
  if (!emailResp.ok) {
    return { sub };
  }
  const emails = (await emailResp.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
  const preferred = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
  return { sub, email: preferred?.email };
}

async function upsertSocialRow(
  executor: DbExecutor,
  identity: SocialIdentity,
  walletAddress: string,
  smartAccountAddress: string
): Promise<boolean> {
  const existing = await executor.execute(
    `SELECT 1 FROM social_accounts WHERE sub = $1 AND provider = $2 LIMIT 1`,
    [identity.sub, identity.provider]
  );
  const isNewUser = existing.rows.length === 0;

  await executor.execute(
    `INSERT INTO social_accounts
      (sub, provider, email, wallet_address, smart_account_address, smart_account_deploy_tx, sponsored_tx_count)
     VALUES ($1, $2, $3, $4, $5, $6, 0)
     ON CONFLICT (sub, provider)
     DO UPDATE SET
      email = EXCLUDED.email,
      wallet_address = EXCLUDED.wallet_address,
      smart_account_address = COALESCE(social_accounts.smart_account_address, EXCLUDED.smart_account_address),
      smart_account_deploy_tx = COALESCE(social_accounts.smart_account_deploy_tx, EXCLUDED.smart_account_deploy_tx)`,
    [
      identity.sub,
      identity.provider,
      identity.email || null,
      walletAddress,
      smartAccountAddress,
      `simulated-deploy-${Date.now()}`,
    ]
  );

  return isNewUser;
}

export async function completeSocialLogin(identity: SocialIdentity, db?: DbExecutor): Promise<SocialAuthResult> {
  const executor = db ?? defaultDb();
  const walletAddress = deriveWallet(identity.sub);
  const smartAccountAddress = deriveSmartAccount(identity.sub);

  let isNewUser = false;
  try {
    isNewUser = await upsertSocialRow(executor, identity, walletAddress, smartAccountAddress);
  } catch (error) {
    // Fallback for legacy schema before migration lands
    const existing = await executor.execute(
      `SELECT 1 FROM social_accounts WHERE sub = $1 AND provider = $2 LIMIT 1`,
      [identity.sub, identity.provider]
    );
    isNewUser = existing.rows.length === 0;
    await executor.execute(
      `INSERT INTO social_accounts (sub, provider, email, wallet_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [identity.sub, identity.provider, identity.email || null, walletAddress]
    );
  }

  return {
    token: signSession(identity, walletAddress, smartAccountAddress),
    provider: identity.provider,
    sub: identity.sub,
    email: identity.email,
    walletAddress,
    smartAccountAddress,
    isNewUser,
  };
}
