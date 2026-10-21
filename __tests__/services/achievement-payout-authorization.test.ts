import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  payoutPreimage,
  verifyPayoutAuthorization,
  authorizeNewPayout,
  signedPayoutEnabled,
  canonicalRecipient,
} from '../../server/services/achievement-payout-authorization.js';
import { submitPayout } from '../../server/services/reward-payout-client.js';
const keys = generateKeyPairSync('ed25519');
const tuple = {
  achievementId: 'award',
  claimId: 'ach:v1:1:award',
  address: '0x' + 'ab'.repeat(20),
  amountBaseUnits: 1_000_000_000n,
};
const auth = { chainId: '777', nonce: '01'.repeat(32), signature: '' };
auth.signature = sign(null, payoutPreimage(tuple, auth), keys.privateKey).toString('hex');
const config = {
  ACHIEVEMENT_PAYOUT_PUBLIC_KEY: keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex'),
  ACHIEVEMENT_PAYOUT_CHAIN_ID: '777',
};
const saved = Object.fromEntries(
  [...Object.keys(config), 'ACHIEVEMENT_PAYOUT_SIGNED_ENABLED'].map((k) => [k, process.env[k]])
);
beforeEach(() => {
  Object.assign(process.env, config);
  process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'true';
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
it('preimage has exact tagged canonical UTF-8 bytes', () => {
  expect(payoutPreimage(tuple, auth).toString()).toBe(
    JSON.stringify([
      'wrfcoin_achievement_payout_authorization_v1',
      '777',
      'ach:v1:1:award',
      'award',
      'ab'.repeat(20),
      '1000000000',
      '01'.repeat(32),
    ])
  );
});
it.each(['', '.award', ' award', 'award ', 'award\n', 'award\t', 'a/b', 'a"b', 'a\\b', 'a:b', 'é', 'a'.repeat(129)])(
  'refuses achievement ID outside the signed ASCII identifier contract: %j', (achievementId) => {
    expect(() => payoutPreimage({ ...tuple, achievementId }, auth)).toThrow();
  }
);
it.each(['A0_.-award', 'a'.repeat(128)])('accepts bounded ASCII achievement ID %j', (achievementId) => {
  expect(() => payoutPreimage({ ...tuple, achievementId }, auth)).not.toThrow();
});
it('matches the independent Python JSON/OpenSSL Ed25519 public test vector', () => {
  const vector = JSON.parse(readFileSync('__tests__/fixtures/achievement-payout-v1.json', 'utf8'));
  const bytes = payoutPreimage({ ...vector.tuple, amountBaseUnits: BigInt(vector.tuple.amountBaseUnits) }, vector.authorization);
  expect(bytes.toString('utf8')).toBe(vector.preimageUtf8);
  expect(bytes.toString('hex')).toBe(vector.preimageHex);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.preimageSha256);
  const key = createPublicKey({
    key: Buffer.from('302a300506032b6570032100' + vector.publicKeyHex, 'hex'), format: 'der', type: 'spki',
  });
  expect(verify(null, bytes, key, Buffer.from(vector.authorization.signature, 'hex'))).toBe(true);
  expect(verifyPayoutAuthorization(
    { ...vector.tuple, amountBaseUnits: BigInt(vector.tuple.amountBaseUnits) }, vector.authorization,
    { ACHIEVEMENT_PAYOUT_CHAIN_ID: vector.authorization.chainId, ACHIEVEMENT_PAYOUT_PUBLIC_KEY: vector.publicKeyHex }
  )).toEqual(vector.authorization);
});
it('address case and optional prefix canonicalize identically', () => {
  expect(canonicalRecipient('AB'.repeat(20))).toBe('ab'.repeat(20));
  expect(verifyPayoutAuthorization({ ...tuple, address: 'AB'.repeat(20) }, auth)).toEqual(auth);
});
it.each(['achievementId', 'claimId', 'address', 'amountBaseUnits'])(
  'changed %s invalidates signature',
  (field) => {
    const values = {
      achievementId: 'other',
      claimId: 'other',
      address: '0x' + 'cd'.repeat(20),
      amountBaseUnits: 900_000_000n,
    };
    expect(() => verifyPayoutAuthorization({ ...tuple, [field]: values[field] }, auth)).toThrow();
  }
);
it.each([
  { ...auth, chainId: '778' },
  { ...auth, nonce: '02'.repeat(32) },
  { ...auth, signature: '00'.repeat(64) },
  null,
])('modified or missing proof refuses', (proof) => {
  expect(() => verifyPayoutAuthorization(tuple, proof)).toThrow();
});
it('wrong configured public key refuses', () => {
  const wrong = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  expect(() =>
    verifyPayoutAuthorization(tuple, auth, {
      ...config,
      ACHIEVEMENT_PAYOUT_PUBLIC_KEY: wrong,
    })
  ).toThrow();
});
it('missing configured key or chain refuses', () => {
  expect(() => verifyPayoutAuthorization(tuple, auth, {})).toThrow();
});
it('missing flag is OFF; malformed flags fail closed', () => {
  expect(signedPayoutEnabled({})).toBe(false);
  expect(signedPayoutEnabled({ ACHIEVEMENT_PAYOUT_SIGNED_ENABLED: 'false' })).toBe(false);
  expect(() => signedPayoutEnabled({ ACHIEVEMENT_PAYOUT_SIGNED_ENABLED: '1' })).toThrow();
});
function txFor(totals: any, used: any[] = []) {
  let call = 0;
  const fields: any[] = [];
  return {
    fields,
    select: (f: any) => {
      fields.push(f);
      const nonce = call++ === 0;
      const b: any = {
        from: () => b,
        where: () => b,
        limit: async () => used,
        then: (resolve: any, reject: any) =>
          Promise.resolve(nonce ? used : [totals]).then(resolve, reject),
      };
      return b;
    },
  };
}
const zero = {
  recipientDay: '0',
  recipientLifetime: '0',
  globalDay: '0',
  unknownRecipients: '0',
};
it('caps aggregate canonical recipients across user aliases, not users.id', async () => {
  const tx = txFor(zero);
  await authorizeNewPayout(tx, tuple, auth);
  const query = new PgDialect().sqlToQuery(tx.fields[1].recipientLifetime);
  expect(query.sql).toContain('regexp_replace');
  expect(query.sql).toContain('address');
  expect(query.sql).not.toContain('user_id');
  expect(query.params).toContain('ab'.repeat(20));
});
it('pilot exact daily/lifetime/global boundaries permit a signed reservation', async () => {
  await expect(
    authorizeNewPayout(
      txFor({
        ...zero,
        recipientDay: '15',
        recipientLifetime: '90',
        globalDay: '240',
      }),
      tuple,
      auth
    )
  ).resolves.toEqual(auth);
});
it.each(['recipientDay', 'recipientLifetime', 'globalDay'])(
  'invalid %s aggregate fails closed',
  async (key) => {
    await expect(
      authorizeNewPayout(txFor({ ...zero, [key]: 'broken' }), tuple, auth)
    ).rejects.toThrow();
  }
);
it('persistent nonce query refusal is independent of caps', async () => {
  await expect(authorizeNewPayout(txFor(zero, [{ id: 1 }]), tuple, auth)).rejects.toThrow();
});
it('enabled production outbound client refuses without proof before token or network use', async () => {
  const fetchJson = jest.fn();
  const getOperatorToken = jest.fn();
  const result = await submitPayout(tuple, { fetchJson, getOperatorToken });
  expect(result).toMatchObject({
    kind: 'error',
    code: 'PAYOUT_AUTHORIZATION_REQUIRED',
  });
  expect(fetchJson).not.toHaveBeenCalled();
  expect(getOperatorToken).not.toHaveBeenCalled();
});
it('production outbound client verifies proof and preserves node API request shape', async () => {
  const fetchJson = jest.fn(async () => ({
    ok: true,
    status: 202,
    payload: { ok: true, data: { status: 'accepted' } },
  })) as any;
  await expect(
    submitPayout(
      { ...tuple, authorization: auth },
      { fetchJson, getOperatorToken: () => 'synthetic' }
    )
  ).resolves.toMatchObject({ kind: 'success' });
  expect(fetchJson).toHaveBeenCalledWith(
    '/rewards/payout',
    expect.objectContaining({
      body: {
        address: tuple.address,
        amount_base_units: 1000000000,
        claim_id: tuple.claimId,
      },
    })
  );
});
