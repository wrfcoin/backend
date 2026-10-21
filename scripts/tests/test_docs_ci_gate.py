"""Production-path RED/GREEN controls; no dependencies or live hosts."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("gate", ROOT / "scripts/docs_ci_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class GateControls(unittest.TestCase):
    def test_01_red_selected_skipped(self):
        self.assertFalse(gate.terminal(self.needs("false", "skipped"), False)[0])

    def test_02_red_classifier_failed(self):
        n = self.needs("true", "skipped")
        n["changes"]["result"] = "failure"
        self.assertFalse(gate.terminal(n, True)[0])

    def test_03_red_forged_docs_with_code(self):
        self.assertFalse(gate.terminal(self.needs("true", "skipped"), False)[0])

    def test_04_green_docs(self):
        self.assertTrue(gate.terminal(self.needs("true", "skipped"), True)[0])

    def test_05_green_code(self):
        self.assertTrue(gate.terminal(self.needs("false", "success"), False)[0])

    def needs(self, docs, result):
        return {"changes": {"result": "success", "outputs": {"docs_only": docs}},
                **{w: {"result": result} for w in gate.POLICY["workers"]}}

    def test_bad_results_and_outputs(self):
        for r in ("failure", "cancelled", "", "unknown"):
            self.assertFalse(gate.terminal(self.needs("true", r), True)[0])
        for d in ("", "TRUE", None):
            self.assertFalse(gate.terminal(self.needs(d, "success"), False)[0])
        n = self.needs("false", "success")
        n["new-worker"] = {"result": "skipped"}
        self.assertFalse(gate.terminal(n, False)[0])
        n.pop("new-worker")
        n.pop(gate.POLICY["workers"][0])
        self.assertFalse(gate.terminal(n, False)[0])

    def test_terminal_cli_red_then_green(self):
        # Exercise the actual terminal command, not a mirrored evaluator.
        for docs, result, expected in (("false", "skipped", 1),
                                       ("true", "skipped", 1),
                                       ("false", "success", 0)):
            e = dict(os.environ, GITHUB_EVENT_NAME="push",
                     CI_NEEDS_JSON=json.dumps(self.needs(docs, result)))
            run = subprocess.run(["python3", str(ROOT / "scripts/docs_ci_gate.py"), "terminal"],
                                 cwd=ROOT, env=e, capture_output=True, text=True)
            self.assertEqual(run.returncode, expected, run.stdout + run.stderr)

    def test_pr_cli_complete_diff_and_failed_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Synthetic")
            git("config", "user.email", "synthetic@example.invalid")
            git("remote", "add", "origin", directory)
            (root / "docs").mkdir()
            (root / "docs/prose.md").write_text("prose")
            if gate.POLICY.get("asset_index"):
                p = root / gate.POLICY["asset_index"]
                p.parent.mkdir(parents=True)
                p.write_text('[{"path":"docs/runtime.md"}]')
            def commit():
                git("add", "docs")
                if gate.POLICY.get("asset_index"):
                    git("add", "server")
                git("commit", "-qm", "fixture")
                return git("rev-parse", "HEAD")
            base = commit()
            (root / "docs/prose.md").write_text("new prose")
            head = commit()
            event = root / "event.json"
            output = root / "output"
            e = dict(os.environ, GITHUB_EVENT_NAME="pull_request",
                     GITHUB_EVENT_PATH=str(event), GITHUB_OUTPUT=str(output),
                     CI_NEEDS_JSON=json.dumps(self.needs("true", "skipped")))
            def run(mode):
                event.write_text(json.dumps({"pull_request":{"base":{"sha":base},"head":{"sha":head}}}))
                return subprocess.run(["python3", str(ROOT / "scripts/docs_ci_gate.py"), mode],
                                      cwd=root, env=e, capture_output=True, text=True)
            self.assertEqual(run("classify").returncode, 0)
            self.assertIn("docs_only=true", output.read_text())
            self.assertEqual(run("terminal").returncode, 0)
            (root / "docs/code.yaml").write_text("input: true")
            head = commit()
            self.assertEqual(run("terminal").returncode, 1)
            git("remote", "remove", "origin")
            output.write_text("")
            self.assertEqual(run("classify").returncode, 0)
            self.assertEqual(output.read_text(), "docs_only=false\n")
            self.assertEqual(run("terminal").returncode, 1)

    def test_real_git_diff_and_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args]).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Synthetic")
            git("config", "user.email", "synthetic@example.invalid")
            def commit():
                git("add", ".")
                git("commit", "-qm", "fixture")
                return git("rev-parse", "HEAD")
            (root / "docs").mkdir()
            (root / "docs/a.md").write_text("prose")
            # Backend's production asset declaration must exist on BOTH trees.
            if gate.POLICY.get("asset_index"):
                p = root / gate.POLICY["asset_index"]
                p.parent.mkdir(parents=True)
                p.write_text('[{"path":"docs/runtime.md"}]')
            base = commit()
            (root / "docs/a.md").write_text("edited prose")
            docs = commit()
            self.assertTrue(gate.classify(base, docs, directory)[0])
            self.assertFalse(gate.classify(base, base, directory)[0])
            (root / "docs/config.yml").write_text("input: true")
            code = commit()
            self.assertFalse(gate.classify(base, code, directory)[0])
            git("mv", "docs/a.md", "source.md")
            renamed = commit()
            self.assertFalse(gate.classify(docs, renamed, directory)[0])
            (root / "docs/runtime.md").write_text("runtime")
            runtime = commit()
            if gate.POLICY.get("asset_index"):
                self.assertFalse(gate.classify(renamed, runtime, directory)[0])
            (root / "docs/storage-ipfs-development.md").write_text("input")
            storage = commit()
            if "docs/storage-ipfs-development.md" in gate.POLICY["inputs"]:
                self.assertFalse(gate.classify(runtime, storage, directory)[0])
            (root / "README.md").write_text("readme")
            readme = commit()
            self.assertEqual(gate.classify(storage, readme, directory)[0],
                             "README.md" not in gate.POLICY["inputs"])
            self.assertFalse(gate.classify("bad", readme, directory)[0])
            # Full local Git enumeration crosses GitHub's 300-file limit.
            for i in range(350):
                (root / f"docs/extra-{i}.md").write_text("prose")
            large_docs = commit()
            self.assertTrue(gate.classify(readme, large_docs, directory)[0])
            self.assertFalse(gate.classify(readme, large_docs, directory, max_paths=100)[0])
            (root / "docs/link.md").symlink_to("../source.md")
            link = commit()
            self.assertFalse(gate.classify(large_docs, link, directory)[0])

if __name__ == "__main__":
    unittest.main(verbosity=2)
