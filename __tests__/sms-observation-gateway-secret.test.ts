import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// #755: the SMS observation gateway verifies inbound envelopes by HMAC
// signature, so it must NOT fall back to a public dev secret outside
// development. These tests cover the fail-closed secret resolution.
describe('SmsObservationGatewayService secret resolution (#755)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let SmsObservationGatewayService: any;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.SMS_OBSERVATION_GATEWAY_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function load() {
    ({ SmsObservationGatewayService } = require('../server/services/sms-observation-gateway-service'));
  }

  it('throws when no secret is set outside development (testnet)', () => {
    process.env.NODE_ENV = 'testnet';
    load();
    expect(() => new SmsObservationGatewayService()).toThrow(
      /SMS_OBSERVATION_GATEWAY_SECRET is required/
    );
  });

  it('throws when no secret is set and NODE_ENV is unset', () => {
    load();
    expect(() => new SmsObservationGatewayService()).toThrow(
      /SMS_OBSERVATION_GATEWAY_SECRET is required/
    );
  });

  it('throws when the public dev fallback value is used outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_OBSERVATION_GATEWAY_SECRET =
      'dev-sms-observation-gateway-secret';
    load();
    expect(() => new SmsObservationGatewayService()).toThrow(
      /public dev fallback/
    );
  });

  it('throws when the secret is too weak outside development', () => {
    process.env.NODE_ENV = 'testnet';
    process.env.SMS_OBSERVATION_GATEWAY_SECRET = 'short';
    load();
    expect(() => new SmsObservationGatewayService()).toThrow(/too weak/);
  });

  it('accepts a strong secret outside development', () => {
    process.env.NODE_ENV = 'testnet';
    process.env.SMS_OBSERVATION_GATEWAY_SECRET = 'a'.repeat(64);
    load();
    expect(() => new SmsObservationGatewayService()).not.toThrow();
  });

  it('allows the dev fallback only in development when no secret is set', () => {
    process.env.NODE_ENV = 'development';
    load();
    expect(() => new SmsObservationGatewayService()).not.toThrow();
  });

  it('still honours an explicit secret option in development', () => {
    process.env.NODE_ENV = 'development';
    load();
    expect(
      () =>
        new SmsObservationGatewayService({ sharedSecret: 'b'.repeat(40) })
    ).not.toThrow();
  });

  it('allows a deliberate explicit secret outside development (caller-owned)', () => {
    process.env.NODE_ENV = 'testnet';
    load();
    expect(
      () => new SmsObservationGatewayService({ sharedSecret: 'test-secret' })
    ).not.toThrow();
  });

  it('rejects the public dev-fallback even when passed explicitly outside development', () => {
    process.env.NODE_ENV = 'production';
    load();
    expect(
      () =>
        new SmsObservationGatewayService({
          sharedSecret: 'dev-sms-observation-gateway-secret',
        })
    ).toThrow(/public dev fallback/);
  });
});
