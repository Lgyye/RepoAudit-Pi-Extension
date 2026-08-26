import json
import tempfile
import unittest
from pathlib import Path

from protocol import AnalysisEvent
from storage import RunStore, RunStoreError
from tests._support import (
    NOT_RUN_REASON,
    OTHER_RUN_ID,
    RUN_ID,
    make_candidate,
    make_error,
    make_event,
    make_path,
    make_profile,
    make_run,
    make_validation,
)


@unittest.skip(NOT_RUN_REASON)
class RunStoreRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "runs"
        self.store = RunStore(self.root)
        self.run = make_run("C:/repo")
        self.profile = make_profile("C:/repo")
        self.candidate = make_candidate()
        self.path = make_path(candidate=self.candidate)
        self.validation = make_validation(candidate=self.candidate, path=self.path)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_snapshot_round_trip_recovers_every_public_stage(self):
        run_directory = self.store.create_run(self.run)
        self.store.save_repository(self.profile)
        self.store.save_candidates(RUN_ID, [self.candidate])
        self.store.save_paths(RUN_ID, [self.path])
        self.store.save_validations(RUN_ID, [self.validation])
        self.store.save_errors(RUN_ID, [make_error()])
        self.store.append_event(make_event(self.run))

        snapshot = self.store.load_snapshot(RUN_ID)

        self.assertEqual(snapshot.run.to_dict(), self.run.to_dict())
        self.assertEqual(snapshot.repository.to_dict(), self.profile.to_dict())
        self.assertEqual(
            snapshot.candidates[0].candidate_id, self.candidate.candidate_id
        )
        self.assertEqual(snapshot.paths[0].path_id, self.path.path_id)
        self.assertEqual(snapshot.validations[0].verdict, "reachable")
        self.assertEqual(snapshot.events[0].sequence, 1)
        self.assertEqual(
            sorted(path.name for path in run_directory.iterdir()),
            [
                "candidates.json",
                "errors.json",
                "events.jsonl",
                "paths.json",
                "repository.json",
                "run.json",
                "validations.json",
            ],
        )

    def test_cross_run_objects_and_non_contiguous_events_are_rejected(self):
        self.store.create_run(self.run)
        with self.assertRaises(ValueError):
            self.store.save_candidates(RUN_ID, [make_candidate(OTHER_RUN_ID)])

        second = AnalysisEvent(
            event_type="run_started",
            sequence=2,
            run_id=RUN_ID,
            payload={"run": self.run},
        )
        with self.assertRaises(RunStoreError) as caught:
            self.store.append_event(second)
        self.assertEqual(
            caught.exception.error.code, "RUN_STORE_EVENT_SEQUENCE_INVALID"
        )

    def test_corrupt_json_returns_a_structured_storage_error(self):
        run_directory = self.store.create_run(self.run)
        (run_directory / "repository.json").write_text("{broken", encoding="utf-8")

        with self.assertRaises(RunStoreError) as caught:
            self.store.load_repository(RUN_ID)

        self.assertEqual(caught.exception.error.stage, "storage")
        self.assertNotIn(str(self.root), caught.exception.error.to_json())

    def test_saved_json_uses_the_expected_run_envelope(self):
        run_directory = self.store.create_run(self.run)
        self.store.save_repository(self.profile)
        payload = json.loads(
            (run_directory / "repository.json").read_text(encoding="utf-8")
        )
        self.assertEqual(payload["run_id"], RUN_ID)
        self.assertEqual(payload["repository"]["schema_version"], "1.0.0")
