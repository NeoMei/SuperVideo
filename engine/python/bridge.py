#!/usr/bin/env python3
"""JSON stdin/stdout boundary for pinned provider adapters."""

from __future__ import annotations

import json
import sys

from openmontage import execute


def main() -> int:
    try:
        request = json.load(sys.stdin)
        response = execute(request)
    except Exception as error:
        response = {"success": False, "error": f"{type(error).__name__}: {error}", "artifacts": [], "data": {}}
    json.dump(response, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if response.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
