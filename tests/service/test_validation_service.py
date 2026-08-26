import io
import unittest

from llmtool.dfbscan.path_validator import PathValidatorOutput
from protocol import DataFlowPath, EventWriter, make_path_id, new_run_id
from service import (
    analyze_candidate,
    extract_candidates,
    inspect_repository,
    validate_path,
)
from service.analysis_service import _CONTEXTS, _load_candidate_context
from tests._support import FIXTURES_ROOT, NOT_RUN_REASON
from tests.service.test_analysis_service import _DeterministicIntraAnalyzer


class _Logger:
    def print_log(self, *args):
        return None

    def print_console(self, *args):
        return None


class _DeterministicPathValidator:
    def __init__(self, response):
        self.response = response
        self.total_query_num = 0
        self.logger = _Logger()
        self.model = type("Model", (), {"logger": self.logger})()

    def invoke(self, validator_input, output_type):
        self.total_query_num += 1
        if self.response is None:
            return None
        return PathValidatorOutput(self.response == "Answer: Yes", self.response)


@unittest.skip(NOT_RUN_REASON)
class PathValidationServiceTests(unittest.TestCase):
    def setUp(self):
        _CONTEXTS.clear()

    def _analyzed_path(self):
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
        paths = analyze_candidate(
            profile.run_id,
            candidate.candidate_id,
            intra_dataflow_analyzer=_DeterministicIntraAnalyzer(),
            event_writer=writer,
            call_depth=0,
        )
        return writer, profile, candidate, paths[0]

    def test_reachable_and_unparseable_responses_map_to_public_verdicts(self):
        writer, profile, candidate, path = self._analyzed_path()
        reachable = validate_path(
            profile.run_id,
            candidate.candidate_id,
            path.path_id,
            path_validator=_DeterministicPathValidator("Answer: Yes"),
            event_writer=writer,
        )
        inconclusive = validate_path(
            profile.run_id,
            candidate.candidate_id,
            path.path_id,
            path_validator=_DeterministicPathValidator("Answer: Maybe"),
            event_writer=writer,
        )

        self.assertEqual(reachable.verdict, "reachable")
        self.assertEqual(inconclusive.verdict, "inconclusive")
        self.assertNotIn("Answer: Maybe", inconclusive.to_json())

    def test_partial_path_never_invokes_validator(self):
        writer, profile, candidate, complete_path = self._analyzed_path()
        partial = DataFlowPath(
            run_id=profile.run_id,
            candidate_id=candidate.candidate_id,
            path_id=make_path_id(
                profile.run_id,
                candidate.candidate_id,
                complete_path.steps,
            ),
            steps=complete_path.steps,
            status="partial",
            reason_codes=["ANALYSIS_DEPTH_LIMIT_REACHED"],
        )
        context, _ = _load_candidate_context(profile.run_id, candidate.candidate_id)
        context.paths[candidate.candidate_id] = {partial.path_id: partial}
        validator = _DeterministicPathValidator("Answer: Yes")

        result = validate_path(
            profile.run_id,
            candidate.candidate_id,
            partial.path_id,
            path_validator=validator,
            event_writer=writer,
        )

        self.assertEqual(result.verdict, "inconclusive")
        self.assertIn("PARTIAL_PATH_NOT_VALIDATED", result.reason_codes)
        self.assertEqual(validator.total_query_num, 0)
