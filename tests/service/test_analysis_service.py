import io
import unittest

from memory.syntactic.value import Value, ValueLabel
from protocol import EventWriter, new_run_id
from service import analyze_candidate, extract_candidates, inspect_repository
from service.analysis_service import CandidateAnalysisError, _CONTEXTS
from tests._support import FIXTURES_ROOT, NOT_RUN_REASON


class _DeterministicIntraAnalyzer:
    def __init__(self):
        self.inputs = []

    def invoke(self, analyzer_input, output_type):
        self.inputs.append(analyzer_input)
        values = {analyzer_input.summary_start}
        for name, relative_line in analyzer_input.sink_values:
            values.add(
                Value(
                    name,
                    analyzer_input.function.start_line_number + relative_line - 1,
                    ValueLabel.SINK,
                    analyzer_input.function.file_path,
                )
            )
        return output_type([values])


@unittest.skip(NOT_RUN_REASON)
class CandidateAnalysisServiceTests(unittest.TestCase):
    def setUp(self):
        _CONTEXTS.clear()

    def _candidate_context(self):
        writer = EventWriter(event_stream=io.StringIO(), log_stream=io.StringIO())
        profile = inspect_repository(
            FIXTURES_ROOT / "vulnerable-python",
            "Python",
            run_id=new_run_id(),
            event_writer=writer,
            max_symbolic_workers=1,
        )
        candidates = extract_candidates(
            profile, "NPD", event_writer=writer, max_symbolic_workers=1
        )
        candidate = next(
            value
            for value in candidates
            if value.source_function == value.sink_function == "vulnerable_lookup"
        )
        return writer, profile, candidate

    def test_only_requested_candidate_is_analyzed_and_path_id_is_stable(self):
        writer, profile, candidate = self._candidate_context()
        analyzer = _DeterministicIntraAnalyzer()

        first = analyze_candidate(
            profile.run_id,
            candidate.candidate_id,
            intra_dataflow_analyzer=analyzer,
            event_writer=writer,
            call_depth=0,
        )
        second = analyze_candidate(
            profile.run_id,
            candidate.candidate_id,
            intra_dataflow_analyzer=analyzer,
            event_writer=writer,
            call_depth=0,
        )

        self.assertEqual(len(first), 1)
        self.assertEqual(first[0].path_id, second[0].path_id)
        self.assertTrue(
            all(path.candidate_id == candidate.candidate_id for path in first)
        )
        self.assertGreaterEqual(len(analyzer.inputs), 1)

    def test_unknown_candidate_fails_before_model_invocation(self):
        writer, profile, _ = self._candidate_context()
        analyzer = _DeterministicIntraAnalyzer()

        with self.assertRaises(CandidateAnalysisError) as caught:
            analyze_candidate(
                profile.run_id,
                "cand_aaaaaaaaaaaaaaaaaaaaaaaa",
                intra_dataflow_analyzer=analyzer,
                event_writer=writer,
            )

        self.assertEqual(caught.exception.error.code, "CANDIDATE_NOT_FOUND")
        self.assertEqual(analyzer.inputs, [])
