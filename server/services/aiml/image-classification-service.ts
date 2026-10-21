import crypto from 'crypto';
import { detectMimeType } from '../../../shared/utils/file-upload-security.js';

export interface ImageClassificationInput {
  imageBuffer: Buffer;
  claimedMimeType?: string;
  stationId?: string;
  regionId?: string;
  capturedAt?: string;
}

export interface ImageClassificationResult {
  labels: Array<{ label: string; confidence: number }>;
  topLabel: string;
  model: {
    id: string | null;
    version: string | null;
    fallbackUsed: boolean;
    engine: string;
  };
  context: {
    stationId: string | null;
    regionId: string | null;
    capturedAt: string | null;
  };
}

interface ModelDescriptor {
  id: string;
  version: string;
  filePath: string;
  labels?: string[];
}

interface ModelResolver {
  resolve(): Promise<ModelDescriptor | null>;
}

interface RuntimeAdapter {
  classify(model: ModelDescriptor, features: Float32Array): Promise<number[]>;
}

interface ImageClassificationServiceOptions {
  modelResolver?: ModelResolver;
  runtimeAdapter?: RuntimeAdapter;
  maxBytes?: number;
}

const DEFAULT_LABELS = ['clear_sky', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class ImageClassificationService {
  private readonly modelResolver: ModelResolver;
  private readonly runtimeAdapter?: RuntimeAdapter;
  private readonly maxBytes: number;

  constructor(options: ImageClassificationServiceOptions = {}) {
    this.modelResolver =
      options.modelResolver ||
      ({
        resolve: async () => null,
      } as ModelResolver);
    this.runtimeAdapter = options.runtimeAdapter;
    this.maxBytes = options.maxBytes || 10 * 1024 * 1024;
  }

  async classify(input: ImageClassificationInput): Promise<ImageClassificationResult> {
    validateInput(input, this.maxBytes);

    const detectedMime = detectMimeType(input.imageBuffer) || null;
    if (!detectedMime || !ALLOWED_TYPES.has(detectedMime)) {
      throw new Error('Unsupported image type. Only JPEG, PNG, and WebP are allowed.');
    }

    if (input.claimedMimeType && input.claimedMimeType !== detectedMime) {
      throw new Error('Claimed MIME type does not match image signature');
    }

    const model = await this.modelResolver.resolve();
    const context = {
      stationId: cleanString(input.stationId),
      regionId: cleanString(input.regionId),
      capturedAt: normalizeIso(input.capturedAt),
    };

    if (!model || !this.runtimeAdapter) {
      return deterministicFallback(input, context, model);
    }

    try {
      const features = toFeatures(input.imageBuffer);
      const logits = await this.runtimeAdapter.classify(model, features);
      if (!Array.isArray(logits) || !logits.length) {
        return deterministicFallback(input, context, model);
      }

      const labels = model.labels?.length ? model.labels : DEFAULT_LABELS;
      const normalized = softmax(logits).slice(0, labels.length);
      const pairs = labels.map((label, idx) => ({
        label,
        confidence: Number((normalized[idx] || 0).toFixed(6)),
      }));
      pairs.sort((a, b) => b.confidence - a.confidence);

      return {
        labels: pairs.slice(0, 5),
        topLabel: pairs[0]?.label || 'unknown',
        model: {
          id: model.id,
          version: model.version,
          fallbackUsed: false,
          engine: 'onnxruntime-node',
        },
        context,
      };
    } catch {
      return deterministicFallback(input, context, model);
    }
  }
}

function validateInput(input: ImageClassificationInput, maxBytes: number): void {
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0) {
    throw new Error('imageBuffer is required');
  }

  if (input.imageBuffer.length > maxBytes) {
    throw new Error(`Image exceeds max allowed size (${maxBytes} bytes)`);
  }
}

function toFeatures(buffer: Buffer): Float32Array {
  // Deterministic byte-level feature extractor used for model IO.
  const windowSize = Math.min(1024, buffer.length);
  const features = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    features[i] = buffer[i] / 255;
  }
  return features;
}

function deterministicFallback(
  input: ImageClassificationInput,
  context: { stationId: string | null; regionId: string | null; capturedAt: string | null },
  model: ModelDescriptor | null
): ImageClassificationResult {
  const hash = crypto.createHash('sha256').update(input.imageBuffer).digest();
  const scores = DEFAULT_LABELS.map((label, idx) => {
    const raw = hash[idx] / 255;
    return {
      label,
      confidence: raw,
    };
  });

  const normalized = softmax(scores.map(item => item.confidence));
  const ranked = scores.map((entry, idx) => ({
    label: entry.label,
    confidence: Number((normalized[idx] || 0).toFixed(6)),
  }));
  ranked.sort((a, b) => b.confidence - a.confidence);

  return {
    labels: ranked,
    topLabel: ranked[0].label,
    model: {
      id: model?.id || null,
      version: model?.version || null,
      fallbackUsed: true,
      engine: 'deterministic-fallback',
    },
    context,
  };
}

function softmax(values: number[]): number[] {
  if (!values.length) {
    return [];
  }

  const max = Math.max(...values);
  const exps = values.map(value => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map(value => value / sum);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}
