import { createHash } from 'node:crypto';
import {
  assertOraclePrincipalOwnsOracle,
  assertVerifiedMinedApprovalBinding,
  assertVerifiedOraclePrincipal,
  buildOracleWork,
  canClaimLease,
  evaluateRevealEligibility,
  isIdempotentResult,
  OracleWorkBroker,
  type OracleResultInput,
  type OracleWorkClaimResult,
  type OracleWorkRecord,
  type OracleWorkQueryExecutor,
  type VerifiedMinedApproval,
  type VerifiedOraclePrincipal,
} from '../server/services/oracle-work-broker.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const REAL_RESULT_DIGEST = createHash('sha256')
  .update('{"approved":true,"attestationTimestamp":101,"confidence":1,"resultCode":null,"signature":"public-signature"}')
  .digest('hex');

function principal(oracleId: 'workstation' | 'n5pro', scopes = [
  'wrfcoin.oracle-work.read',
  'wrfcoin.oracle-work.claim',
  'wrfcoin.oracle-work.result',
]): VerifiedOraclePrincipal {
  return { verified: true, oracleId, audience: 'wrfcoin.oracle-work', scopes };
}

function work(overrides: Partial<OracleWorkRecord> = {}): OracleWorkRecord {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return {
    ...buildOracleWork({
      workId: 'work:1',
      cycleId: 'cycle:1',
      stationId: 'station-1',
      observationId: 'observation-1',
      canonicalReading: { humidity_percent: 50, temperature_c: 10 },
      ownerAddress: '0xowner',
      chainId: 'wrfcoin',
      networkId: 'testnet',
      genesisHash: 'genesis-a',
      commitId: 'commit-1',
      commitHash: 'hash-1',
      nonce: 'nonce-1',
      commitTimestamp: nowSeconds - 100,
      revealDeadline: nowSeconds + 100,
      requiredQuorum: 2,
      evidenceTimestamp: NOW.toISOString(),
    }),
    ...overrides,
  };
}

function result(
  oracleId: 'workstation' | 'n5pro',
  state: OracleWorkClaimResult['state'],
  overrides: Partial<OracleWorkClaimResult> = {},
): OracleWorkClaimResult {
  return {
    workId: 'work:1',
    genesisHash: 'genesis-a',
    oracleId,
    attestationVersion: 1,
    state,
    leaseVersion: 1,
    leaseExpiresAt: null,
    approved: state !== 'REJECTED' ? true : false,
    confidence: 1,
    signature: state === 'SIGNED' || state === 'MINED' ? 'public-signature' : null,
    attestationTimestamp: 101,
    resultCode: null,
    core4TxId: state === 'MINED' ? `tx-${oracleId}` : null,
    core4MinedAt: state === 'MINED' ? NOW.toISOString() : null,
    idempotencyKey: 'idem-1',
    resultDigest: REAL_RESULT_DIGEST,
    ...overrides,
  };
}

function workRow(overrides: Partial<OracleWorkRecord> = {}): Record<string, unknown> {
  const current = work(overrides);
  return {
    schema_version: current.schemaVersion,
    work_id: current.workId,
    cycle_id: current.cycleId,
    station_id: current.stationId,
    observation_id: current.observationId,
    observation_digest: current.observationDigest,
    canonical_reading: current.canonicalReading,
    owner_address: current.ownerAddress,
    chain_id: current.chainId,
    network_id: current.networkId,
    genesis_hash: current.genesisHash,
    commit_id: current.commitId,
    commit_hash: current.commitHash,
    nonce: current.nonce,
    commit_timestamp: current.commitTimestamp,
    reveal_deadline: current.revealDeadline,
    required_quorum: current.requiredQuorum,
    evidence_timestamp: current.evidenceTimestamp,
  };
}

function aggregateRow(oracleId: 'workstation' | 'n5pro', state: OracleWorkClaimResult['state'] = 'MINED'): Record<string, unknown> {
  return {
    work_id: 'work:1',
    genesis_hash: 'genesis-a',
    oracle_id: oracleId,
    state,
    approved: true,
  };
}

function minedApproval(overrides: Partial<VerifiedMinedApproval> = {}): VerifiedMinedApproval {
  const base: VerifiedMinedApproval = {
    verified: true,
    workId: 'work:1',
    genesisHash: 'genesis-a',
    oracleId: 'workstation',
    attestationVersion: 1,
    commitId: 'commit-1',
    commitHash: 'hash-1',
    core4TxId: 'tx-workstation',
    minedAt: NOW.toISOString(),
    receipt: {
      verified: true,
      status: 'MINED',
      genesisHash: 'genesis-a',
      commitId: 'commit-1',
      commitHash: 'hash-1',
      core4TxId: 'tx-workstation',
      minedAt: NOW.toISOString(),
    },
  };
  return {
    ...base,
    ...overrides,
    receipt: { ...base.receipt, ...(overrides.receipt ?? {}) },
  };
}

