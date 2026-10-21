import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { SIGNED_TRANSFER_CONTRACT, parseSignedTransfer, transparentTransferMessage } = require('../../server/routes/wallet-transfer-contract');

const FROM = '0x0000000000000000000000000000000000000a11';
const TO = '0x0000000000000000000000000000000000000b22';

describe('signed wallet transfer contract', () => {
  it('accepts camelCase or core4 snake_case authorization fields without changing signed units', () => {
    expect(parseSignedTransfer({
      from: FROM, to: TO, amount: '100000001', nonce: '7',
      authPubkey: 'a'.repeat(64), authSignature: 'b'.repeat(128),
    })).toMatchObject({ ok: true, value: { amount: 100000001, nonce: '7' } });
    expect(parseSignedTransfer({
      from: FROM, to: TO, amount: 1, nonce: 8,
      auth_pubkey: 'a'.repeat(64), auth_signature: 'b'.repeat(128),
    })).toMatchObject({ ok: true, value: { amount: 1, nonce: '8' } });
    expect(parseSignedTransfer({
      from: FROM, to: TO, amount: '1.00000001', nonce: '9',
      auth_pubkey: 'a'.repeat(64), auth_signature: 'b'.repeat(128),
    })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it.each([
    [{ from: FROM, to: TO, amount: 1 }, 'SIGNED_TRANSFER_REQUIRED'],
    [{ from: FROM, to: TO, amount: 1, nonce: '-1', auth_pubkey: 'a'.repeat(64), auth_signature: 'b'.repeat(128) }, 'VALIDATION_ERROR'],
    [{ from: FROM, to: TO, amount: 1, nonce: '7', auth_pubkey: 'aa', auth_signature: 'b'.repeat(128) }, 'VALIDATION_ERROR'],
    [{ from: FROM, to: TO, amount: 1, nonce: '7', auth_pubkey: 'a'.repeat(64), auth_signature: 'bb' }, 'VALIDATION_ERROR'],
  ])('rejects incomplete or malformed signed bodies', (body, code) => {
    expect(parseSignedTransfer(body)).toMatchObject({ ok: false, code });
  });

  it('pins the owner-decided shared ed25519 vector and never asks backend to sign', () => {
    const vector = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contract-fixtures/wallet-key-scheme-vector.json'), 'utf8'));
    expect(vector.scheme).toBe('ed25519');
    expect(vector.public_key_bytes).toHaveLength(32);
    const address = `0x${crypto
      .createHash('sha3-256')
      .update(Buffer.from(vector.public_key_bytes))
      .digest('hex')
      .slice(0, 40)}`;
    expect(vector.address).toBe(address);
    expect(SIGNED_TRANSFER_CONTRACT.fields).toEqual(expect.arrayContaining(['nonce', 'auth_pubkey', 'auth_signature']));
    expect(SIGNED_TRANSFER_CONTRACT.amount).toEqual({
      requestUnit: 'integer base units',
      core4Unit: 'integer base units',
      signedAs: 'u64 little-endian',
    });
    const source = fs.readFileSync(path.join(process.cwd(), 'server/routes/wallet-transfer-contract.js'), 'utf8');
    expect(source).not.toMatch(/private[_ -]?key|\.sign\s*\(/i);
  });

  it('rebuilds the byte-identical core4 authorization vector', () => {
    const fixturePath = path.join(process.cwd(), 'contract-fixtures/transparent-transfer-auth-vector.json');
    const bytes = fs.readFileSync(fixturePath);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
      'ebbc584576df327dcc3cdf7433b563f59c60471db2266847d3eaefb29b341886',
    );
    const vector = JSON.parse(bytes.toString('utf8'));
    expect(vector.amount_unit).toBe('integer base units');
    const c = vector.case;
    expect(transparentTransferMessage({
      chainId: c.chain_id,
      networkId: c.network_id,
      from: c.from,
      to: c.to,
      amount: c.amount,
      nonce: c.nonce,
    }).toString('hex')).toBe(c.preimage_hex);
  });
});
