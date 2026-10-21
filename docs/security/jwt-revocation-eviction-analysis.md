# JWT Revocation Eviction Analysis

**Issue:** backend #1203  
**Date:** 2026-04-11  
**Owner:** Frank — Security Hardening

## Summary

The backend JWT path is no longer trusting Redis revocation entries when the
Redis eviction policy allows silent eviction. In the current implementation,
`server/middleware/auth.ts` checks `maxmemory-policy` on Redis startup and only
persists revocations when the policy is `noeviction`.

That means:

- `allkeys-lru` or any other evicting policy disables Redis-backed JWT
  revocation persistence.
- Revoked tokens remain blocked only by the in-process in-memory revocation
  cache and by session invalidation.
- After a restart, or on another backend instance, there is no durable JWT
  revocation record to consult unless Redis is running with `noeviction`.

## What Happens Under `allkeys-lru` + `maxmemory 512mb`

The current auth flow is:

1. JWT signature verification.
2. Revocation check in memory.
3. Revocation check in Redis, but only if the Redis policy is safe.
4. Session lookup via `RedisSessionService`.

When Redis reports an evicting policy:

- `revokeToken()` stores the revocation only in the local `Set`.
- Redis `setex()` calls for revocation keys are skipped.
- `authenticateJWT()` will still reject the token in the same process lifetime
  because the in-memory cache and session invalidation still apply.

The dangerous case is process or node turnover:

- The in-memory revocation cache is lost on restart.
- If another instance has not seen the revocation, it has no durable revocation
  entry to consult.
- There is no DB-backed revocation list in this backend.

So the revocation guarantee is **process-local unless Redis is configured with
`noeviction`**.

## Can a Revoked Token Become Valid Again?

Yes, but only in the durability sense, not as an immediate same-process replay.

The revocation can reappear as valid if:

- the token was revoked while Redis was in an evicting mode,
- the local process restarts or another instance handles the request,
- and there is no durable revocation record to consult.

The session invalidation step reduces the risk further, but it is not a durable
substitute for a real revocation store. The backend currently has no fallback
DB-backed revocation list.

## Current Safety Posture

Current posture is:

- Safe when Redis policy is `noeviction`.
- Unsafe for durable revocation guarantees when Redis policy allows eviction.

This is the right fail-closed posture for testnet:

- Alice must keep the Redis compose/config side on `noeviction`.
- Backend should continue to refuse Redis-backed revocation persistence when the
  policy is unsafe.
- If testnet ever needs to tolerate an evicting Redis policy, the backend will
  need a durable fallback store for revocation state.

## Regression Coverage

Existing regression coverage in
`__tests__/auth-revocation-redis.test.ts` already covers:

- durable persistence when policy is `noeviction`,
- in-memory-only fallback when policy is evicting,
- in-memory-only fallback when Redis is unavailable.

That coverage is enough to lock in the current fail-closed behavior.

## Conclusion

The blocker is not that Redis revocation keys are being silently trusted under
`allkeys-lru`. The blocker is that an evicting Redis policy makes JWT revocation
non-durable across process restarts and multi-instance deploys.

For testnet, the backend must only rely on Redis-backed revocation when the
cluster is configured with `maxmemory-policy noeviction`.