test('requires a verified principal, exact audience, and scope', () => {
  expect(() => assertVerifiedOraclePrincipal(null, 'wrfcoin.oracle-work.read')).toThrow('verified oracle principal');
  expect(() => assertVerifiedOraclePrincipal({ verified: true, oracleId: 'workstation' }, 'wrfcoin.oracle-work.read')).toThrow();
  expect(assertVerifiedOraclePrincipal(principal('workstation'), 'wrfcoin.oracle-work.read').oracleId).toBe('workstation');
});

test('isolates per-oracle result ownership', () => {
  expect(() => assertOraclePrincipalOwnsOracle(principal('workstation'), 'n5pro')).toThrow('another principal');
  expect(() => assertOraclePrincipalOwnsOracle(principal('n5pro'), 'n5pro')).not.toThrow();
});

test('rejects secret-bearing canonical work and preserves no secret fields', () => {
  expect(() => buildOracleWork({
    workId: 'work:secret',
    cycleId: 'cycle:1',
    stationId: 'station-1',
    observationId: 'observation-1',
    canonicalReading: { temperature_c: 10, private_key: 'never' },
    ownerAddress: '0xowner',
    chainId: 'wrfcoin',
    networkId: 'testnet',
    genesisHash: 'genesis-a',
    commitId: 'commit-1',
    commitHash: 'hash-1',
    nonce: 'nonce-1',
    commitTimestamp: 100,
    revealDeadline: 200,
    requiredQuorum: 2,
    evidenceTimestamp: NOW.toISOString(),
  })).toThrow('forbidden secret field');
  const safe = work();
  expect(JSON.stringify(safe)).not.toMatch(/token|private_key|secret|password/i);
});

test('rejects current-genesis mismatch before counting mined approvals', () => {
  const eligibility = evaluateRevealEligibility(work(), [result('workstation', 'MINED'), result('n5pro', 'MINED')], NOW, 'genesis-old');
  expect(eligibility).toMatchObject({ eligible: false, reason: 'CURRENT_GENESIS_MISMATCH', minedApprovals: 0 });
});

test.each([
  ['zero approvals', [], 'WAITING_FOR_MINED_QUORUM'],
  ['one mined approval', [result('workstation', 'MINED')], 'WAITING_FOR_MINED_QUORUM'],
] as const)('%s cannot make reveal eligible', (_label, results, reason) => {
  expect(evaluateRevealEligibility(work(), results, NOW)).toMatchObject({ eligible: false, reason, minedApprovals: results.length });
});

test('two separately keyed mined approvals make reveal eligible', () => {
  expect(evaluateRevealEligibility(work(), [result('workstation', 'MINED'), result('n5pro', 'MINED')], NOW)).toMatchObject({
    eligible: true,
    reason: 'ELIGIBLE',
    minedApprovals: 2,
  });
});

test('off-chain signatures do not count toward reveal quorum', () => {
  expect(evaluateRevealEligibility(work(), [result('workstation', 'SIGNED'), result('n5pro', 'SIGNED')], NOW)).toMatchObject({ eligible: false, minedApprovals: 0 });
});

test('missed deadline remains ineligible even with insufficient mined approvals', () => {
  expect(evaluateRevealEligibility(work(), [result('workstation', 'MINED')], new Date('2026-08-02T12:01:41.000Z'))).toMatchObject({ eligible: false, reason: 'MISSED_QUORUM' });
});

test('expired claims cannot be reused until a new lease is acquired', () => {
  expect(canClaimLease({ state: 'CLAIMED', leaseExpiresAt: new Date(NOW.getTime() + 1000).toISOString() }, NOW)).toBe(false);
  expect(canClaimLease({ state: 'CLAIMED', leaseExpiresAt: new Date(NOW.getTime() - 1000).toISOString() }, NOW)).toBe(true);
  expect(canClaimLease({ state: 'MINED', leaseExpiresAt: null }, NOW)).toBe(false);
});

test('same idempotency key and result fingerprint are safe retries', () => {
  const input: OracleResultInput = {
    workId: 'work:1',
    attestationVersion: 1,
    leaseVersion: 1,
    leaseToken: 'opaque-lease',
    idempotencyKey: 'idem-1',
    approved: true,
    confidence: 1,
    signature: 'public-signature',
    attestationTimestamp: 101,
  };
  expect(isIdempotentResult(result('workstation', 'SIGNED'), input)).toBe(true);
  expect(isIdempotentResult(result('workstation', 'SIGNED', { resultDigest: 'different' }), input)).toBe(false);
});

