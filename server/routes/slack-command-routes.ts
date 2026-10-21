/**
 * Slack Command Routes - Inbound Slack → WRFCoin Bridge
 * Handles slash commands and interactive components from Slack
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { securityLogger } from '../utils/logger.js';
import { slackNotificationService } from '../services/slack-notification-service.js';
import { incidentPlaybookEngine } from '../services/incidentPlaybookEngine.js';

const router = express.Router();

const SLACK_SIGNING_VERSION = 'v0';

function verifySlackSignature(req: Request, res: Response, next: NextFunction): void {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    const isLocalDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    securityLogger.warn('Slack signing secret not configured', { nodeEnv: process.env.NODE_ENV, isLocalDev });
    if (!isLocalDev) {
      res.status(503).json({ error: 'Slack verification not configured' });
      return;
    }
    next();
    return;
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    res.status(401).json({ error: 'Missing Slack signature headers' });
    return;
  }

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    res.status(401).json({ error: 'Request timestamp too old' });
    return;
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const sigBasestring = `${SLACK_SIGNING_VERSION}:${timestamp}:${rawBody}`;
  const mySignature = `${SLACK_SIGNING_VERSION}=` +
    crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature))) {
    securityLogger.warn('Invalid Slack signature', { ip: req.ip });
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

interface SlackCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
}

interface CommandResult {
  response_type: 'ephemeral' | 'in_channel';
  text: string;
  attachments?: { color: string; text: string }[];
}

async function handleHealthCommand(): Promise<CommandResult> {
  const portRegistry = await import('../../config/port-registry.json', { assert: { type: 'json' } })
    .catch(() => ({ default: {} }));

  const services = Object.entries(portRegistry.default || {}).slice(0, 10);
  const healthChecks: { name: string; status: string; latency?: number }[] = [];

  for (const [name, config] of services) {
    const port = (config as any)?.port;
    if (!port) continue;

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      healthChecks.push({
        name,
        status: response.ok ? 'healthy' : 'degraded',
        latency: Date.now() - start,
      });
    } catch {
      healthChecks.push({ name, status: 'unhealthy' });
    }
  }

  const healthy = healthChecks.filter(s => s.status === 'healthy').length;
  const total = healthChecks.length;
  const overall = healthy === total ? 'healthy' : healthy > total / 2 ? 'degraded' : 'unhealthy';

  const serviceList = healthChecks
    .map(s => {
      const emoji = s.status === 'healthy' ? '✅' : s.status === 'degraded' ? '⚠️' : '❌';
      const latency = s.latency ? ` (${s.latency}ms)` : '';
      return `${emoji} ${s.name}${latency}`;
    })
    .join('\n');

  return {
    response_type: 'in_channel',
    text: `*WRFCoin Health Status: ${overall.toUpperCase()}*\n\n${serviceList}\n\n_${healthy}/${total} services healthy_`,
  };
}

async function handleIncidentCommand(args: string): Promise<CommandResult> {
  try {
    const history = incidentPlaybookEngine.getIncidentHistory({ limit: 5 });

    if (history.incidents.length === 0) {
      return {
        response_type: 'ephemeral',
        text: 'No recent incidents found.',
      };
    }

    const incidentList = history.incidents
      .map(i => {
        const emoji = i.severity === 'SEV1' ? '🔴' : i.severity === 'SEV2' ? '🟠' : '🟡';
        return `${emoji} *${i.alertName}* (${i.severity}) - ${i.status}\n   ID: \`${i.id.substring(0, 8)}\` | Actions: ${i.actionsExecuted}`;
      })
      .join('\n\n');

    return {
      response_type: 'in_channel',
      text: `*Recent WRFCoin Incidents*\n\n${incidentList}`,
    };
  } catch (err) {
    return {
      response_type: 'ephemeral',
      text: `Failed to fetch incidents: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface ChainStatus {
  network?: string;
  status?: string;
  currentBlock?: number | string;
  totalTransactions?: number | string;
  activeNodes?: number | string;
  consensusAlgorithm?: string;
}

async function handleChainCommand(args: string): Promise<CommandResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('http://localhost:4001/api/blockchain/status', { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const status = await response.json() as ChainStatus;

    return {
      response_type: 'in_channel',
      text: `*WRFCoin Chain Status*\n` +
        `• Network: ${status.network || 'WRF Testnet'}\n` +
        `• Status: ${status.status || 'unknown'}\n` +
        `• Block: ${status.currentBlock || 'N/A'}\n` +
        `• Transactions: ${status.totalTransactions || 'N/A'}\n` +
        `• Active Nodes: ${status.activeNodes || 'N/A'}\n` +
        `• Consensus: ${status.consensusAlgorithm || 'Proof of Weather'}`,
    };
  } catch (err) {
    return {
      response_type: 'ephemeral',
      text: `Failed to query chain: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleStatusCommand(): Promise<CommandResult> {
  const health = await handleHealthCommand();
  const chain = await handleChainCommand('');

  return {
    response_type: 'in_channel',
    text: `${chain.text}\n\n---\n\n${health.text}`,
  };
}

async function handleHelpCommand(): Promise<CommandResult> {
  return {
    response_type: 'ephemeral',
    text: `*WRFCoin Slack Commands*\n\n` +
      `• \`/wrfcoin-health\` - Check service health\n` +
      `• \`/wrfcoin-incident\` - View recent incidents\n` +
      `• \`/wrfcoin-chain\` - Query blockchain status\n` +
      `• \`/wrfcoin-status\` - Combined health + chain status\n` +
      `• \`/wrfcoin-help\` - Show this help message\n\n` +
      `_Alerts are automatically sent to #wrfcoin-alerts channels_`,
  };
}

const COMMAND_HANDLERS: Record<string, (args: string) => Promise<CommandResult>> = {
  '/wrfcoin-health': handleHealthCommand,
  '/wrfcoin-incident': handleIncidentCommand,
  '/wrfcoin-chain': handleChainCommand,
  '/wrfcoin-status': handleStatusCommand,
  '/wrfcoin-help': handleHelpCommand,
};

router.post('/commands', verifySlackSignature, async (req: Request, res: Response) => {
  const requestId = uuidv4();
  const payload = req.body as SlackCommandPayload;

  securityLogger.info('Slack command received', {
    requestId,
    command: payload.command,
    user: payload.user_name,
    channel: payload.channel_name,
    text: payload.text,
  });

  const handler = COMMAND_HANDLERS[payload.command];

  if (!handler) {
    res.json({
      response_type: 'ephemeral',
      text: `Unknown command: ${payload.command}. Try \`/wrfcoin-help\` for available commands.`,
    });
    return;
  }

  try {
    const result = await handler(payload.text);
    res.json(result);
  } catch (err) {
    securityLogger.error('Slack command handler error', {
      requestId,
      command: payload.command,
      error: err instanceof Error ? err.message : String(err),
    });
    res.json({
      response_type: 'ephemeral',
      text: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

router.post('/interactive', verifySlackSignature, async (req: Request, res: Response) => {
  const requestId = uuidv4();

  try {
    const payload = typeof req.body.payload === 'string'
      ? JSON.parse(req.body.payload)
      : req.body;

    securityLogger.info('Slack interactive component', {
      requestId,
      type: payload.type,
      user: payload.user?.username,
    });

    res.json({ text: 'Action received' });
  } catch (err) {
    securityLogger.error('Slack interactive handler error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/events', verifySlackSignature, async (req: Request, res: Response) => {
  if (req.body.type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return;
  }

  const requestId = uuidv4();
  securityLogger.info('Slack event received', {
    requestId,
    type: req.body.event?.type,
    user: req.body.event?.user,
  });

  res.status(200).send();
});

export default router;
