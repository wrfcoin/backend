import { Router, Request, Response, NextFunction } from 'express';
import {
  SmsObservationGatewayService,
  smsObservationGatewayService,
} from '../services/sms-observation-gateway-service.js';

// CJS operator-token middleware — typed inline to avoid declaration-file
// dependency on the JS module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireOperatorToken } = require('../middleware/operator-token-auth.js') as {
  requireOperatorToken: (req: Request, res: Response, next: NextFunction) => void;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function extractInbound(req: Request) {
  const body = req.body || {};
  return {
    messageId:
      body.messageId || body.message_id || body.MessageSid || body.sms_message_id,
    sender: body.sender || body.sender_id || body.from || body.From,
    text: body.text || body.body || body.Body,
    receivedAt: body.receivedAt || body.received_at,
  };
}

export function createSmsObservationGatewayRouter(
  service: SmsObservationGatewayService = smsObservationGatewayService
): Router {
  const router = Router();

  // Inbound SMS webhooks from providers use signature verification,
  // not JWT — router-level auth removed per review.

  router.post('/observations', async (req: Request, res: Response) => {
    try {
      const inbound = extractInbound(req);
      if (!inbound.messageId || !inbound.sender || !inbound.text) {
        return res.status(400).json({
          success: false,
          error: 'messageId/message_id/MessageSid, sender/from/From, and text/body/Body are required',
        });
      }

      const entry = await service.ingestInboundMessage(inbound);
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
        data: entry,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  });

  // Queue inspection is operator-only: it exposes all pending inbound messages.
  router.get('/observations/queue', requireOperatorToken, (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      count: service.listQueue().length,
      data: service.listQueue(),
    });
  });

  return router;
}

const defaultRouter = createSmsObservationGatewayRouter();
export default defaultRouter;