test('recordResult returns idempotent success when a retry races a durable mined result', async () => {
  const claimed = result('workstation', 'CLAIMED', { leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString() });
  const mined = {
    work_id: 'work:1', genesis_hash: 'genesis-a', oracle_id: 'workstation', attestation_version: 1,
    state: 'MINED', lease_version: 1, approved: true, confidence: 1, signature: 'public-signature',
    attestation_timestamp: 101, idempotency_key: 'idem-1', result_digest: REAL_RESULT_DIGEST,
    core4_tx_id: 'tx-workstation', core4_mined_at: NOW.toISOString(),
  };
  let reads = 0;
  const orderedExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => {
    if (sql.includes('SELECT')) return { rows: [reads++ === 0 ? claimed : mined] };
    return { rows: [] };
  });
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => callback({ execute: orderedExecute }));
  const execute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const broker = new OracleWorkBroker({ execute, transaction }, () => NOW);

  await expect(broker.recordResult(principal('workstation'), {
    workId: 'work:1', attestationVersion: 1, leaseVersion: 1, leaseToken: 'opaque-lease',
    idempotencyKey: 'idem-1', approved: true, confidence: 1, signature: 'public-signature', attestationTimestamp: 101,
  })).resolves.toMatchObject({ idempotent: true, claim: { state: 'MINED' } });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
});

test('recordResult rejects a wrong lease token', async () => {
  const claimed = result('workstation', 'CLAIMED', { leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString() });
  const execute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => sql.includes('UPDATE') ? ({ rows: [] }) : ({ rows: [claimed] }));
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => callback({ execute }));
  const broker = new OracleWorkBroker({ execute: jest.fn(), transaction }, () => NOW);
  await expect(broker.recordResult(principal('workstation'), {
    workId: 'work:1', attestationVersion: 1, leaseVersion: 1, leaseToken: 'wrong-token', idempotencyKey: 'idem-2', approved: true,
  })).rejects.toMatchObject({ code: 'LEASE_STALE', status: 409 });
});

test('claimWork rejects a double claim during a live lease', async () => {
  const execute: OracleWorkQueryExecutor['execute'] = jest.fn(async () => ({ rows: [] }));
  const broker = new OracleWorkBroker({ execute }, () => NOW);
  await expect(broker.claimWork(principal('workstation'), 'work:1')).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE', status: 409 });
});

test('createWork rejects a duplicate work ID bound to another cycle', async () => {
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async () => ({ rows: [] }));
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => callback({ execute: transactionExecute }));
  const broker = new OracleWorkBroker({ execute: jest.fn(), transaction }, () => NOW);
  await expect(broker.createWork(work({ cycleId: 'cycle:other' }))).rejects.toMatchObject({ code: 'CYCLE_NOT_READY', status: 409 });
});

test('requires the mined receipt to bind the stored work commit', () => {
  expect(() => assertVerifiedMinedApprovalBinding(work(), minedApproval())).not.toThrow();
  expect(() => assertVerifiedMinedApprovalBinding(work(), minedApproval({ commitId: 'other-commit' }))).toThrow('does not bind');
  expect(() => assertVerifiedMinedApprovalBinding(work(), minedApproval({ receipt: { ...minedApproval().receipt, commitHash: 'other-hash' } }))).toThrow('does not bind');
});

test('creates reward work only inside the injected transaction boundary', async () => {
  const outerExecute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => ({
    rows: sql.includes('UPDATE station_reward_cycles') ? [{ cycle_id: 'cycle:1' }] : [],
  }));
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => callback({ execute: transactionExecute }));
  const broker = new OracleWorkBroker({ execute: outerExecute, transaction });

  await broker.createWork(work());

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(outerExecute).not.toHaveBeenCalled();
  expect(transactionExecute).toHaveBeenCalledTimes(4);
});

function reconciliationBroker(
  execute: OracleWorkQueryExecutor['execute'],
  transactionExecute: OracleWorkQueryExecutor['execute'],
) {
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => callback({ execute: transactionExecute }));
  return { broker: new OracleWorkBroker({ execute, transaction }, () => NOW), transaction };
}

