import { describe, expect, it } from '@jest/globals';

import {
  parseWebSocketMessage,
  validateMessage,
} from '../src/websocket/validators';

describe('WebSocket message parsing', () => {
  it('rejects malformed JSON before validation', () => {
    const result = parseWebSocketMessage('{"type":"ping"');

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('Invalid JSON format');
    expect(result.data).toBeNull();
  });

  it('accepts valid JSON and keeps ping messages valid', () => {
    const parsed = parseWebSocketMessage(
      Buffer.from(JSON.stringify({ type: 'ping', payload: {} }))
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ type: 'ping', payload: {} });

    const validation = validateMessage(parsed.data);
    expect(validation.success).toBe(true);
    expect(validation.data).toEqual({ type: 'ping', payload: {} });
  });

  it('rejects structurally invalid but parseable payloads', () => {
    const parsed = parseWebSocketMessage(
      JSON.stringify({ type: 'wallet_update', payload: { address: 'bad' } })
    );

    expect(parsed.success).toBe(true);

    const validation = validateMessage(parsed.data);
    expect(validation.success).toBe(false);
  });
});
