import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateJWT } from '../middleware/auth.js';
import {
  NarrativeWeatherReportService,
  type NarrativeRegionBounds,
} from '../services/weather/narrative-weather-report-service.js';
import { SevereWeatherResponseService } from '../services/weather/severe-weather-response-service.js';

const weatherPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

interface WeatherReportRouterOptions {
  service?: NarrativeWeatherReportService;
  alertsService?: SevereWeatherResponseService;
}

function parseRegionBounds(value: any): NarrativeRegionBounds | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('regionBounds must be an object with north/south/east/west');
  }

  return {
    north: Number(value.north),
    south: Number(value.south),
    east: Number(value.east),
    west: Number(value.west),
  };
}

export function createWeatherReportRouter(
  options: WeatherReportRouterOptions = {}
): express.Router {
  const router = express.Router();

  // All weather report operations require authentication (#231). Scoped to
  // this router's own subtree — see weather-alerts-routes.ts / #880 for why
  // an unscoped guard on a bare-'/api' mount poisons the whole namespace.
  router.use('/weather/report', authenticateJWT);

  const alertsService = options.alertsService || new SevereWeatherResponseService();
  const service =
    options.service ||
    new NarrativeWeatherReportService({
      alertsProvider: {
        getActiveAlerts: async () => {
          const existing = alertsService.getActiveAlerts();
          if (existing.length > 0) {
            return existing;
          }

          try {
            await alertsService.pollNow();
            return alertsService.getActiveAlerts();
          } catch {
            return [];
          }
        },
      },
      llmEnhancer: createConfiguredLlmEnhancer(),
    });

  router.post('/weather/report/narrative', weatherPostLimiter, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({
          success: false,
          error: 'Request body must be a JSON object',
        });
      }

      const report = await service.generateReport({
        stationId:
          typeof req.body.stationId === 'string'
            ? req.body.stationId
            : typeof req.body.station_id === 'string'
              ? req.body.station_id
              : undefined,
        regionBounds: parseRegionBounds(req.body.regionBounds || req.body.region_bounds),
        style: req.body.style,
        includeEnsembleSummary: Boolean(req.body.includeEnsembleSummary ?? req.body.include_ensemble_summary),
        enhanceWithLlm: Boolean(req.body.enhanceWithLlm ?? req.body.enhance_with_llm),
      });

      return res.status(200).json({
        success: true,
        report,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate weather report',
      });
    }
  });

  return router;
}

const defaultRouter = createWeatherReportRouter();
export default defaultRouter;

function createConfiguredLlmEnhancer(): { enhance: (input: { style: string; text: string }) => Promise<string> } | undefined {
  const openAiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openAiKey) {
    return {
      enhance: async ({ style, text }) => {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openAiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.OPENAI_NARRATIVE_MODEL || 'gpt-4.1-mini',
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: `Rewrite the weather narrative in a ${style} style without changing facts.`,
              },
              { role: 'user', content: text },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI enhancement failed (${response.status})`);
        }

        const json = (await response.json()) as any;
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('OpenAI enhancement returned empty response');
        }
        return content.trim();
      },
    };
  }

  if (anthropicKey) {
    return {
      enhance: async ({ style, text }) => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_NARRATIVE_MODEL || 'claude-3-5-haiku-latest',
            max_tokens: 500,
            temperature: 0.2,
            system: `Rewrite the weather narrative in a ${style} style without changing facts.`,
            messages: [{ role: 'user', content: text }],
          }),
        });

        if (!response.ok) {
          throw new Error(`Anthropic enhancement failed (${response.status})`);
        }

        const json = (await response.json()) as any;
        const content = json?.content?.[0]?.text;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('Anthropic enhancement returned empty response');
        }
        return content.trim();
      },
    };
  }

  return undefined;
}
