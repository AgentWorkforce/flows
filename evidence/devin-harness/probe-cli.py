"""Probe an installed Devin without touching its interactive credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument("--cli", required=True)
parser.add_argument("--credentials", type=Path)
args = parser.parse_args()
EXPECTED_CLI_VERSION = "3000.11.234"
version = subprocess.check_output([args.cli, "--version"], text=True).strip()
print(version, flush=True)
if not version.startswith(f"devin {EXPECTED_CLI_VERSION} "):
    raise SystemExit("Unexpected Devin CLI version")
modes = ["none", "dummy_env", "dummy_file"]
if args.credentials:
    modes.append("existing_login_file")
for mode in modes:
    with tempfile.TemporaryDirectory(prefix="devin-probe-") as directory:
        root = Path(directory)
        env = dict(os.environ, HOME=directory, XDG_DATA_HOME=str(root / "data"),
                   XDG_CONFIG_HOME=str(root / "config"), XDG_CACHE_HOME=str(root / "cache"))
        env.pop("DEVIN_API_KEY", None)
        if mode == "dummy_env":
            env["DEVIN_API_KEY"] = "probe-invalid"
        if mode.endswith("file"):
            key = "probe-invalid" if mode == "dummy_file" else tomllib.loads(
                args.credentials.read_text())["windsurf_api_key"]
            credential = root / "data/devin/credentials.toml"
            credential.parent.mkdir(parents=True, mode=0o700)
            credential.write_text("windsurf_api_key = " + json.dumps(key) + "\n")
            credential.chmod(0o600)
        result = subprocess.run([args.cli, "models", "list", "--format", "json"],
                                env=env, cwd=root, capture_output=True, text=True, timeout=30)
        # Print only fixed classifications: provider output can identify an account.
        detail = ("catalog received" if result.returncode == 0 else
                  "not logged in" if "Not logged in" in result.stderr else
                  "invalid api key" if "invalid api key" in result.stderr else "unclassified failure")
        print(f"{mode}: models exit={result.returncode}; {detail}", flush=True)
        expected = "catalog received" if mode == "existing_login_file" else (
            "invalid api key" if mode == "dummy_file" else "not logged in")
        if detail != expected:
            raise SystemExit(f"{mode}: unexpected authentication behavior")
        if mode == "existing_login_file":
            prompt = root / "prompt.txt"
            prompt.write_text("Reply with exactly RELAYFLOWS_DEVIN_READY and nothing else. Do not call tools.")
            result = subprocess.run([args.cli, "-p", "--prompt-file", str(prompt),
                                     "--permission-mode", "auto", "--respect-workspace-trust", "false"],
                                    env=env, cwd=root, capture_output=True, text=True, timeout=60)
            print(f"headless exit={result.returncode}; marker received={result.stdout.strip() == 'RELAYFLOWS_DEVIN_READY'}",
                  flush=True)
            if result.returncode != 0 or result.stdout.strip() != 'RELAYFLOWS_DEVIN_READY':
                raise SystemExit("Headless marker probe failed")
