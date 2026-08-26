import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import repoaudit
from protocol import AuditRun, AnalysisEvent
from storage import RunStore
from tests._support import NOT_RUN_REASON, RUN_ID, make_run


LEGACY_ARGS = [
    "--scan-type",
    "dfbscan",
    "--project-path",
    "C:/repo",
    "--language",
    "Python",
    "--model-name",
    "model",
    "--bug-type",
    "NPD",
]


@unittest.skip(NOT_RUN_REASON)
class StagedCliParsingTests(unittest.TestCase):
    def test_each_staged_command_has_an_explicit_purpose_and_jsonl_option(self):
        commands = {
            "inspect": [
                "inspect",
                "--project-path",
                "C:/repo",
                "--language",
                "Python",
                "--output-format",
                "jsonl",
            ],
            "candidates": [
                "candidates",
                "--run-id",
                "run_0123456789abcdef0123456789abcdef",
                "--bug-type",
                "NPD",
            ],
            "analyze": [
                "analyze",
                "--run-id",
                "run_0123456789abcdef0123456789abcdef",
                "--candidate-id",
                "cand_0123456789abcdef01234567",
                "--model-name",
                "model",
            ],
            "validate": [
                "validate",
                "--run-id",
                "run_0123456789abcdef0123456789abcdef",
                "--candidate-id",
                "cand_0123456789abcdef01234567",
                "--path-id",
                "path_0123456789abcdef01234567",
                "--model-name",
                "model",
            ],
            "full-scan": [
                "full-scan",
                "--project-path",
                "C:/repo",
                "--language",
                "Python",
                "--bug-type",
                "NPD",
                "--model-name",
                "model",
            ],
        }

        for expected, arguments in commands.items():
            with self.subTest(command=expected):
                parsed = repoaudit.configure_args(arguments)
                self.assertEqual(parsed.command, expected)
                self.assertEqual(parsed.output_format, "jsonl")

    def test_invalid_ids_return_one_structured_jsonl_error(self):
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = repoaudit.main(
                [
                    "analyze",
                    "--run-id",
                    "../invalid",
                    "--candidate-id",
                    "cand_0123456789abcdef01234567",
                    "--model-name",
                    "model",
                ]
            )

        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(exit_code, 1)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event_type"], "analysis_failed")
        self.assertEqual(records[0]["payload"]["error"]["code"], "INVALID_RUN_ID")
        self.assertNotIn("../invalid", output.getvalue())

    def test_resumed_cli_event_stream_continues_persisted_sequence(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RunStore(Path(directory) / "runs")
            run = make_run("C:/repo")
            store.create_run(run)
            store.append_event(
                AnalysisEvent(
                    event_type="run_started",
                    sequence=1,
                    run_id=RUN_ID,
                    payload={"run": run},
                )
            )

            with redirect_stdout(io.StringIO()):
                with repoaudit._RunEventSession(store, RUN_ID) as writer:
                    writer.emit(
                        "run_completed",
                        RUN_ID,
                        payload={
                            "status": "success_no_findings",
                            "finding_count": 0,
                            "error_count": 0,
                        },
                    )

            self.assertEqual(
                [event.sequence for event in store.load_events(RUN_ID)], [1, 2]
            )


@unittest.skip(NOT_RUN_REASON)
class LegacyCliCompatibilityTests(unittest.TestCase):
    def test_option_based_cli_still_defaults_to_legacy_engine(self):
        args = repoaudit.configure_args(LEGACY_ARGS)
        self.assertFalse(hasattr(args, "command"))
        self.assertEqual(args.dfb_engine, "legacy")

    @patch("repoaudit.run_full_scan")
    @patch("repoaudit.DFBScanAgent")
    @patch("repoaudit.Python_TSAnalyzer")
    def test_legacy_engine_still_calls_dfbscan_agent(
        self, analyzer_type, agent_type, run_full_scan
    ):
        analyzer_type.return_value = Mock()
        args = repoaudit.configure_args(LEGACY_ARGS)

        audit = repoaudit.RepoAudit(args)
        audit.start_repo_auditing()

        agent_type.return_value.start_scan.assert_called_once_with()
        run_full_scan.assert_not_called()

    @patch("repoaudit.run_full_scan")
    @patch("repoaudit.Python_TSAnalyzer")
    def test_legacy_syntax_can_select_staged_engine_without_building_old_analyzer(
        self, analyzer_type, run_full_scan
    ):
        args = repoaudit.configure_args([*LEGACY_ARGS, "--dfb-engine", "staged"])

        repoaudit.RepoAudit(args).start_repo_auditing()

        analyzer_type.assert_not_called()
        run_full_scan.assert_called_once()

    @patch("repoaudit.run_full_scan")
    def test_new_full_scan_command_delegates_to_composed_scan(self, run_full_scan):
        run_full_scan.return_value = AuditRun(
            run_id="run_0123456789abcdef0123456789abcdef",
            repository_root="C:/repo",
            language="Python",
            bug_type="NPD",
            stage="full_scan",
            status="completed",
        )
        exit_code = repoaudit.main(
            [
                "full-scan",
                "--project-path",
                "C:/repo",
                "--language",
                "Python",
                "--bug-type",
                "NPD",
                "--model-name",
                "model",
            ]
        )

        self.assertEqual(exit_code, 0)
        run_full_scan.assert_called_once()
