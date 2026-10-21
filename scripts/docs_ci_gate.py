#!/usr/bin/python3
"""Conservative complete local-Git classifier and independently checked terminal.

No GitHub files API, dependencies, credentials, or project installation. Uncertain
classification selects full scope. Terminal uncertainty can NEVER justify a skip.
"""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess

POLICY = json.loads((Path(__file__).with_name('docs_ci_inputs.json')).read_text())
MAX_BYTES = 8 * 1024 * 1024


def git(*args, cwd='.'):
    return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.DEVNULL,
                                   timeout=120)


def allowed(path, inputs):
    # Exact case-sensitive allowlist. Never exempt arbitrary *.md elsewhere.
    prose = path in ('README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE')
    prose |= bool(re.fullmatch(r'docs/(?:[^/]+/)*[^/]+\.(?:md|png|jpg|svg)', path))
    safe = all(part not in ('', '.', '..') for part in path.split('/'))
    return safe and prose and not any(fnmatch.fnmatchcase(path, p) for p in inputs)


def classify(base, head, cwd='.', max_paths=10000):
    try:
        # Verify trees; no implicit revision/range interpretation of payloads.
        if not all(re.fullmatch(r'[0-9a-f]{40}', sha) for sha in (base, head)):
            raise ValueError('invalid identity')
        inputs = list(POLICY['inputs'])
        if POLICY.get('asset_index'):
            for sha in (base, head):
                index = json.loads(git('show', f"{sha}:{POLICY['asset_index']}", cwd=cwd))
                if not isinstance(index, list) or not index:
                    raise ValueError('missing asset declarations')
                for entry in index:
                    path = entry['path']
                    if not isinstance(path, str) or not path.startswith('docs/'):
                        raise ValueError('invalid asset declaration')
                    inputs.append(path)
        data = git('diff', '--raw', '-z', '--no-abbrev', '--find-renames',
                   '--no-ext-diff', '--no-textconv', base, head, '--', cwd=cwd)
        if not data or len(data) > MAX_BYTES:
            return False, 'empty or oversized diff', []
        fields = data.split(b'\0')
        if fields.pop() != b'':
            raise ValueError('incomplete diff')
        paths = []
        regular = True
        while fields:
            header = fields.pop(0).decode('ascii').split()
            if len(header) != 5 or not header[0].startswith(':'):
                raise ValueError('malformed diff')
            oldmode, newmode = header[0][1:], header[1]
            status = header[4]
            if not re.fullmatch(r'(?:[AMDT]|[RC][0-9]+)', status):
                raise ValueError('unknown change status')
            regular &= oldmode in ('000000', '100644') and newmode in ('000000', '100644')
            # R/C records contain BOTH old and new paths. A/M/D use one name.
            for _ in range(2 if status[0] in 'RC' else 1):
                paths.append(fields.pop(0).decode('utf-8', errors='strict'))
            if len(paths) > max_paths:
                return False, 'oversized path count', []
        docs = regular and all(allowed(p, inputs) for p in paths)
        return docs, ('complete allowlisted prose' if docs else 'code, declared input, or unsafe file mode'), paths
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        return False, 'classifier uncertainty; full scope required', []


def event_scope():
    if os.environ.get('GITHUB_EVENT_NAME') != 'pull_request':
        return False, 'non-PR event; full scope required', []
    try:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        base_tip = event['pull_request']['base']['sha']
        head = event['pull_request']['head']['sha']
        if not all(re.fullmatch(r'[0-9a-f]{40}', s) for s in (base_tip, head)):
            raise ValueError('invalid event identity')
        # Full checkout and explicit immutable tips: no shallow/truncated path list.
        git('fetch', '--no-tags', 'origin', base_tip, head)
        if git('rev-parse', 'HEAD').decode().strip() != head:
            raise ValueError('checkout identity mismatch')
        base = git('merge-base', base_tip, head).decode().strip()
        docs, reason, paths = classify(base, head)
        print(f'merge-base={base} candidate={head}')
        return docs, reason, paths
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False, 'fetch/event/identity uncertainty; full scope required', []


def terminal(needs, independently_docs):
    expected = {'changes', *POLICY['workers']}
    messages = []
    if not isinstance(needs, dict) or set(needs) != expected:
        return False, ['RED: missing or unclassified dependency']
    changes = needs['changes']
    docs = changes.get('outputs', {}).get('docs_only')
    if changes.get('result') != 'success' or docs not in ('true', 'false'):
        return False, ['RED: classifier failed/cancelled/skipped or missing/malformed output']
    if docs == 'true' and not independently_docs:
        return False, ['RED: docs-only output disagrees with independent complete diff']
    good = True
    for worker in POLICY['workers']:
        result = needs[worker].get('result')
        excluded = docs == 'true'
        ok = result == 'success' or (excluded and result == 'skipped')
        good &= ok
        obligation = 'excluded: proved docs-only predicate' if excluded else 'selected: full-scope decision'
        messages.append(f'{worker}: result={result}; {obligation}; {"PASS" if ok else "RED"}')
    return good, messages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('classify', 'terminal'))
    args = parser.parse_args()
    docs, reason, paths = event_scope()
    # JSON escapes paths/newlines; never render them as workflow commands.
    print('diff paths: ' + json.dumps(paths, ensure_ascii=True))
    print('scope reason: ' + reason)
    if args.mode == 'classify':
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'docs_only={str(docs).lower()}\n')
        return 0
    needs = json.loads(os.environ['CI_NEEDS_JSON'])
    good, messages = terminal(needs, docs)
    summary = '\n'.join(messages)
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write('```text\n' + reason + '\n' + summary + '\n```\n')
    return 0 if good else 1


if __name__ == '__main__':
    raise SystemExit(main())
