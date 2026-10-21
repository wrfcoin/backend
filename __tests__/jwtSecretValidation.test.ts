import {
  validateJwtSecret,
  WEAK_PREFIXES,
  MIN_SECRET_LENGTH,
} from '../server/utils/jwtSecretValidation';

const STRONG_SECRET = 'a'.repeat(MIN_SECRET_LENGTH); // exactly 32 chars, no weak prefix

function makeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'development', ...overrides };
}

function makeLogger() {
  return { warn: jest.fn() };
}

// ─── accept-strong ────────────────────────────────────────────────────────────

describe('validateJwtSecret — strong secret', () => {
  it('accepts a secret of exactly MIN_SECRET_LENGTH with no weak prefix', () => {
    const logger = makeLogger();
    expect(() =>
      validateJwtSecret(logger, makeEnv({ JWT_SECRET: STRONG_SECRET }))
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a secret longer than MIN_SECRET_LENGTH', () => {
    const logger = makeLogger();
    const longSecret = 'x'.repeat(64);
    expect(() =>
      validateJwtSecret(logger, makeEnv({ JWT_SECRET: longSecret }))
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a strong secret in production without throwing', () => {
    const logger = makeLogger();
    expect(() =>
      validateJwtSecret(
        logger,
        makeEnv({ JWT_SECRET: STRONG_SECRET, NODE_ENV: 'production' })
      )
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ─── reject weak prefix variants ─────────────────────────────────────────────

describe('validateJwtSecret — weak prefix rejection (development)', () => {
  const suffix = 'a'.repeat(MIN_SECRET_LENGTH); // ensure length ≥ 32

  for (const prefix of WEAK_PREFIXES) {
    it(`warns in dev when secret starts with "${prefix}"`, () => {
      const logger = makeLogger();
      validateJwtSecret(
        logger,
        makeEnv({ JWT_SECRET: `${prefix}${suffix}` })
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('JWT_SECRET is weak')
      );
    });

    it(`throws in production when secret starts with "${prefix}"`, () => {
      const logger = makeLogger();
      expect(() =>
        validateJwtSecret(
          logger,
          makeEnv({ JWT_SECRET: `${prefix}${suffix}`, NODE_ENV: 'production' })
        )
      ).toThrow(/JWT_SECRET is weak/);
    });
  }
});

describe('validateJwtSecret — weak prefix case-insensitivity', () => {
  it('rejects upper-case variant of weak prefix in dev', () => {
    const logger = makeLogger();
    validateJwtSecret(
      logger,
      makeEnv({ JWT_SECRET: `TEST${'a'.repeat(MIN_SECRET_LENGTH)}` })
    );
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ─── reject too-short ─────────────────────────────────────────────────────────

describe('validateJwtSecret — too-short secret', () => {
  it('warns in dev when secret is shorter than MIN_SECRET_LENGTH', () => {
    const logger = makeLogger();
    const shortSecret = 'z'.repeat(MIN_SECRET_LENGTH - 1);
    validateJwtSecret(logger, makeEnv({ JWT_SECRET: shortSecret }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JWT_SECRET is weak')
    );
  });

  it('throws in production when secret is too short', () => {
    const logger = makeLogger();
    const shortSecret = 'z'.repeat(MIN_SECRET_LENGTH - 1);
    expect(() =>
      validateJwtSecret(
        logger,
        makeEnv({ JWT_SECRET: shortSecret, NODE_ENV: 'production' })
      )
    ).toThrow(/JWT_SECRET is weak/);
  });

  it('warns for a single-char secret in dev', () => {
    const logger = makeLogger();
    validateJwtSecret(logger, makeEnv({ JWT_SECRET: 'x' }));
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ─── reject missing in production ────────────────────────────────────────────

describe('validateJwtSecret — missing JWT_SECRET', () => {
  it('warns in dev when JWT_SECRET is absent', () => {
    const logger = makeLogger();
    validateJwtSecret(logger, makeEnv({ JWT_SECRET: undefined }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JWT_SECRET is not set')
    );
  });

  it('throws in production when JWT_SECRET is absent', () => {
    const logger = makeLogger();
    expect(() =>
      validateJwtSecret(
        logger,
        makeEnv({ JWT_SECRET: undefined, NODE_ENV: 'production' })
      )
    ).toThrow('JWT_SECRET is required in production');
  });

  it('treats empty string as absent and warns in dev', () => {
    // empty string is falsy — same code path as undefined
    const logger = makeLogger();
    validateJwtSecret(logger, makeEnv({ JWT_SECRET: '' }));
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ─── fail-closed in testnet/staging (untrusted-user environments) ────────────

describe('validateJwtSecret — testnet/staging fail-closed', () => {
  for (const env of ['testnet', 'staging']) {
    it(`throws in ${env} when JWT_SECRET is absent`, () => {
      const logger = makeLogger();
      expect(() =>
        validateJwtSecret(
          logger,
          makeEnv({ JWT_SECRET: undefined, NODE_ENV: env })
        )
      ).toThrow(`JWT_SECRET is required in ${env}`);
    });

    it(`throws in ${env} when JWT_SECRET is weak`, () => {
      const logger = makeLogger();
      const weak = `test${'a'.repeat(MIN_SECRET_LENGTH)}`;
      expect(() =>
        validateJwtSecret(logger, makeEnv({ JWT_SECRET: weak, NODE_ENV: env }))
      ).toThrow(/JWT_SECRET is weak/);
    });

    it(`throws in ${env} when JWT_SECRET is too short`, () => {
      const logger = makeLogger();
      const shortSecret = 'z'.repeat(MIN_SECRET_LENGTH - 1);
      expect(() =>
        validateJwtSecret(
          logger,
          makeEnv({ JWT_SECRET: shortSecret, NODE_ENV: env })
        )
      ).toThrow(/JWT_SECRET is weak/);
    });

    it(`accepts a strong secret in ${env}`, () => {
      const logger = makeLogger();
      expect(() =>
        validateJwtSecret(
          logger,
          makeEnv({ JWT_SECRET: STRONG_SECRET, NODE_ENV: env })
        )
      ).not.toThrow();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  }
});
