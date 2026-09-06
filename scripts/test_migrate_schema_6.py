from __future__ import annotations

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("migrate-schema-6.py")


class MigrationScriptTests(unittest.TestCase):
    def make_profile(self, version: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temp_dir = tempfile.TemporaryDirectory()
        profile = Path(temp_dir.name)
        db_path = profile / "index.sqlite"
        profile.joinpath("config.toml").write_text(
            '[silos.test]\nindex_db_path = "index.sqlite"\n',
            encoding="utf-8",
        )

        db = sqlite3.connect(db_path)
        db.executescript(
            """
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE files (
              id INTEGER PRIMARY KEY,
              stored_key TEXT UNIQUE NOT NULL,
              file_name TEXT NOT NULL,
              mtime_ms REAL,
              file_metadata TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        if version == "6":
            db.execute("ALTER TABLE files ADD COLUMN date_ms REAL")
        db.execute("INSERT INTO meta (key, value) VALUES ('version', ?)", (version,))
        db.commit()
        db.close()
        return temp_dir, db_path

    def run_script(self, profile: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(profile), *args],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_migrates_schema_5_dates(self) -> None:
        temp_dir, db_path = self.make_profile("5")
        self.addCleanup(temp_dir.cleanup)
        received_at = "2026-09-01T08:50:17.000Z"
        db = sqlite3.connect(db_path)
        db.execute(
            "INSERT INTO files (stored_key, file_name, mtime_ms, file_metadata) VALUES (?, ?, ?, ?)",
            ("0:mail.md", "mail.md", 99, f'{{"received_at":"{received_at}"}}'),
        )
        db.commit()
        db.close()

        result = self.run_script(Path(temp_dir.name))

        self.assertEqual(result.returncode, 0, result.stderr)
        db = sqlite3.connect(db_path)
        version = db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0]
        date_ms = db.execute("SELECT date_ms FROM files").fetchone()[0]
        expected = db.execute("SELECT unixepoch(?, 'subsec') * 1000", (received_at,)).fetchone()[0]
        db.close()
        self.assertEqual(version, "6")
        self.assertEqual(date_ms, expected)

    def test_dry_run_reports_but_does_not_repair_schema_6(self) -> None:
        temp_dir, db_path = self.make_profile("6")
        self.addCleanup(temp_dir.cleanup)
        db = sqlite3.connect(db_path)
        db.execute(
            "INSERT INTO files (stored_key, file_name, mtime_ms, file_metadata, date_ms) VALUES (?, ?, ?, ?, ?)",
            ("0:file.md", "file.md", 1234, "{}", 9999),
        )
        db.commit()
        db.close()

        result = self.run_script(Path(temp_dir.name), "--dry-run")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would repair 1 of 1 file dates", result.stdout)
        db = sqlite3.connect(db_path)
        self.assertEqual(db.execute("SELECT date_ms FROM files").fetchone()[0], 9999)
        db.close()

    def test_repairs_only_inconsistent_schema_6_dates(self) -> None:
        temp_dir, db_path = self.make_profile("6")
        self.addCleanup(temp_dir.cleanup)
        received_at = "2026-09-01T16:07:32.000Z"
        db = sqlite3.connect(db_path)
        expected_mail = db.execute(
            "SELECT unixepoch(?, 'subsec') * 1000", (received_at,)
        ).fetchone()[0]
        db.executemany(
            "INSERT INTO files (stored_key, file_name, mtime_ms, file_metadata, date_ms) VALUES (?, ?, ?, ?, ?)",
            [
                ("0:mail.md", "mail.md", 9000, f'{{"received_at":"{received_at}"}}', 9000),
                ("0:file.md", "file.md", 1234, "{}", 1234),
                ("0:null.md", "null.md", None, "{}", None),
            ],
        )
        db.commit()
        db.close()

        result = self.run_script(Path(temp_dir.name))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("repaired 1 of 3 file dates", result.stdout)
        db = sqlite3.connect(db_path)
        rows = dict(db.execute("SELECT stored_key, date_ms FROM files"))
        index_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_date_ms'"
        ).fetchone()
        db.close()
        self.assertEqual(rows["0:mail.md"], expected_mail)
        self.assertEqual(rows["0:file.md"], 1234)
        self.assertIsNone(rows["0:null.md"])
        self.assertIsNotNone(index_exists)

        second_result = self.run_script(Path(temp_dir.name))
        self.assertEqual(second_result.returncode, 0, second_result.stderr)
        self.assertIn("all 3 file dates are consistent", second_result.stdout)


if __name__ == "__main__":
    unittest.main()
