#!/usr/bin/env python3
"""Self-hosted runner boundary: untrusted events never reach persistent runners.

A job whose `runs-on` is not a literal GitHub-hosted label (self-hosted labels,
expressions, matrix values) must sit in a workflow triggered only by `push` to
main and `workflow_dispatch`, and must carry the explicit event guard as its
job-level `if:`. Any `pull_request*`, `workflow_run`, comment or scheduled
trigger next to such a job fails. Comments are not parsed, so a staged
commented-out `pull_request:` block cannot be restored without tripping this.

Usage: check_self_hosted_boundary.py [--self-test]
"""
from pathlib import Path
import copy
import sys
import unittest

import yaml

GUARD = "github.event_name == 'push' || github.event_name == 'workflow_dispatch'"
ALLOWED_IF = {GUARD, f"github.event.repository.private && ({GUARD})"}
HOSTED = {'ubuntu-latest', 'ubuntu-22.04', 'ubuntu-24.04', 'windows-latest',
          'windows-2022', 'macos-latest', 'macos-14', 'macos-15'}


def _hosted(job):
    runner = job.get('runs-on')
    if runner == '${{ matrix.os }}':
        matrix = job.get('strategy', {}).get('matrix', {})
        runners = list(matrix.get('os', [])) + [r['os'] for r in matrix.get('include', []) if 'os' in r]
        return bool(runners) and all(x in HOSTED for x in runners)
    return isinstance(runner, str) and runner in HOSTED


def findings(document):
    errors = []
    events = document.get('on', document.get(True, {})) or {}
    if not isinstance(events, dict):
        events = dict.fromkeys(events if isinstance(events, list) else [events])
    for name, job in (document.get('jobs') or {}).items():
        if 'runs-on' not in job and 'uses' in job:
            if not str(job['uses']).startswith('./.github/workflows/'):
                errors.append(f'{name}: external reusable workflow needs explicit runner review')
            continue
        if _hosted(job):
            continue
        extra = set(events) - {'push', 'workflow_dispatch'}
        if extra:
            errors.append(f'{name}: persistent/dynamic runner with untrusted or scheduled trigger {sorted(extra)}')
        if 'push' in events and (events['push'] or {}).get('branches') != ['main']:
            errors.append(f'{name}: persistent runner push is not main-only')
        if ' '.join(str(job.get('if', '')).split()) not in ALLOWED_IF:
            errors.append(f'{name}: persistent/dynamic runner lacks the explicit event guard')
    return errors


class Controls(unittest.TestCase):
    def setUp(self):
        self.doc = {'on': {'push': {'branches': ['main']}, 'workflow_dispatch': {}},
                    'jobs': {'heavy': {'runs-on': ['self-hosted', 'n5pro'], 'if': GUARD}}}

    def test_clean(self):
        self.assertEqual(findings(self.doc), [])

    def test_untrusted_events_rejected(self):
        for event in ['pull_request', 'pull_request_target', 'workflow_run', 'issue_comment', 'schedule']:
            d = copy.deepcopy(self.doc)
            d['on'][event] = {}
            self.assertTrue(findings(d), event)

    def test_missing_guard_rejected(self):
        del self.doc['jobs']['heavy']['if']
        self.assertTrue(findings(self.doc))

    def test_expression_runner_needs_guard(self):
        self.doc['jobs']['heavy'] = {'runs-on': "${{ inputs.r || 'n5pro' }}"}
        self.assertTrue(findings(self.doc))

    def test_hosted_pr_allowed(self):
        self.doc['on'] = {'pull_request': {}}
        self.doc['jobs']['heavy'] = {'runs-on': 'ubuntu-latest'}
        self.assertEqual(findings(self.doc), [])


def main():
    if '--self-test' in sys.argv:
        sys.argv = sys.argv[:1]
        unittest.main()
    root = Path(__file__).resolve().parents[1]
    paths = sorted((root / '.github/workflows').glob('*.y*ml'))
    errors = [(p.name, e) for p in paths for e in findings(yaml.safe_load(p.read_text()) or {})]
    for name, error in errors:
        print(f'{name}: {error}')
    print(f'Self-hosted boundary: {len(paths)} workflows, {len(errors)} violations')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
