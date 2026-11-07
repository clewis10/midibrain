"""Add Bank 1 CC Hold side-button resets without replacing other rig settings."""
import argparse
import json
from datetime import datetime
from pathlib import Path
import shutil

RESETS = [
    {"channel": 4, "cc": 8, "scope": {"column": 1}},
    {"channel": 4, "cc": 9, "scope": "all"},
    {"channel": 4, "cc": 10, "scope": {"column": 2}},
    {"channel": 4, "cc": 11, "scope": {"column": 3}},
    {"channel": 4, "cc": 12, "scope": "all"},
    {"channel": 4, "cc": 13, "scope": {"column": 4}},
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    profile = json.loads(args.config.read_text())
    profile["twister"]["resets"] = RESETS
    backup = args.config.with_name(args.config.name + datetime.now().strftime(".backup-%Y%m%d-%H%M%S-%f"))
    shutil.copy2(args.config, backup)
    temporary = args.config.with_name(args.config.name + ".tmp")
    temporary.write_text(json.dumps(profile, indent=2) + "\n")
    temporary.replace(args.config)
    print(f"Side-button resets configured. Backup: {backup}")


if __name__ == "__main__":
    main()
