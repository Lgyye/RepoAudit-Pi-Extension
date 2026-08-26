import json
import unittest

from protocol import SourceLocation, StructuredError
from tests._support import (
    NOT_RUN_REASON,
    RUN_ID,
    make_candidate,
    make_error,
    make_pair,
    make_path,
    make_profile,
    make_run,
    make_steps,
    make_validation,
)


@unittest.skip(NOT_RUN_REASON)
class PublicModelSerializationTests(unittest.TestCase):
    def test_every_public_object_round_trips_through_json(self):
        pair = make_pair()
        run = make_run("C:/repo")
        profile = make_profile("C:/repo")
        candidate = make_candidate()
        path = make_path(candidate=candidate)
        validation = make_validation(candidate=candidate, path=path)
        error = make_error()

        values = (
            pair.source,
            pair,
            run,
            profile,
            candidate,
            *make_steps(),
            path,
            validation,
            error,
        )
        for value in values:
            payload = json.loads(value.to_json())
            self.assertEqual(payload["schema_version"], "1.0.0")
            if "run_id" in payload:
                self.assertEqual(payload["run_id"], RUN_ID)

    def test_source_locations_normalize_separators_and_reject_absolute_paths(self):
        location = SourceLocation("src\\service\\app.py", 1)
        self.assertEqual(location.relative_path, "src/service/app.py")

        with self.assertRaises(ValueError):
            SourceLocation("C:/repo/app.py", 1)
        with self.assertRaises(ValueError):
            SourceLocation("../app.py", 1)
        with self.assertRaises(ValueError):
            SourceLocation("app.py", 0)

    def test_structured_error_rejects_non_json_details(self):
        with self.assertRaises(TypeError):
            StructuredError(
                code="BAD_DETAILS",
                message="Details are not JSON-safe.",
                stage="test",
                details={"object": object()},
            )
