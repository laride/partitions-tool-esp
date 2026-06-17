#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["littlefs-python"]
# ///
"""Generate LittleFS golden fixtures using the littlefs-python package.

This script creates binary LittleFS images that serve as cross-validation
fixtures for the pure-TypeScript LittleFS implementation.

Usage (recommended):
    uv run scripts/build-fixtures-littlefs.py [--out DIR]

Usage (manual):
    pip install littlefs-python
    python3 scripts/build-fixtures-littlefs.py [--out DIR]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def check_littlefs_python() -> None:
    """Ensure littlefs-python is importable; exit with a clear message if not."""
    try:
        import littlefs  # noqa: F401
    except ImportError:
        print(
            "error: littlefs-python is not installed.\n"
            "       Install it with:  pip install littlefs-python\n"
            "       Or run via uv:    uv run scripts/build-fixtures-littlefs.py\n"
            "       https://pypi.org/project/littlefs-python/",
            file=sys.stderr,
        )
        sys.exit(1)


def build_empty(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Empty root directory — no files."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    (out / "littlefs_empty.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] empty  -> {out / 'littlefs_empty.bin'}")


def build_single_inline(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Single small file that fits inline in metadata."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    with fs.open("hello.txt", "w") as fh:
        fh.write("Hello from LittleFS!\n")
    (out / "littlefs_single.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] single -> {out / 'littlefs_single.bin'}")


def build_multi(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Multiple small inline files."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    for name, content in [
        ("alpha.txt", "alpha\n"),
        ("beta.txt", "beta\n"),
        ("gamma.txt", "gamma\n"),
    ]:
        with fs.open(name, "w") as fh:
            fh.write(content)
    (out / "littlefs_multi.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] multi  -> {out / 'littlefs_multi.bin'}")


def build_large(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Large file that requires CTZ skip-list storage."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    with fs.open("big.txt", "w") as fh:
        fh.write("ABCDEFGHIJ" * 500)  # 5000 bytes
    (out / "littlefs_large.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] large  -> {out / 'littlefs_large.bin'}")


def build_nested(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Nested directory structure."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    fs.mkdir("/subdir")
    with fs.open("/root.txt", "w") as fh:
        fh.write("root\n")
    with fs.open("/subdir/inner.txt", "w") as fh:
        fh.write("nested file content\n")
    (out / "littlefs_nested.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] nested -> {out / 'littlefs_nested.bin'}")


def build_deep(out: Path, block_size: int = 4096, block_count: int = 32) -> None:
    """Deeply nested directories (a/b/c/deep.txt)."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    fs.mkdir("/a")
    fs.mkdir("/a/b")
    fs.mkdir("/a/b/c")
    with fs.open("/a/b/c/deep.txt", "w") as fh:
        fh.write("deep\n")
    (out / "littlefs_deep.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] deep   -> {out / 'littlefs_deep.bin'}")


def build_from_source(out: Path, src: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Build image from the littlefs_src directory tree."""
    from littlefs import LittleFS

    if not src.is_dir():
        print(f"  [littlefs] skip from_source — {src} not found")
        return

    fs = LittleFS(block_size=block_size, block_count=block_count)

    for root, dirs, files in os.walk(src):
        rel_root = Path(root).relative_to(src)
        if rel_root != Path("."):
            fs_dir = "/" + str(rel_root).replace(os.sep, "/")
            try:
                fs.mkdir(fs_dir)
            except Exception:
                pass
        for fname in sorted(files):
            host_path = Path(root) / fname
            if rel_root == Path("."):
                fs_path = "/" + fname
            else:
                fs_path = "/" + str(rel_root).replace(os.sep, "/") + "/" + fname
            content = host_path.read_bytes()
            with fs.open(fs_path, "wb") as fh:
                fh.write(content)

    (out / "littlefs_from_src.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] source -> {out / 'littlefs_from_src.bin'}")


def build_empty_file(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Image containing a zero-length file."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    with fs.open("empty.txt", "w") as fh:
        fh.write("")
    (out / "littlefs_empty_file.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] empty_file -> {out / 'littlefs_empty_file.bin'}")


def build_mixed(out: Path, block_size: int = 4096, block_count: int = 16) -> None:
    """Mixed inline and CTZ files."""
    from littlefs import LittleFS

    fs = LittleFS(block_size=block_size, block_count=block_count)
    with fs.open("small.txt", "w") as fh:
        fh.write("small\n")
    with fs.open("large.bin", "wb") as fh:
        fh.write(b"X" * 2000)
    (out / "littlefs_mixed.bin").write_bytes(fs.context.buffer)
    print(f"  [littlefs] mixed  -> {out / 'littlefs_mixed.bin'}")


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    default_out = repo_root / "tests" / "fixtures"

    parser = argparse.ArgumentParser(description="Generate LittleFS golden fixtures")
    parser.add_argument("--out", type=Path, default=default_out, help="Output directory")
    args = parser.parse_args()

    check_littlefs_python()

    from littlefs import __version__ as lfs_version
    print(f"littlefs-python version: {lfs_version}")

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    src = out / "littlefs_src"

    build_empty(out)
    build_single_inline(out)
    build_multi(out)
    build_large(out)
    build_nested(out)
    build_deep(out)
    build_from_source(out, src)
    build_empty_file(out)
    build_mixed(out)

    print("\nAll LittleFS fixtures generated successfully.")


if __name__ == "__main__":
    main()
