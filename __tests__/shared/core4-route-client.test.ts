import { extractCore4Data, getCore4ErrorMessage } from '../../shared/core4-route-client.js';

describe('extractCore4Data', () => {
  it('unwraps { success: true, data } envelope', () => {
    const result = extractCore4Data({ success: true, data: { height: 100 } });
    expect(result).toEqual({ height: 100 });
  });

  it('unwraps { ok: true, data } envelope (core4 LawBookEnvelope)', () => {
    const result = extractCore4Data({ ok: true, data: { height: 100 } });
    expect(result).toEqual({ height: 100 });
  });

  it('returns plain object as-is when no envelope wrapper', () => {
    const result = extractCore4Data({ height: 100 });
    expect(result).toEqual({ height: 100 });
  });

  it('returns null for null input', () => {
    const result = extractCore4Data(null);
    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = extractCore4Data(undefined);
    expect(result).toBeNull();
  });

  it('returns null when data field is null inside envelope', () => {
    const result = extractCore4Data({ ok: true, data: null });
    expect(result).toBeNull();
  });
});

describe('getCore4ErrorMessage', () => {
  it('extracts message from { error: { code, message } } (core4 envelope error)', () => {
    const result = getCore4ErrorMessage(
      { error: { code: 'NOT_FOUND', message: 'Block not found' } },
      'fallback',
    );
    expect(result).toBe('Block not found');
  });

  it('extracts simple string error', () => {
    const result = getCore4ErrorMessage({ error: 'simple string' }, 'fallback');
    expect(result).toBe('simple string');
  });

  it('returns fallback for empty payload', () => {
    const result = getCore4ErrorMessage({}, 'fallback message');
    expect(result).toBe('fallback message');
  });

  it('returns string payload directly', () => {
    const result = getCore4ErrorMessage('raw error text', 'fallback');
    expect(result).toBe('raw error text');
  });

  it('prefers error.message over payload.message when both present', () => {
    const result = getCore4ErrorMessage(
      { error: { code: 'ERR', message: 'nested msg' }, message: 'top msg' },
      'fallback',
    );
    expect(result).toBe('nested msg');
  });

  it('extracts deeply nested core4 envelope message objects', () => {
    const result = getCore4ErrorMessage(
      {
        error: {
          code: 'ERR',
          message: {
            message: 'deep nested msg',
          },
        },
      },
      'fallback',
    );
    expect(result).toBe('deep nested msg');
  });
});
