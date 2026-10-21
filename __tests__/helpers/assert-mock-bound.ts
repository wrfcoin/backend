/**
 * backend#1017 — prove a module mock is BOUND before trusting what it does not do.
 *
 * ## The problem this exists for
 *
 * `expect(axiosMock.post).not.toHaveBeenCalled()` is the standard way to assert
 * "this code path made no HTTP call". It has a failure mode that is invisible in
 * a green run: if `jest.doMock` does not bind — which #1017 demonstrated happens
 * intermittently on an unchanged tree — the module under test holds the REAL
 * axios, and `axiosMock.post` is a `jest.fn()` wired to nothing. Nothing ever
 * calls it, so the assertion is trivially true.
 *
 * The assertion does not become wrong. It becomes **unable to be wrong**, which
 * is worse, because it keeps reporting success while proving nothing. That is
 * the #967 family: a mock that is not intercepting, with the suite passing for
 * reasons unrelated to what it claims to check.
 *
 * A negative assertion can only carry weight if the mock is known to be bound.
 * This asserts that directly, by identity: re-import the specifier through the
 * same registry the module under test used and check we get the same function
 * objects back. If `doMock` silently failed, the identity differs and the test
 * fails **with a message naming the cause** instead of passing.
 *
 * ## Usage
 *
 *   const axiosMock = { post: jest.fn() };
 *   jest.doMock('axios', () => ({ default: axiosMock, ...axiosMock }));
 *   const { thing } = await import('../server/…');
 *
 *   await assertAxiosMockBound(axiosMock);          // <- before the negative
 *   expect(axiosMock.post).not.toHaveBeenCalled();
 *
 * ## What this does NOT prove
 *
 *   - **Not that the module under test uses this import.** It proves the mock is
 *     installed in the registry, not that the subject resolved `axios` to it (a
 *     subject importing `axios/dist/node/axios.cjs` directly would still escape).
 *     It closes the observed #1017 failure, not every conceivable one.
 *   - **Nothing about positive assertions.** A test that asserts a call *did*
 *     happen already fails when the mock is unbound — `toHaveBeenCalledTimes(1)`
 *     receiving 0 is exactly how #1017 was found. This helper is only needed
 *     where the assertion is a negative or absent.
 */

/**
 * Fails if the `axios` mock is not the one the registry currently serves.
 *
 * @param mock the object passed to `jest.doMock('axios', …)`; every
 *   function-valued key on it is checked by identity.
 */
export async function assertAxiosMockBound(
  mock: Record<string, unknown>,
): Promise<void> {
  const resolved = (await import('axios')) as unknown as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };

  const members = Object.keys(mock).filter((k) => typeof mock[k] === 'function');
  if (members.length === 0) {
    throw new Error(
      'assertAxiosMockBound: the supplied mock has no function members, so ' +
        'binding cannot be established. Pass the object given to jest.doMock.',
    );
  }

  for (const member of members) {
    const actual = resolved?.default?.[member] ?? resolved?.[member];
    if (actual === mock[member]) continue;

    // Distinguish the two ways this can differ, because they mean different
    // things and the message is the only diagnosis a CI log will carry:
    //   - a plain function  -> the real axios; the doMock genuinely did not bind
    //   - another jest mock -> a DIFFERENT mock won, e.g. a hoisted jest.mock()
    //     from another suite leaking through the worker (the `isolation-victim`
    //     class already documented in quarantine.cjs)
    // If it is neither, say so rather than asserting a cause.
    const isJestMock =
      typeof actual === 'function' && Boolean((actual as { _isMockFunction?: boolean })._isMockFunction);
    const what =
      actual === undefined
        ? "nothing (the resolved module has no such member)"
        : isJestMock
          ? 'a DIFFERENT jest mock — some other mock won this registry slot'
          : typeof actual === 'function'
            ? 'the REAL axios function — this doMock did not bind'
            : `a ${typeof actual}`;

    throw new Error(
      `axios mock is NOT bound: re-importing 'axios' returned ${what} for ` +
        `'${member}', not the function passed to jest.doMock. Any negative ` +
        `assertion (expect(mock.${member}).not.toHaveBeenCalled()) is vacuous ` +
        `in this state and would report a false green — see backend#1017.`,
    );
  }
}
