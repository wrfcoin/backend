import { Router, Request, Response, NextFunction } from 'express';
import {
  EmailGatewayRefusal,
  EmailObservationGatewayService,
  MAX_EMAIL_BODY_BYTES,
  getEmailObservationGatewayService,
  publicEntry,
} from '../services/email-observation-gateway-service.js';

// CJS operator-token middleware — typed inline to avoid declaration-file
// dependency on the JS module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireOperatorToken } = require('../middleware/operator-token-auth.js') as {
  requireOperatorToken: (req: Request, res: Response, next: NextFunction) => void;
};

/** Read per request, so the gateway can be switched without a restart of the router. */
export const emailObservationsEnabled = (): boolean =>
  process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS === 'true';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Field names of the common inbound-parse webhooks (SendGrid `from`/`text`, Mailgun
 * `sender`/`body-plain`/`Message-Id`, Postmark `From`/`TextBody`/`MessageID`) plus a plain
 * `messageId`/`sender`/`body` shape. Only the plain-text body is read; HTML and attachments
 * are ignored.
 */
function extractInbound(req: Request) {
  const body = req.body || {};
  return {
    messageId: firstString(body.messageId, body.message_id, body['Message-Id'], body.MessageID),
    sender: firstString(body.sender, body.from, body.From),
    body: firstString(body.body, body.text, body['body-plain'], body.TextBody),
    receivedAt: firstString(body.receivedAt, body.received_at),
  };
}

export function createEmailObservationGatewayRouter(
  getService: () => EmailObservationGatewayService = getEmailObservationGatewayService
): Router {
  const router = Router();

  // Dormant by default: while the flag is off the transport does not exist (404), and the
  // service (and its secret check) is never constructed. Applied per route, AFTER any auth
  // guard, so an operator-only route still answers 401 to an anonymous caller either way.
  const dormant = (_req: Request, res: Response, next: NextFunction) => {
    if (!emailObservationsEnabled()) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return next();
  };

  // Refuse an oversized request from its declared length, before any work. The servers also
  // mount a 16 KiB body parser on this path ahead of their global 1 MB parser.
  const declaredSizeCap = (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers?.['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_EMAIL_BODY_BYTES + 4096) {
      return res.status(413).json({ success: false, error: 'request body too large' });
    }
    return next();
  };

  // Inbound email webhooks carry no JWT; the envelope HMAC is the authentication. The response
  // never carries the sender (not even its hash) or the risk detail.
  router.post('/observations', dormant, declaredSizeCap, async (req: Request, res: Response) => {
    const inbound = extractInbound(req);
    if (!inbound.messageId || !inbound.sender || !inbound.body) {
      return res.status(400).json({
        success: false,
        error: 'messageId/Message-Id/MessageID, sender/from/From, and body/text/body-plain/TextBody are required',
      });
    }
    try {
      const entry = await getService().ingestInboundEmail({
        messageId: inbound.messageId,
        sender: inbound.sender,
        body: inbound.body,
        receivedAt: inbound.receivedAt,
      });
      const status =
        entry.deliveryState === 'processed'
          ? 201
          : entry.deliveryState === 'queued_for_retry'
            ? 202
            : entry.deliveryState === 'duplicate'
              ? 200
              : 400;
      return res.status(status).json({
        success: entry.deliveryState !== 'rejected',
        data: publicEntry(entry),
      });
    } catch (error) {
      const status = error instanceof EmailGatewayRefusal ? error.status : 400;
      return res.status(status).json({ success: false, error: getErrorMessage(error) });
    }
  });

  // Queue inspection is operator-only: it exposes every pending inbound message.
  router.get('/observations/queue', requireOperatorToken, dormant, (_req: Request, res: Response) => {
    const queue = getService().listQueue();
    res.status(200).json({ success: true, count: queue.length, data: queue });
  });

  return router;
}

const defaultRouter = createEmailObservationGatewayRouter();
export default defaultRouter;
