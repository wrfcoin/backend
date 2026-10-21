import type { VerifiedMinedApproval, VerifiedOraclePrincipal } from './oracle-work-broker.js';

export type OraclePrincipalResolver = (
  request: unknown,
) => VerifiedOraclePrincipal | null | Promise<VerifiedOraclePrincipal | null>;

export type OracleMinedApprovalResolver = (
  request: unknown,
) => VerifiedMinedApproval | null | Promise<VerifiedMinedApproval | null>;

export interface OracleWorkRoutingDependencies<P = unknown, M = unknown> {
  resolvePrincipal?: P;
  resolveMinedApproval?: M;
}

export type ConfiguredOracleWorkRoutingDependencies = {
  resolvePrincipal: OraclePrincipalResolver;
  resolveMinedApproval: OracleMinedApprovalResolver;
};

/** Refuse an accidental production enablement without both trusted adapters. */
export function requireOracleWorkRoutingDependencies(
  enabled: boolean,
  dependencies: OracleWorkRoutingDependencies<OraclePrincipalResolver, OracleMinedApprovalResolver>,
): ConfiguredOracleWorkRoutingDependencies | null {
  if (!enabled) return null;
  if (typeof dependencies.resolvePrincipal !== 'function' || typeof dependencies.resolveMinedApproval !== 'function') {
    throw new Error('oracle-work routing requires configured verified-worker and mined-readback adapters');
  }
  return { resolvePrincipal: dependencies.resolvePrincipal, resolveMinedApproval: dependencies.resolveMinedApproval };
}
