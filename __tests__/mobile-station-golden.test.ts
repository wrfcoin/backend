/**
 * backend#1288: cross-language golden vectors for per-phone station registration.
 *
 * Preimage B and its signature were produced by core4's own
 * `station_ownership_message_with_domain` (shared-protocol/src/blockchain/transaction.rs,
 * core4 cfc0cee2b) and `PrivateKey::sign`, from the fixed seed [7u8; 32], chain
 * "777" / network "testnet". The backend must reproduce those bytes exactly and
 * the core4 signature must verify over them; the tampered twin must not.
 *
 * Preimage A (v2, B6) and the station id are backend-defined (design §2.1, §3.2); their
 * expected bytes below were assembled independently in Python (struct/hashlib),
 * not with the TypeScript builders, so the mobile side (Dart) can pin the same values.
 */
import { describe, expect, it } from '@jest/globals';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
  MOBILE_STATION_REG_DOMAIN,
  MOBILE_STATION_REG_DOMAIN_V1,
} from '../shared/mobile-station-messages';
import { verifyEd25519SignatureBytes } from '../server/routes/wallet-auth-service';
import crypto from 'node:crypto';

const CORE4 = {
  publicKeyHex: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
  ownerAddress: '0x791026e25cc1ba461167ffb5c6dc095c284bd92c',
  stationId: 'mob-0123456789abcdef0123456789abcdef',
  ownershipMessageHex:
    '777266636f696e5f73746174696f6e5f6f776e6572736869705f76310300000037373707000000746573746e6574240000006d6f622d30313233343536373839616263646566303132333435363738396162636465662a000000307837393130323665323563633162613436313136376666623563366463303935633238346264393263',
  ownershipSignatureHex:
    '4983b317ac64e109c15426fa4378452bd0053838a27e12608a4c1242280fd9c0b5fe97437f65bce97b8e24876ea81da33e8b9eae5f8ab173bbd8ebd597e4210a',
};

describe('preimage B == core4 station_ownership_message (golden)', () => {
  it('reproduces core4 byte-for-byte', () => {
    const message = buildStationOwnershipMessage({
      chainId: '777',
      networkId: 'testnet',
      stationId: CORE4.stationId,
      ownerAddress: CORE4.ownerAddress,
    });
    expect(message.toString('hex')).toBe(CORE4.ownershipMessageHex);
  });

  it("core4's signature verifies over our bytes and the owner key derives to the owner address", () => {
    const message = buildStationOwnershipMessage({
      chainId: '777', networkId: 'testnet', stationId: CORE4.stationId, ownerAddress: CORE4.ownerAddress,
    });
    expect(verifyEd25519SignatureBytes(CORE4.publicKeyHex, CORE4.ownershipSignatureHex, message)).toBe(true);
    const derived = `0x${crypto.createHash('sha3-256').update(Buffer.from(CORE4.publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`;
    expect(derived).toBe(CORE4.ownerAddress);
  });

  it.each([
    ['station id', { stationId: 'mob-0123456789abcdef0123456789abcdee' }],
    ['owner', { ownerAddress: '0x791026e25cc1ba461167ffb5c6dc095c284bd92d' }],
    ['chain id', { chainId: '778' }],
    ['network id', { networkId: 'mainnet' }],
  ])('a tampered %s changes the bytes and fails the core4 signature', (_name, change) => {
    const message = buildStationOwnershipMessage({
      chainId: '777', networkId: 'testnet', stationId: CORE4.stationId, ownerAddress: CORE4.ownerAddress,
      ...change,
    });
    expect(message.toString('hex')).not.toBe(CORE4.ownershipMessageHex);
    expect(verifyEd25519SignatureBytes(CORE4.publicKeyHex, CORE4.ownershipSignatureHex, message)).toBe(false);
  });
});

