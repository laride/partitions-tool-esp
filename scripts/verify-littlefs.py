#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["littlefs-python"]
# ///
"""Parse a LittleFS image with littlefs-python and emit file listing as JSON.

Used by the TypeScript test suite for reverse cross-validation:
TS generates an image → this script parses it with the C reference → TS compares.

Usage:
    python3 scripts/verify-littlefs.py <image.bin> [--block-size N]

Output (stdout):
    {
      "superblock": { "blockSize": 4096, "blockCount": 16 },
      "files": [
        { "path": "/hello.txt", "size": 21, "hex": "48656c6c6f..." }
      ]
    }
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def walk_fs(fs: "LittleFS", dirpath: str = "/") -> list[dict]:
    """Recursively walk the filesystem and collect all files."""
    from littlefs import LittleFS

    results: list[dict] = []
    try:
        entries = fs.listdir(dirpath)
    except Exception:
        return results

    for name in sorted(entries):
        if name in (".", ".."):
            continue
        full = dirpath.rstrip("/") + "/" + name
        try:
            info = fs.stat(full)
        except Exception:
            continue
        if info.type == 2:  # directory
            results.extend(walk_fs(fs, full))
        elif info.type == 1:  # file
            with fs.open(full, "rb") as fh:
                content = fh.read()
            results.append({
                "path": full,
                "size": len(content),
                "hex": content.hex(),
            })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse a LittleFS image and emit JSON file listing"
    )
    parser.add_argument("image", type=Path, help="Path to the LittleFS .bin image")
    parser.add_argument("--block-size", type=int, default=4096, help="Block size (default: 4096)")
    args = parser.parse_args()

    try:
        from littlefs import LittleFS
    except ImportError:
        print(
            json.dumps({"error": "littlefs-python not installed"}),
            file=sys.stdout,
        )
        sys.exit(1)

    image_data = args.image.read_bytes()
    block_count = len(image_data) // args.block_size

    fs = LittleFS(
        block_size=args.block_size,
        block_count=block_count,
        mount=False,
    )
    fs.context.buffer = bytearray(image_data)
    fs.mount()

    files = walk_fs(fs)
    result = {
        "superblock": {
            "blockSize": args.block_size,
            "blockCount": block_count,
        },
        "files": files,
    }

    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
