/**
 * The shared passkey module (services/passkey/webauthn.ts) and the payout-notify re-exports must stay the
 * same functions, and each route's Redis nonce store must keep its own key space.
 */
import * as shared from '../server/services/passkey/webauthn.js';
import * as notify from '../server/services/payout-notify/passkey-proof.js';

class FakeRedis {
  readonly keys = new Map<string, string>();
  async eval(_script: string, _n: number, issuedKey: string, nonceKey: string, _limit: number, _ttl: number, value: string) {
    this.keys.set(issuedKey, '1');
    this.keys.set(nonceKey, value);
    return 1;
  }
  async get(key: string) { return this.keys.get(key) ?? null; }
  async del(key: string) { return this.keys.delete(key) ? 1 : 0; }
}

const ADDRESS = '0x' + 'ab'.repeat(20);
const NONCE = 'cd'.repeat(32);

describe('shared passkey module', () => {
  it('payout-notify re-exports the shared verifier, not a copy', () => {
    expect(notify.verifyPasskeyAssertion).toBe(shared.verifyPasskeyAssertion);
    expect(notify.parsePasskeyAuth).toBe(shared.parsePasskeyAuth);
    expect(notify.passkeyAddress).toBe(shared.passkeyAddress);
    expect(notify.createMemoryNonceStore).toBe(shared.createMemoryNonceStore);
    expect(notify.NONCE_TTL_SEC).toBe(300);
  });

  it('keeps the payout-notify Redis key space unchanged', async () => {
    const redis = new FakeRedis();
    const store = notify.createRedisNonceStore(() => redis, () => 1_000_000);
    expect(await store.issue(ADDRESS, NONCE, 2000)).toBe(true);
    expect([...redis.keys.keys()]).toEqual([
      `payout-notify:passkey:v1:{${ADDRESS}}:issued`,
      `payout-notify:passkey:v1:{${ADDRESS}}:nonce:${NONCE}`,
    ]);
  });

  it('gives another prefix its own key space', async () => {
    const redis = new FakeRedis();
    const notifyStore = notify.createRedisNonceStore(() => redis, () => 1_000_000);
    const other = shared.createRedisNonceStore(() => redis, 'other:passkey:v1', () => 1_000_000);
    await other.issue(ADDRESS, NONCE, 2000);
    expect(await notifyStore.peek(ADDRESS, NONCE)).toBeNull();
    expect(await notifyStore.consume(ADDRESS, NONCE)).toBe(false);
    expect(await other.consume(ADDRESS, NONCE)).toBe(true);
  });

  it('frames strings as u32le length then UTF-8', () => {
    expect(shared.framed('ab').toString('hex')).toBe('020000006162');
  });
});
