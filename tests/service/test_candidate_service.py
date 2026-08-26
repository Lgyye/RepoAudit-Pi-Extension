import io
import unittest

from protocol import EventWriter, new_run_id
from service import extract_candidates, inspect_repository
from service.analysis_service import _CONTEXTS
from tests._support import FIXTURES_ROOT, NOT_RUN_REASON


@unittest.skip(NOT_RUN_REASON)
class CandidateServiceTests(unittest.TestCase):
    def setUp(self):
        _CONTEXTS.clear()

    def test_vulnerable_fixture_produces_sorted_stable_candidates(self):
        repository = FIXTURES_ROOT / "vulnerable-python"
        writer = EventWriter(event_stream=io.StringIO(), log_stream=io.StringIO())
        profile = inspect_repository(
            repository,
            "Python",
            run_id=new_run_id(),
            event_writer=writer,
            max_symbolic_workers=1,
        )

        first = extract_candidates(
            profile, "NPD", event_writer=writer, max_symbolic_workers=1
        )
        second = extract_candidates(
            profile, "NPD", event_writer=writer, max_symbolic_workers=1
        )

        self.assertGreaterEqual(len(first), 1)
        self.assertEqual(
            [candidate.candidate_id for candidate in first],
            [candidate.candidate_id for candidate in second],
        )
        sort_facts = [
            (
                candidate.source_sink_pair.source.relative_path,
                candidate.source_sink_pair.source.start_line,
                candidate.source_sink_pair.source_symbol,
                candidate.source_sink_pair.sink.relative_path,
                candidate.source_sink_pair.sink.start_line,
                candidate.source_sink_pair.sink_symbol,
                candidate.source_function or "",
                candidate.sink_function or "",
                candidate.candidate_id,
            )
            for candidate in first
        ]
        self.assertEqual(sort_facts, sorted(sort_facts))
        self.assertEqual(
            len({candidate.candidate_id for candidate in first}), len(first)
        )

    def test_clean_fixture_has_no_null_source_candidate(self):
        repository = FIXTURES_ROOT / "clean-python"
        writer = EventWriter(event_stream=io.StringIO(), log_stream=io.StringIO())
        profile = inspect_repository(
            repository,
            "Python",
            run_id=new_run_id(),
            event_writer=writer,
            max_symbolic_workers=1,
        )

        candidates = extract_candidates(
            profile, "NPD", event_writer=writer, max_symbolic_workers=1
        )
        self.assertEqual(candidates, [])

    def test_unsupported_bug_type_is_rejected_without_path_validation(self):
        repository = FIXTURES_ROOT / "clean-python"
        profile = inspect_repository(
            repository, "Python", run_id=new_run_id(), max_symbolic_workers=1
        )
        with self.assertRaises(ValueError):
            extract_candidates(profile, "UAF", max_symbolic_workers=1)
