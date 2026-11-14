/** Atomic issuance model; the same regression suite also runs on an owned real Redis fixture. */
export function walletNonceChallengeKey(scheme: string, address: string, nonce: string) {
  return `wallet:nonce:v2:{${scheme}:${address.toLowerCase()}}:challenge:${encodeURIComponent(nonce)}`;
}

/** Models the v3 script: a per-client counter, a per-address backstop counter, then the challenge. */
export function attachWalletNonceIssuer(redis: any) {
  const quotas = new Map<string, { count: number; expires: number }>();
  redis.eval = jest.fn(async (_script: string, keyCount: number, clientQuota: string, addressQuota: string,
    challenge: string, limit: string | number, ttl: string | number, value: string, backstop: string | number) => {
    if (keyCount !== 3) throw new Error('expected three issuance keys');
    const now = Date.now();
    const window = (key: string) => {
      const live = quotas.get(key);
      return live && live.expires > now ? live : { count: 0, expires: now + Number(ttl) * 1000 };
    };
    const mine = window(clientQuota);
    const all = window(addressQuota);
    if (mine.count >= Number(limit)) return [0, Math.max(1, Math.ceil((mine.expires - now) / 1000))];
    if (all.count >= Number(backstop)) return [0, Math.max(1, Math.ceil((all.expires - now) / 1000))];
    mine.count += 1;
    all.count += 1;
    quotas.set(clientQuota, mine);
    quotas.set(addressQuota, all);
    await redis.set(challenge, value, 'EX', ttl);
    return [1, Number(ttl)];
  });
  return redis;
}
