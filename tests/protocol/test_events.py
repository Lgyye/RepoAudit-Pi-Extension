import io
import json
import threading
import unittest

from protocol import EventWriter
from tests._support import NOT_RUN_REASON, RUN_ID, make_run


@unittest.skip(NOT_RUN_REASON)
class JsonlEventWriterTests(unittest.TestCase):
    def test_events_are_single_line_json_with_contiguous_sequence(self):
        event_stream = io.StringIO()
        log_stream = io.StringIO()
        writer = EventWriter(event_stream=event_stream, log_stream=log_stream)
        run = make_run("C:/repo")

        writer.emit("run_started", RUN_ID, payload={"run": run})
        writer.write_log("ordinary diagnostic")
        writer.emit(
            "run_completed",
            RUN_ID,
            payload={
                "status": "success_no_findings",
                "finding_count": 0,
                "error_count": 0,
            },
        )

        records = [json.loads(line) for line in event_stream.getvalue().splitlines()]
        self.assertEqual([record["sequence"] for record in records], [1, 2])
        self.assertTrue(
            all("\n" not in line for line in event_stream.getvalue().splitlines())
        )
        self.assertNotIn("ordinary diagnostic", event_stream.getvalue())
        self.assertIn("ordinary diagnostic", log_stream.getvalue())

    def test_invalid_or_oversized_events_degrade_to_analysis_failed(self):
        stream = io.StringIO()
        writer = EventWriter(
            event_stream=stream, log_stream=io.StringIO(), max_event_bytes=1024
        )

        invalid = writer.emit("unknown_event", RUN_ID)
        oversized = writer.emit(
            "run_completed",
            RUN_ID,
            payload={
                "status": "success_no_findings",
                "finding_count": 0,
                "error_count": 0,
                "padding": "x" * 2048,
            },
        )

        self.assertEqual(invalid.event_type, "analysis_failed")
        self.assertEqual(oversized.event_type, "analysis_failed")
        self.assertEqual(oversized.payload["error"].code, "EVENT_SIZE_LIMIT_EXCEEDED")

    def test_concurrent_emission_never_duplicates_a_sequence(self):
        stream = io.StringIO()
        writer = EventWriter(event_stream=stream, log_stream=io.StringIO())
        run = make_run("C:/repo")
        threads = [
            threading.Thread(
                target=writer.emit,
                args=("run_started", RUN_ID),
                kwargs={"payload": {"run": run}},
            )
            for _ in range(8)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        records = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([record["sequence"] for record in records], list(range(1, 9)))
