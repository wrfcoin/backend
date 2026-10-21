"""Public PR jobs are hosted; the persistent contract job is main/manual only."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


def audit(ci, contract):
    assert 'self-hosted' not in '\n'.join(x for x in ci.splitlines() if x.strip().startswith('runs-on:'))
    jobs = dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:|\Z)', ci.split('jobs:\n', 1)[1], re.M | re.S))
    assert set(jobs) == {'changes', 'build-and-test', 'ci-scope-result'}
    for job in jobs.values():
        assert 'runs-on: ubuntu-latest' in job
    assert 'npx tsc --noEmit' in jobs['build-and-test']
    assert 'npm test -- --maxWorkers=2' in jobs['build-and-test']
    assert 'if: always()' in jobs['ci-scope-result']
    assert 'needs: [changes, build-and-test]' in jobs['ci-scope-result']
    assert 'pull_request:' not in contract
    assert 'pull_request_target:' not in contract
    assert 'schedule:' not in contract
    assert 'branches: [main]' in contract
    assert "if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in contract
    assert 'needs: changes' not in contract
    assert 'runs-on: [self-hosted, ct102-backend]' in contract
    assert 'WRFCOIN_REQUIRE_LIVE_CORE4: "1"' in contract
    for workflow in (ci, contract):
        assert 'permissions:\n  contents: read' in workflow


class ForkBoundary(unittest.TestCase):
    def setUp(self):
        self.ci = (ROOT / '.github/workflows/ci.yml').read_text()
        self.contract = (ROOT / '.github/workflows/core4-http-contract.yml').read_text()

    def test_workflows(self):
        audit(self.ci, self.contract)

    def test_pr_runner_mutation(self):
        with self.assertRaises(AssertionError):
            audit(self.ci.replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, ct102-backend]', 1), self.contract)

    def test_contract_trigger_mutation(self):
        with self.assertRaises(AssertionError):
            audit(self.ci, self.contract.replace('on:\n', 'on:\n  pull_request:\n', 1))

    def test_contract_guard_mutation(self):
        with self.assertRaises(AssertionError):
            audit(self.ci, self.contract.replace("if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'", 'if: always()'))

    def test_substantive_tests_removed(self):
        with self.assertRaises(AssertionError):
            audit(self.ci.replace('npm test -- --maxWorkers=2', 'echo skipped'), self.contract)


if __name__ == '__main__':
    unittest.main(verbosity=2)
