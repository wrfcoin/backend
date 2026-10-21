/** Atomic issuance model; the same regression suite also runs on an owned real Redis fixture. */
export function walletNonceChallengeKey(scheme: string, address: string, nonce: string) {
  return `wallet:nonce:v2:{${scheme}:${address.toLowerCase()}}:challenge:${encodeURIComponent(nonce)}`;
}

export function attachWalletNonceIssuer(redis: any) {
  const quotas = new Map<string, { count: number; expires: number }>();
  redis.eval = jest.fn(async (_script: string, keyCount: number, quota: string, challenge: string,
    limit: string | number, ttl: string | number, value: string) => {
    if (keyCount !== 2) throw new Error('expected two issuance keys');
    const now = Date.now();
    let bucket = quotas.get(quota);
    if (!bucket || bucket.expires <= now) bucket = { count: 0, expires: now + Number(ttl) * 1000 };
    if (bucket.count >= Number(limit)) return [0, Math.max(1, Math.ceil((bucket.expires - now) / 1000))];
    bucket.count += 1;
    quotas.set(quota, bucket);
    await redis.set(challenge, value, 'EX', ttl);
    return [1, Number(ttl)];
  });
  return redis;
}
