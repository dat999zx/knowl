#!/usr/bin/env python3
"""Copy the Knowl plugin into Hermes' plugins directory and print the config block.

Deliberately does not edit config.yaml: Hermes rewrites that file through a YAML
dumper that drops comments, and a second top-level `plugins:` key would break it.
The printed block is small; paste or merge it by hand.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "hermes"
    return Path.home() / ".hermes"


def main() -> int:
    src = Path(__file__).resolve().parent / "knowl"
    if not (src / "plugin.yaml").exists() or not (src / "__init__.py").exists():
        print(f"plugin sources missing under {src}", file=sys.stderr)
        return 1
    home = hermes_home()
    if not home.exists():
        print(f"Hermes home not found at {home}; is Hermes installed? (set HERMES_HOME to override)", file=sys.stderr)
        return 1
    dest = home / "plugins" / "knowl"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("plugin.yaml", "__init__.py"):
        shutil.copy2(src / name, dest / name)
    print(f"installed -> {dest}")

    knowl_bin = shutil.which("knowl.cmd" if sys.platform == "win32" else "knowl") or shutil.which("knowl")
    hint = knowl_bin.replace("\\", "/") if knowl_bin else "npx -y @dat999zx/knowl   # or install: npm i -g @dat999zx/knowl"
    config = home / "config.yaml"
    has_plugins_key = False
    try:
        has_plugins_key = any(line.startswith("plugins:") for line in config.read_text(encoding="utf-8", errors="replace").splitlines())
    except OSError:
        pass
    print()
    print(f"Now {'MERGE into the existing plugins: block of' if has_plugins_key else 'append to'} {config}:")
    print()
    print("plugins:")
    print("  enabled:")
    print("    - knowl")
    print("  entries:")
    print("    knowl:")
    print("      settings:")
    print(f"        knowl_bin: \"{hint}\"")
    print("        timeout_seconds: 30")
    print()
    print("Then restart Hermes. Do not use `hermes plugins enable` (it rewrites config.yaml and drops comments).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
