/**
 * Weather Proof Card Routes
 * Issue #229 — shareable social-media-ready attestation cards
 *
 * GET /api/proofs/:observation_id/card — returns JSON metadata for a proof card
 */

import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db, executeQuery } from '../../database/connection.js';

const router = Router();

/**
 * Returns attestation card metadata for a weather observation.
 * Clients can use this JSON to render an SVG/image for social sharing.
 */
router.get('/:observation_id/card', async (req: Request, res: Response) => {
  try {
    const { observation_id } = req.params;

    // Look up the observation from weather_data table (uses JSONB payload)
    const { rows } = await executeQuery(
      `SELECT id, station_id, timestamp, data, tx_hash
       FROM weather_data
       WHERE id = $1
       LIMIT 1`,
      [observation_id]
    );

    const obs = rows[0];
    if (!obs) {
      return res.status(404).json({
        success: false,
        error: 'Observation not found',
        timestamp: new Date().toISOString(),
      });
    }

    const data = typeof obs.data === 'string' ? JSON.parse(obs.data) : obs.data ?? {};

    const card = {
      observationId: obs.id,
      stationId: obs.station_id,
      observedAt: obs.timestamp instanceof Date
        ? obs.timestamp.toISOString()
        : String(obs.timestamp),
      metrics: {
        temperatureC: data.temperature_c ?? null,
        humidityPercent: data.humidity_percent ?? null,
        pressureHpa: data.pressure_hpa ?? null,
        windSpeedMs: data.wind_speed_ms ?? null,
        precipitationMm: data.precipitation_mm ?? null,
      },
      attestation: {
        blockchainTxHash: obs.tx_hash ?? null,
        verifiedOnChain: !!obs.tx_hash,
        attestedAt: new Date().toISOString(),
      },
      socialCard: {
        title: 'Verified Weather Observation',
        subtitle: `Station ${obs.station_id}`,
        shareText: `I verified a real weather reading on WRFCoin! 🌤️ ${
          data.temperature_c != null ? `${data.temperature_c}°C` : ''
        } ${data.humidity_percent != null ? `${data.humidity_percent}% humidity` : ''}`.trim(),
        badgeUrl: `/api/proofs/${obs.id}/badge.svg`,
      },
    };

    return res.json({
      success: true,
      data: card,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
