import express from 'express';
import crypto from 'node:crypto';
import { authenticateSessionJWT } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../../shared/types/security-types.js';
import { z } from 'zod';
import {
  validatePhysics,
  qualityScore,
  DEFAULT_PHYSICS_POLICY,
} from '../services/physics-validation.js';
import { createWeatherCommitRevealService } from './weather-commit-reveal-routes.js';

const ReadingSchema = z.object({
  walletAddress:   z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  deviceId:        z.string().min(1).max(128),
  latitude:        z.number().min(-90).max(90),
  longitude:       z.number().min(-180).max(180),
  altitude:        z.number().optional(),
  temperature:     z.number().optional(),
  pressure:        z.number().optional(),
  humidity:        z.number().min(0).max(100).optional(),
  windSpeed:       z.number().min(0).optional(),
  windDirection:   z.number().min(0).max(360).optional(),
  rainfall:        z.number().min(0).optional(),
  timestampUnix:   z.number().int(),
  previousReading: z.object({
    temperature:   z.number().optional(),
    timestampUnix: z.number().int(),
  }).optional(),
});

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

export function createSensorIngestRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  // All sensor ingestion operations require authentication (#231)
  router.use(authenticateSessionJWT);

  router.post('/reading', async (req, res) => {
    const executor = db ?? defaultDb();

    // 1. Parse & validate schema
    const parsed = ReadingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const { walletAddress, deviceId } = body;

    // 2. Ownership: the reward-attribution identity MUST be the authenticated
    // caller's own wallet, never an arbitrary client-supplied address — else
    // one authenticated session can attribute unlimited submissions to
    // arbitrary wallets (Sybil reward farming, #886).
    const authUser = (req as AuthenticatedRequest).user;
    const rawCallerUserId = authUser?.userId ?? authUser?.id;
    const callerUserId = rawCallerUserId !== undefined ? Number(rawCallerUserId) : NaN;
    if (!rawCallerUserId || Number.isNaN(callerUserId)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let ownWallet: string | null = null;
    try {
      const ownerRes = await executor.execute(
        `SELECT wallet_address FROM users WHERE id = $1 LIMIT 1`,
        [callerUserId],
      );
      ownWallet = (ownerRes.rows[0]?.wallet_address as string) ?? null;
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!ownWallet) {
      return res.status(403).json({ error: 'No wallet linked to your account' });
    }
    if (ownWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({
        error: 'Forbidden: walletAddress must match your authenticated wallet address',
      });
    }

    // 3. Gate: social account required (mobile app uses OIDC social auth)
    try {
      const socialRes = await executor.execute(
        `SELECT 1 FROM social_accounts WHERE wallet_address = $1 LIMIT 1`,
        [walletAddress],
      );
      if (socialRes.rows.length === 0) {
        return res.status(403).json({ error: 'No social account linked to this wallet' });
      }
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // 4. Physics validation — TypeScript port of core4 validate_physics()
    const currentReading = {
      temperatureC:  body.temperature  ?? null,
      pressureHpa:   body.pressure     ?? null,
      humidityPct:   body.humidity     ?? null,
      windSpeedMs:   body.windSpeed    ?? null,
      timestampUnix: body.timestampUnix,
    };
    const prevReading = body.previousReading
      ? {
          temperatureC:  body.previousReading.temperature ?? null,
          timestampUnix: body.previousReading.timestampUnix,
        }
      : null;

    const violations = validatePhysics(currentReading, prevReading, DEFAULT_PHYSICS_POLICY);
    const score      = qualityScore(violations);

    // 5. Persist reading. `callerUserId` was already resolved and verified to
    // own `walletAddress` in the ownership check above — no need to re-derive
    // it via a second wallet_address -> id lookup.
    try {
      await executor.execute(
        `INSERT INTO weather_submissions
           (user_id, wallet_address, device_id, latitude, longitude, altitude,
            temperature, humidity, pressure, wind_speed, wind_direction, rainfall,
            quality_score, physics_violations, source, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'mobile',to_timestamp($15))`,
        [
          callerUserId,
          walletAddress,
          deviceId,
          body.latitude,
          body.longitude,
          body.altitude          ?? null,
          body.temperature       ?? null,
          body.humidity          ?? null,
          body.pressure          ?? null,
          body.windSpeed         ?? null,
          body.windDirection     ?? null,
          body.rainfall          ?? null,
          score,
          JSON.stringify(violations),
          body.timestampUnix,
        ],
      );
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // Fire-and-forget: forward to commit-reveal pipeline (#191)
    // Don't await — sensor persistence should succeed even if core4 is down
    createWeatherCommitRevealService().commit({
      stationId: deviceId,
      readings: [{
        temperature_c:   body.temperature   ?? null,
        pressure_hpa:    body.pressure      ?? null,
        humidity_percent: body.humidity      ?? null,
        wind_speed_ms:   body.windSpeed     ?? null,
        latitude:        body.latitude,
        longitude:       body.longitude,
        timestamp_unix:  body.timestampUnix,
      }],
      nonce: crypto.randomUUID(),
      contributor: walletAddress,
    }).catch((err) => {
      console.error('[sensor-ingest] commit-reveal forwarding failed:', err);
    });

    return res.status(200).json({ accepted: true, qualityScore: score, violations });
  });

  return router;
}

export default createSensorIngestRouter();
