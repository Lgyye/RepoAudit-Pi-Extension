import io
import json
import unittest

from protocol import EventWriter, new_run_id
from service import inspect_repository
from tests._support import FIXTURES_ROOT, NOT_RUN_REASON


@unittest.skip(NOT_RUN_REASON)
class RepositoryInspectorTests(unittest.TestCase):
    def test_inspection_returns_repository_relative_public_facts(self):
        event_stream = io.StringIO()
        writer = EventWriter(event_stream=event_stream, log_stream=io.StringIO())
        repository = FIXTURES_ROOT / "clean-python"
        run_id = new_run_id()

        profile = inspect_repository(
            repository,
            "Python",
            run_id=run_id,
            event_writer=writer,
            max_symbolic_workers=1,
        )

        self.assertEqual(profile.run_id, run_id)
        self.assertEqual(profile.source_files, ["app.py"])
        self.assertEqual(profile.file_type_counts, {".py": 1})
        self.assertIn("NPD", profile.supported_bug_types)
        self.assertIn(".hidden", profile.ignored_directories)
        self.assertGreaterEqual(profile.function_count, 1)
        event = json.loads(event_stream.getvalue().splitlines()[-1])
        self.assertEqual(event["event_type"], "repository_inspected")

    def test_invalid_path_and_language_are_rejected_before_analysis(self):
        with self.assertRaises(FileNotFoundError):
            inspect_repository(FIXTURES_ROOT / "missing", "Python")
        with self.assertRaises(ValueError):
            inspect_repository(FIXTURES_ROOT / "clean-python", "Rust")
