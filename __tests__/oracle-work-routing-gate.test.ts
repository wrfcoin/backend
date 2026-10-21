import { requireOracleWorkRoutingDependencies } from '../server/services/oracle-work-routing-gate.js';

test('startup gate leaves oracle routing disabled by default and rejects partial adapter wiring', () => {
  expect(requireOracleWorkRoutingDependencies(false, {})).toBeNull();
  expect(() => requireOracleWorkRoutingDependencies(true, { resolvePrincipal: () => 'principal' })).toThrow('requires configured');
  expect(() => requireOracleWorkRoutingDependencies(true, { resolveMinedApproval: () => 'readback' })).toThrow('requires configured');
});

test('startup gate returns only explicitly supplied paired adapters', () => {
  const resolvePrincipal = () => null;
  const resolveMinedApproval = () => null;
  expect(requireOracleWorkRoutingDependencies(true, { resolvePrincipal, resolveMinedApproval })).toEqual({ resolvePrincipal, resolveMinedApproval });
});

test('startup gate rejects truthy non-callable adapter values', () => {
  expect(() => requireOracleWorkRoutingDependencies(true, {
    resolvePrincipal: { subject: 'worker-a' } as never,
    resolveMinedApproval: { receipt: 'verified' } as never,
  })).toThrow('requires configured');
});
