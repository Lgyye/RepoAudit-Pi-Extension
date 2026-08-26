import re
import unittest

from protocol import DataFlowStep, SourceLocation, make_candidate_id, make_path_id
from tests._support import NOT_RUN_REASON, OTHER_RUN_ID, RUN_ID, make_pair, make_steps


@unittest.skip(NOT_RUN_REASON)
class StableIdentifierTests(unittest.TestCase):
    def test_candidate_id_is_deterministic_and_run_scoped(self):
        pair = make_pair()
        first = make_candidate_id(RUN_ID, "NPD", pair, "source", "sink")
        second = make_candidate_id(RUN_ID, "NPD", pair, "source", "sink")
        other_run = make_candidate_id(OTHER_RUN_ID, "NPD", pair, "source", "sink")

        self.assertEqual(first, second)
        self.assertNotEqual(first, other_run)
        self.assertRegex(first, re.compile(r"^cand_[0-9a-f]{24}$"))

    def test_path_id_is_deterministic_and_changes_with_step_identity(self):
        candidate_id = make_candidate_id(RUN_ID, "NPD", make_pair())
        steps = make_steps()
        first = make_path_id(RUN_ID, candidate_id, steps)
        second = make_path_id(RUN_ID, candidate_id, steps)
        changed_steps = [
            steps[0],
            DataFlowStep(
                step_index=2,
                kind="sink",
                location=SourceLocation("app.py", 4),
                function_name="vulnerable_lookup",
                value="account",
            ),
        ]

        self.assertEqual(first, second)
        self.assertNotEqual(first, make_path_id(RUN_ID, candidate_id, changed_steps))
        self.assertRegex(first, re.compile(r"^path_[0-9a-f]{24}$"))
