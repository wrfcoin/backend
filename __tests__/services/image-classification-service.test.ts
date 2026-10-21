import {
  ImageClassificationService,
} from '../../server/services/aiml/image-classification-service.js';

function samplePngBuffer(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
}

describe('ImageClassificationService', () => {
  it('classifies image with deterministic fallback when model is unavailable', async () => {
    const service = new ImageClassificationService({
      modelResolver: {
        resolve: async () => null,
      },
    });

    const result = await service.classify({
      imageBuffer: samplePngBuffer(),
      claimedMimeType: 'image/png',
      stationId: 'KSEA',
      capturedAt: '2026-03-05T12:00:00Z',
    });

    expect(result.model.fallbackUsed).toBe(true);
    expect(result.model.engine).toBe('deterministic-fallback');
    expect(result.labels.length).toBeGreaterThan(0);
    expect(result.topLabel).toBe(result.labels[0].label);
    expect(result.context.stationId).toBe('KSEA');
  });

  it('uses runtime adapter when model is available', async () => {
    const service = new ImageClassificationService({
      modelResolver: {
        resolve: async () => ({
          id: 'img-model-1',
          version: '1.0.0',
          filePath: '/tmp/model.onnx',
          labels: ['storm', 'clear'],
        }),
      },
      runtimeAdapter: {
        classify: async () => [2.5, 0.1],
      },
    });

    const result = await service.classify({
      imageBuffer: samplePngBuffer(),
      claimedMimeType: 'image/png',
    });

    expect(result.model.fallbackUsed).toBe(false);
    expect(result.model.engine).toBe('onnxruntime-node');
    expect(result.topLabel).toBe('storm');
  });

  it('rejects MIME mismatch and malformed images', async () => {
    const service = new ImageClassificationService();

    await expect(
      service.classify({
        imageBuffer: samplePngBuffer(),
        claimedMimeType: 'image/jpeg',
      })
    ).rejects.toThrow('Claimed MIME type does not match image signature');

    await expect(
      service.classify({
        imageBuffer: Buffer.from([0x00, 0x01, 0x02]),
      })
    ).rejects.toThrow('Unsupported image type');
  });
});
