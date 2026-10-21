/**
 * AlertManager Webhook Server - Port 19093
 * Receives alerts from AlertManager and routes them to Slack + Incident Playbook Engine
 *
 * Testnet AlertManager already configured to send critical alerts here:
 * http://host.docker.internal:19093/alerts
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { securityLogger } from './utils/logger.js';
import { slackNotificationService, SlackAlert } from './services/slack-notification-service.js';
import { incidentPlaybookEngine, AlertManagerPayload } from './services/incidentPlaybookEngine.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;

const app = express();
const PORT = parseInt(process.env.ALERTMANAGER_WEBHOOK_PORT || '19093', 10);
const ALERTMANAGER_SECRET_HEADER = 'x-alertmanager-secret';

const probeState = { draining: false };

app.use(cors({
  origin: resolveAllowedOrigins({ developmentDefaults: ['http://localhost:*'] }),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

function timingSafeSecretMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function authenticateAlertManagerWebhook(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.ALERTMANAGER_WEBHOOK_SECRET;
  const requestId = uuidv4();

  if (!configuredSecret || configuredSecret.trim().length === 0) {
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    securityLogger.warn('AlertManager webhook secret not configured', { nodeEnv: process.env.NODE_ENV, isLocalDev });
    if (!isLocalDev) {
      res.status(503).json({
        success: false,
        error: { code: 'WEBHOOK_AUTH_NOT_CONFIGURED', message: 'Webhook authentication is not configured' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }
    next();
    return;
  }

  const providedSecret = req.header(ALERTMANAGER_SECRET_HEADER) || '';
  if (!providedSecret) {
    securityLogger.warn('AlertManager webhook missing secret header', {
      requestId,
      ip: req.ip,
    });
    res.status(401).json({
      success: false,
      error: { code: 'WEBHOOK_AUTH_REQUIRED', message: 'Missing webhook authentication secret' },
      timestamp: new Date().toISOString(),
      requestId,
    });
    return;
  }

  if (!timingSafeSecretMatch(configuredSecret, providedSecret)) {
    securityLogger.warn('AlertManager webhook invalid secret', {
      requestId,
      ip: req.ip,
    });
    res.status(403).json({
      success: false,
      error: { code: 'WEBHOOK_AUTH_INVALID', message: 'Invalid webhook authentication secret' },
      timestamp: new Date().toISOString(),
      requestId,
    });
    return;
  }

  next();
}

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: probeState.draining ? 'draining' : 'healthy',
    service: 'alertmanager-webhook-handler',
    port: PORT,
    slackEnabled: slackNotificationService.isEnabled(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (req: Request, res: Response) => {
  if (probeState.draining) {
    res.status(503).json({ ready: false, reason: 'draining' });
    return;
  }
  res.json({ ready: true });
});

app.get('/live', (req: Request, res: Response) => {
  res.json({ live: true });
});

app.post('/alerts', authenticateAlertManagerWebhook, async (req: Request, res: Response) => {
  const requestId = uuidv4();
  const startTime = Date.now();

  try {
    const payload = req.body as AlertManagerPayload;

    if (!payload || !Array.isArray(payload.alerts)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'Invalid AlertManager webhook payload' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    securityLogger.info('AlertManager webhook received', {
      requestId,
      alertCount: payload.alerts.length,
      alertNames: payload.alerts.map(a => a.labels?.alertname || 'unknown'),
    });

    const results = {
      processedAlerts: 0,
      slackNotifications: 0,
      incidentsTriggered: 0,
      incidents: [] as { id: string; alertName: string; severity: string; status: string }[],
      errors: [] as string[],
    };

    for (const alert of payload.alerts) {
      try {
        results.processedAlerts++;

        const slackAlert: SlackAlert = {
          alertname: alert.labels?.alertname || 'UnknownAlert',
          severity: (alert.labels?.severity as SlackAlert['severity']) || 'warning',
          status: alert.status as 'firing' | 'resolved',
          description: alert.annotations?.description,
          summary: alert.annotations?.summary,
          labels: alert.labels,
          annotations: alert.annotations,
          startsAt: alert.startsAt,
          endsAt: alert.endsAt,
        };

        const slackResult = await slackNotificationService.sendAlert(slackAlert);
        if (slackResult.success) {
          results.slackNotifications++;
        } else if (slackResult.error) {
          results.errors.push(`Slack: ${slackResult.error}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.errors.push(`Alert processing: ${errMsg}`);
        securityLogger.error('Failed to process alert', {
          requestId,
          alertName: alert.labels?.alertname,
          error: errMsg,
        });
      }
    }

    try {
      const incidents = await incidentPlaybookEngine.processAlertManagerWebhook(payload);
      results.incidentsTriggered = incidents.length;
      results.incidents = incidents.map(i => ({
        id: i.id,
        alertName: i.alertName,
        severity: i.severity,
        status: i.status,
      }));

      for (const incident of incidents) {
        await slackNotificationService.sendIncident({
          id: incident.id,
          alertName: incident.alertName,
          severity: incident.severity as SlackAlert['severity'],
          status: incident.status,
          actionsExecuted: incident.actionsExecuted.length,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Playbook: ${errMsg}`);
      securityLogger.error('Failed to process playbook', {
        requestId,
        error: errMsg,
      });
    }

    const duration = Date.now() - startTime;
    securityLogger.info('AlertManager webhook processed', {
      requestId,
      duration,
      ...results,
    });

    res.json({
      success: true,
      data: results,
      timestamp: new Date().toISOString(),
      requestId,
      durationMs: duration,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    securityLogger.error('AlertManager webhook handler error', {
      requestId,
      error: errMsg,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: errMsg },
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
});

app.post('/test', authenticateAlertManagerWebhook, async (req: Request, res: Response) => {
  const testAlert: SlackAlert = {
    alertname: 'TestAlert',
    severity: 'warning',
    status: 'firing',
    description: 'This is a test alert from the AlertManager webhook handler',
    summary: 'Test alert triggered manually',
    labels: { env: 'test', source: 'webhook-handler' },
  };

  const result = await slackNotificationService.sendAlert(testAlert);
  res.json({
    success: result.success,
    message: result.success ? 'Test alert sent to Slack' : `Failed: ${result.error}`,
    timestamp: new Date().toISOString(),
  });
});

function startServer(): void {
  const server = app.listen(PORT, '0.0.0.0', () => {
    securityLogger.info(`AlertManager webhook server started`, {
      port: PORT,
      slackEnabled: slackNotificationService.isEnabled(),
      nodeEnv: process.env.NODE_ENV || 'development',
    });
    console.log(`AlertManager webhook server listening on port ${PORT}`);
    console.log(`  POST /alerts    - AlertManager webhook endpoint`);
    console.log(`  POST /test      - Send test alert to Slack`);
    console.log(`  GET  /health    - Health check`);
  });

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, starting graceful shutdown...`);
    probeState.draining = true;

    setTimeout(() => {
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();

export { app };