describe('preimage A v2 (backend registration proof, with collect key) golden', () => {
  // Assembled independently in Python 3 (struct.pack '<I' / '<i' / '<Q' + str.encode), NOT with the
  // TypeScript builder. The same script, with the v1 layout, reproduced the retired v1 vector below
  // byte for byte, which validates the harness. The collect key is the synthetic bytes 0x01..0x20.
  const COLLECT_PUBKEY = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const EXPECTED_A_V2 =
    '777266636f696e5f6d6f62696c655f73746174696f6e5f7265675f76320300000037373707000000746573746e6574240000006d6f622d30313233343536373839616263646566303132333435363738396162636465662a00000030783739313032366532356363316261343631313637666662356336646330393563323834626439326340000000303130323033303430353036303730383039306130623063306430653066313031313132313331343135313631373138313931613162316331643165316632307b00000038feffff170000006e6f6e63652d676f6c64656e2d30303030303030303031ac3cb16a00000000';
  const RETIRED_A_V1 =
    '777266636f696e5f6d6f62696c655f73746174696f6e5f7265675f76310300000037373707000000746573746e6574240000006d6f622d30313233343536373839616263646566303132333435363738396162636465662a0000003078373931303236653235636331626134363131363766666235633664633039356332383462643932637b00000038feffff170000006e6f6e63652d676f6c64656e2d30303030303030303031ac3cb16a00000000';
  const input = {
    chainId: '777',
    networkId: 'testnet',
    stationId: CORE4.stationId,
    ownerAddress: CORE4.ownerAddress,
    collectPubkey: COLLECT_PUBKEY,
    latE1: 123,
    lonE1: -456,
    nonce: 'nonce-golden-0000000001',
    expiresAt: 1790000300,
  };

  it('matches the independently assembled bytes (negative longitude included)', () => {
    expect(buildMobileStationRegistrationMessage(input).toString('hex')).toBe(EXPECTED_A_V2);
  });

  it('is exactly the v1 layout with the domain tag bumped and lv(collect_pubkey) inserted after owner', () => {
    const v1Tag = Buffer.from('wrfcoin_mobile_station_reg_v1').toString('hex');
    const v2Tag = Buffer.from('wrfcoin_mobile_station_reg_v2').toString('hex');
    const collectLv = '40000000' + Buffer.from(COLLECT_PUBKEY).toString('hex');
    const ownerEnd = RETIRED_A_V1.indexOf('7b000000'); // i32le(123) starts the tail
    const v1Head = RETIRED_A_V1.slice(v1Tag.length, ownerEnd);
    const v1Tail = RETIRED_A_V1.slice(ownerEnd);
    expect(EXPECTED_A_V2).toBe(v2Tag + v1Head + collectLv + v1Tail);
  });

  it('a v1-layout message can never be mistaken for v2: the first bytes (domain tag) differ', () => {
    expect(EXPECTED_A_V2.slice(0, 60)).not.toBe(RETIRED_A_V1.slice(0, 60));
    expect(MOBILE_STATION_REG_DOMAIN).toBe('wrfcoin_mobile_station_reg_v2');
    expect(MOBILE_STATION_REG_DOMAIN_V1).toBe('wrfcoin_mobile_station_reg_v1');
    expect(buildMobileStationRegistrationMessage(input).toString('hex')).not.toBe(RETIRED_A_V1);
  });

  it('binds the collect key: any change to it changes the bytes; case is folded; a bad key throws', () => {
    const other = COLLECT_PUBKEY.replace(/^01/, '02');
    expect(buildMobileStationRegistrationMessage({ ...input, collectPubkey: other }).toString('hex')).not.toBe(EXPECTED_A_V2);
    expect(
      buildMobileStationRegistrationMessage({ ...input, collectPubkey: COLLECT_PUBKEY.toUpperCase() }).toString('hex')
    ).toBe(EXPECTED_A_V2);
    expect(() => buildMobileStationRegistrationMessage({ ...input, collectPubkey: 'ab' })).toThrow();
    expect(() => buildMobileStationRegistrationMessage({ ...input, collectPubkey: 'zz'.repeat(32) })).toThrow();
  });

  it('is domain-separated from preimage B and from commit authorization', () => {
    expect(EXPECTED_A_V2.startsWith(Buffer.from('wrfcoin_mobile_station_reg_v2').toString('hex'))).toBe(true);
    expect(CORE4.ownershipMessageHex.startsWith(Buffer.from('wrfcoin_station_ownership_v1').toString('hex'))).toBe(true);
    expect(EXPECTED_A_V2).not.toContain(Buffer.from('wrfcoin_commit_auth_v2').toString('hex'));
  });
});

describe('station id golden', () => {
  it('matches the independently derived value', () => {
    expect(deriveMobileStationId(CORE4.ownerAddress)).toBe('mob-7fe8d26b9fe9c060ea559732d5a6033e');
  });
});