test('rolls back mined readback and aggregate writes together when a later write fails', async () => {
  const outerExecute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => {
    if (sql.includes('SELECT * FROM oracle_work_items')) return { rows: [workRow()] };
    if (sql.includes('UPDATE oracle_work_claim_results')) return { rows: [{}] };
    if (sql.includes('SELECT work_id, genesis_hash, oracle_id')) return { rows: [aggregateRow('workstation'), aggregateRow('n5pro')] };
    if (sql.includes('UPDATE oracle_work_items')) throw new Error('aggregate write failed');
    return { rows: [] };
  });
  let rolledBack = false;
  const transaction = jest.fn(async <T>(callback: (executor: OracleWorkQueryExecutor) => Promise<T>) => {
    try {
      return await callback({ execute: transactionExecute });
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  });
  const broker = new OracleWorkBroker({ execute: outerExecute, transaction }, () => NOW);

  await expect(broker.reconcileMinedApproval(minedApproval())).rejects.toThrow('aggregate write failed');
  expect(rolledBack).toBe(true);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(outerExecute).not.toHaveBeenCalled();
  expect(transactionExecute).toHaveBeenCalled();
});

test('duplicate mined readback recomputes the durable quorum instead of claiming it', async () => {
  const outerExecute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => {
    if (sql.includes('SELECT * FROM oracle_work_items')) return { rows: [workRow()] };
    if (sql.includes('UPDATE oracle_work_claim_results')) return { rows: [] };
    if (sql.includes('SELECT * FROM oracle_work_claim_results')) return { rows: [{ state: 'MINED', core4_tx_id: 'tx-workstation' }] };
    if (sql.includes('SELECT work_id, genesis_hash, oracle_id')) return { rows: [aggregateRow('workstation')] };
    return { rows: [] };
  });
  const { broker, transaction } = reconciliationBroker(outerExecute, transactionExecute);

  const response = await broker.reconcileMinedApproval(minedApproval());

  expect(response).toMatchObject({ mined: true, quorumMined: false, reveal: { eligible: false, minedApprovals: 1, requiredQuorum: 2 } });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(outerExecute).not.toHaveBeenCalled();
});

test('reconcileMinedApproval rejects divergent mined readback', async () => {
  const outerExecute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => {
    if (sql.includes('SELECT * FROM oracle_work_items')) return { rows: [workRow()] };
    if (sql.includes('UPDATE oracle_work_claim_results')) return { rows: [] };
    if (sql.includes('SELECT * FROM oracle_work_claim_results')) return { rows: [{ state: 'MINED', core4_tx_id: 'other-tx' }] };
    return { rows: [] };
  });
  const { broker } = reconciliationBroker(outerExecute, transactionExecute);
  await expect(broker.reconcileMinedApproval(minedApproval())).rejects.toMatchObject({ code: 'MINED_READBACK_NOT_READY', status: 409 });
});

test('reports the real two-oracle quorum and transitions aggregate state atomically', async () => {
  const outerExecute = jest.fn<ReturnType<OracleWorkQueryExecutor['execute']>, Parameters<OracleWorkQueryExecutor['execute']>>();
  const transactionExecute: OracleWorkQueryExecutor['execute'] = jest.fn(async (sql) => {
    if (sql.includes('SELECT * FROM oracle_work_items')) return { rows: [workRow()] };
    if (sql.includes('UPDATE oracle_work_claim_results')) return { rows: [{}] };
    if (sql.includes('SELECT work_id, genesis_hash, oracle_id')) return { rows: [aggregateRow('workstation'), aggregateRow('n5pro')] };
    return { rows: [] };
  });
  const { broker, transaction } = reconciliationBroker(outerExecute, transactionExecute);

  const response = await broker.reconcileMinedApproval(minedApproval());

  expect(response).toMatchObject({ mined: true, quorumMined: true, reveal: { eligible: true, minedApprovals: 2, requiredQuorum: 2 } });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(outerExecute).not.toHaveBeenCalled();
  expect(transactionExecute.mock.calls.filter(([sql]) => sql.includes('UPDATE '))).toHaveLength(3);
});

test('new oracle work carries the canonical lowercase owner (backend#1210)', () => {
  const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  expect(work().ownerAddress).toBe('0xowner');
  const built = buildOracleWork({
    workId: 'work:case',
    cycleId: 'cycle:1',
    stationId: 'station-1',
    observationId: 'observation-1',
    canonicalReading: { temperature_c: 10 },
    ownerAddress: MIXED,
    chainId: 'wrfcoin',
    networkId: 'testnet',
    genesisHash: 'genesis-a',
    commitId: 'commit-1',
    commitHash: 'hash-1',
    nonce: 'nonce-1',
    commitTimestamp: 100,
    revealDeadline: 200,
    requiredQuorum: 2,
    evidenceTimestamp: NOW.toISOString(),
  });
  expect(built.ownerAddress).toBe(MIXED.toLowerCase());
});
