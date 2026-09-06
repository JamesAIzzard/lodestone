#!/usr/bin/env python3
"""Migrate Lodestone silo indexes from schema 5 to schema 6, or repair schema 6 dates.

The date derivation repeats DATE_MS_SQL_EXPRESSION from
src/backend/store/date.ts exactly:

COALESCE(
  CASE WHEN json_type(file_metadata, '$.received_at') = 'text'
    THEN unixepoch(json_extract(file_metadata, '$.received_at'), 'subsec') * 1000
  END,
  mtime_ms
)
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import tomllib
from pathlib import Path


MINIMUM_SQLITE_VERSION = (3, 42, 0)
DATE_MS_SQL_EXPRESSION = """COALESCE(
  CASE WHEN json_type(file_metadata, '$.received_at') = 'text'
    THEN unixepoch(json_extract(file_metadata, '$.received_at'), 'subsec') * 1000
  END,
  mtime_ms
)"""
RECEIVED_AT_SQL_EXPRESSION = """CASE
  WHEN json_type(file_metadata, '$.received_at') = 'text'
  THEN unixepoch(json_extract(file_metadata, '$.received_at'), 'subsec') * 1000
END"""


def default_profiles() -> list[Path]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; pass one or more profile directories.")
    return [Path(appdata) / "Lodestone", Path(appdata) / "Lodestone-Dev"]


def database_paths(profile: Path) -> list[Path]:
    config_path = profile / "config.toml"
    if not config_path.exists():
        print(f"Warning: {config_path} does not exist; skipping profile.", file=sys.stderr)
        return []

    with config_path.open("rb") as config_file:
        config = tomllib.load(config_file)

    silos = config.get("silos", {})
    if not isinstance(silos, dict):
        raise ValueError(f"{config_path} has no valid [silos] table.")

    paths: set[Path] = set()
    for silo_name, silo in silos.items():
        if not isinstance(silo, dict) or not isinstance(silo.get("index_db_path"), str):
            print(
                f"Warning: silo {silo_name!r} in {config_path} has no index_db_path; skipping.",
                file=sys.stderr,
            )
            continue
        db_path = Path(silo["index_db_path"])
        if not db_path.is_absolute():
            db_path = profile / db_path
        paths.add(db_path.resolve())

    return sorted(paths)


def read_version(db: sqlite3.Connection) -> str | None:
    row = db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
    return None if row is None else str(row[0])


def date_branch_counts(db: sqlite3.Connection) -> tuple[int, int, int]:
    row = db.execute(
        f"""SELECT
          COUNT(*) AS file_count,
          COUNT({RECEIVED_AT_SQL_EXPRESSION}) AS received_at_count
        FROM files"""
    ).fetchone()
    file_count = int(row[0])
    received_at_count = int(row[1])
    return file_count, received_at_count, file_count - received_at_count


def date_mismatch_count(db: sqlite3.Connection) -> int:
    row = db.execute(
        f"""SELECT COUNT(*)
        FROM files
        WHERE date_ms IS NOT {DATE_MS_SQL_EXPRESSION}"""
    ).fetchone()
    return int(row[0])


def repair_dates(db: sqlite3.Connection) -> int:
    result = db.execute(
        f"""UPDATE files
        SET date_ms = {DATE_MS_SQL_EXPRESSION}
        WHERE date_ms IS NOT {DATE_MS_SQL_EXPRESSION}"""
    )
    return result.rowcount


def migrate_database(db_path: Path, dry_run: bool) -> bool:
    if not db_path.exists():
        print(f"Warning: {db_path} does not exist; skipping.", file=sys.stderr)
        return True

    db = sqlite3.connect(db_path, isolation_level=None, timeout=0)
    try:
        try:
            db.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as error:
            if "locked" in str(error).lower():
                print(f"{db_path} is in use. Close Lodestone and run again.", file=sys.stderr)
                return False
            raise

        version = read_version(db)
        if version not in {"5", "6"}:
            print(f"{db_path}: expected schema 5 or 6, found {version!r}; skipping.", file=sys.stderr)
            db.rollback()
            return False

        columns = {str(row[1]) for row in db.execute("PRAGMA table_info(files)")}
        if version == "6":
            if "date_ms" not in columns:
                print(
                    f"{db_path}: schema 6 is missing files.date_ms; skipping.",
                    file=sys.stderr,
                )
                db.rollback()
                return False

            file_count, received_count, mtime_count = date_branch_counts(db)
            mismatch_count = date_mismatch_count(db)
            if dry_run:
                print(
                    f"{db_path}: would repair {mismatch_count} of {file_count} file dates "
                    f"({received_count} received_at, {mtime_count} mtime_ms)."
                )
                db.rollback()
                return True
            if mismatch_count == 0:
                print(f"{db_path}: already at schema 6; all {file_count} file dates are consistent.")
                db.rollback()
                return True

            repaired_count = repair_dates(db)
            db.execute("CREATE INDEX IF NOT EXISTS idx_files_date_ms ON files(date_ms)")
            db.commit()
            print(
                f"{db_path}: repaired {repaired_count} of {file_count} file dates "
                f"({received_count} received_at, {mtime_count} mtime_ms)."
            )
            return True

        if "date_ms" in columns:
            print(f"{db_path}: date_ms already exists; treating as migrated.")
            db.rollback()
            return True

        file_count, received_count, mtime_count = date_branch_counts(db)
        if dry_run:
            print(
                f"{db_path}: would migrate {file_count} files "
                f"({received_count} received_at, {mtime_count} mtime_ms)."
            )
            db.rollback()
            return True

        db.execute("ALTER TABLE files ADD COLUMN date_ms REAL")
        db.execute(f"UPDATE files SET date_ms = {DATE_MS_SQL_EXPRESSION}")
        db.execute("CREATE INDEX IF NOT EXISTS idx_files_date_ms ON files(date_ms)")
        db.execute("UPDATE meta SET value = '6' WHERE key = 'version'")
        db.commit()
        print(
            f"{db_path}: migrated {file_count} files "
            f"({received_count} received_at, {mtime_count} mtime_ms)."
        )
        return True
    finally:
        db.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migrate Lodestone silo indexes from schema 5 to schema 6, or repair schema 6 dates."
    )
    parser.add_argument(
        "profiles",
        nargs="*",
        type=Path,
        help=r"Profile directories (default: %%APPDATA%%\Lodestone and Lodestone-Dev).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report migrations without changing any database.",
    )
    return parser.parse_args()


def main() -> int:
    if sqlite3.sqlite_version_info < MINIMUM_SQLITE_VERSION:
        print(
            "SQLite 3.42.0 or later is required; "
            f"this Python uses {sqlite3.sqlite_version}.",
            file=sys.stderr,
        )
        return 1

    args = parse_args()
    try:
        profiles = args.profiles or default_profiles()
        paths = sorted({path for profile in profiles for path in database_paths(profile.resolve())})
    except (OSError, RuntimeError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    succeeded = True
    for db_path in paths:
        try:
            succeeded = migrate_database(db_path, args.dry_run) and succeeded
        except (OSError, sqlite3.DatabaseError) as error:
            print(f"{db_path}: {error}", file=sys.stderr)
            succeeded = False
    return 0 if succeeded else 1


if __name__ == "__main__":
    raise SystemExit(main())
