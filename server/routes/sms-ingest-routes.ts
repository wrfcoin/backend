/**
 * SMS-to-Earn Ingest Routes
 * Issue #234 — feature-phone weather reporting via Twilio webhook
 *
 * POST /api/sms/ingest — Twilio webhook: parse SMS body → WeatherObservation
 *
 * Expected SMS formats (case-insensitive):
 *   "T:23.5 H:65"          → temperature 23.5°C, humidity 65%
 *   "TEMP 23 HUM 65"       → same
 *   "23.5C 65%"            → same
 *   "P:1013 W:5.2"         → pressure + wind
 *
 * Twilio webhook sends: From, Body, MessageSid, AccountSid
 *
 * Security: every inbound request is validated against the Twilio webhook
 * signature (X-Twilio-Signature) so forged POST requests are rejected before
 * any data is stored.  Set TWILIO_AUTH_TOKEN in the environment; if the
 * token is absent the endpoint returns 503 so misconfigured deployments
 * never silently accept unauthenticated data.
 */

import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { appLogger } from '../utils/logger.js';
import { db } from '../../database/connection.js';

const router = Router();

interface ParsedReading {
  temperature_c?: number;
  humidity_percent?: number;
  pressure_hpa?: number;
  wind_speed_ms?: number;
}

/**
 * Parse weather values from a free-form SMS body.
 * Returns whatever metrics could be extracted.
 */
export function parseSmsBody(body: string): ParsedReading {
  const text = body.toUpperCase().trim();
  const result: ParsedReading = {};

  // Temperature: T:23.5 | TEMP 23 | TEMP:23 | 23.5C | 23.5 C
  const tempMatch =
    text.match(/T(?:EMP)?[:\s]+(-?\d+(?:\.\d+)?)/) ||
    text.match(/(-?\d+(?:\.\d+)?)\s*[°C](?!\w)/);
  if (tempMatch) {
    const val = parseFloat(tempMatch[1]);
    if (val >= -60 && val <= 60) result.temperature_c = val;
  }

  // Humidity: H:65 | HUM 65 | HUM:65 | 65%
  const humMatch =
    text.match(/H(?:UM(?:IDITY)?)?[:\s]+(\d+(?:\.\d+)?)/) ||
    text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (humMatch) {
    const val = parseFloat(humMatch[1]);
    if (val >= 0 && val <= 100) result.humidity_percent = val;
  }

  // Pressure: P:1013 | PRES 1013
  const presMatch = text.match(/P(?:RES(?:SURE)?)?[:\s]+(\d{3,4}(?:\.\d+)?)/);
  if (presMatch) {
    const val = parseFloat(presMatch[1]);
    if (val >= 870 && val <= 1085) result.pressure_hpa = val;
  }

  // Wind speed: W:5.2 | WIND 5.2
  const windMatch = text.match(/W(?:IND)?[:\s]+(\d+(?:\.\d+)?)/);
  if (windMatch) {
    const val = parseFloat(windMatch[1]);
    if (val >= 0 && val <= 100) result.wind_speed_ms = val;
  }

  return result;
}

/**
 * Middleware: validate Twilio webhook signature.
 *
 * Twilio signs every webhook with HMAC-SHA1 using the auth token.  If the
 * signature doesn't match, or if TWILIO_AUTH_TOKEN is not configured, the
 * request is rejected before any handler runs.
 */
function validateTwilioSignature(req: Request, res: Response, next: () => void): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    appLogger.error('TWILIO_AUTH_TOKEN not configured — SMS ingest endpoint disabled');
    res.status(503).type('text/xml').send(
      '<Response><Message>Service unavailable</Message></Response>'
    );
    return;
  }

  // Build the full URL Twilio signed.  Prefer the explicitly configured public
  // URL so reverse-proxy rewrites don't break signature checks.
  const webhookUrl =
    process.env.TWILIO_WEBHOOK_URL ||
    `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    authToken,
    req.headers['x-twilio-signature'] as string ?? '',
    webhookUrl,
    req.body as Record<string, string>,
  );

  if (!isValid) {
    appLogger.warn('Twilio webhook signature validation failed', {
      ip: req.ip,
      url: webhookUrl,
    });
    res.status(403).type('text/xml').send(
      '<Response><Message>Forbidden</Message></Response>'
    );
    return;
  }

  next();
}

/**
 * Twilio webhook handler.
 * Validates the Twilio signature, parses the SMS body, and stores the reading.
 */
router.post('/ingest', validateTwilioSignature, async (req: Request, res: Response) => {
  try {
    // Twilio sends form-urlencoded
    const { From, Body, MessageSid, AccountSid } = req.body as {
      From?: string;
      Body?: string;
      MessageSid?: string;
      AccountSid?: string;
    };

    if (!From || !Body) {
      // Twilio expects a TwiML response even on error
      return res.status(400).type('text/xml').send(
        '<Response><Message>Missing From or Body</Message></Response>'
      );
    }

    const reading = parseSmsBody(Body);

    if (Object.keys(reading).length === 0) {
      return res.type('text/xml').send(
        '<Response><Message>Could not parse weather data. Try: T:23 H:65 P:1013</Message></Response>'
      );
    }

    // Store as a weather ingest event (fire-and-forget, don't block Twilio response)
    setImmediate(async () => {
      try {
        await (db as any).execute(
          `INSERT INTO sms_weather_readings (from_number, message_sid, raw_body, parsed_data, received_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [From, MessageSid ?? null, Body, JSON.stringify(reading)]
        );
      } catch (dbErr) {
        appLogger.warn('SMS reading DB insert failed', { error: (dbErr as Error).message });
      }
    });

    const summary = [
      reading.temperature_c != null ? `${reading.temperature_c}°C` : null,
      reading.humidity_percent != null ? `${reading.humidity_percent}% humidity` : null,
      reading.pressure_hpa != null ? `${reading.pressure_hpa} hPa` : null,
      reading.wind_speed_ms != null ? `${reading.wind_speed_ms} m/s wind` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return res.type('text/xml').send(
      `<Response><Message>Received: ${summary}. Thank you for your WRFCoin contribution!</Message></Response>`
    );
  } catch (err) {
    appLogger.error('SMS ingest error', { error: (err as Error).message });
    return res.status(500).type('text/xml').send(
      '<Response><Message>Server error, please try again</Message></Response>'
    );
  }
});

export default router;
