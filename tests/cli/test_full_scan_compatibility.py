import json
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from agent import dfbscan
from protocol import RepositoryProfile
from storage import RunStore
from tests._support import FIXTURES_ROOT, NOT_RUN_REASON, make_candidate


@unittest.skip(NOT_RUN_REASON)
class FullScanCompatibilityTests(unittest.TestCase):
    @patch.object(dfbscan, "PathValidator")
    @patch.object(dfbscan, "IntraDataFlowAnalyzer")
    @patch.object(dfbscan, "extract_candidates", return_value=[])
    @patch.object(dfbscan, "inspect_repository")
    def test_zero_findings_complete_and_write_empty_legacy_result(
        self,
        inspect_repository,
        extract_candidates,
        intra_analyzer,
        path_validator,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = FIXTURES_ROOT / "clean-python"
            result_directory = root / "result"
            log_file = root / "logs" / "dfbscan.log"
            result_directory.mkdir(parents=True)
            inspect_repository.side_effect = lambda *args, **kwargs: RepositoryProfile(
                run_id=kwargs["run_id"],
                repository_root=repository.resolve().as_posix(),
                language="Python",
                source_files=["app.py"],
                file_type_counts={".py": 1},
                function_count=1,
                supported_bug_types=["NPD"],
            )
            intra_analyzer.return_value = Mock()
            path_validator.return_value = Mock()

            with (
                patch.object(
                    dfbscan,
                    "_staged_artifact_paths",
                    return_value=(result_directory, log_file),
                ),
                patch.object(dfbscan, "Logger", return_value=Mock()),
                redirect_stdout(io.StringIO()),
            ):
                run = dfbscan.run_full_scan(
                    str(repository),
                    "Python",
                    "NPD",
                    "model",
                    run_store=RunStore(root / "runs"),
                )

            self.assertEqual(run.status, "completed")
            self.assertEqual(
                json.loads((result_directory / "detect_info.json").read_text()), {}
            )
            extract_candidates.assert_called_once()

    @patch.object(dfbscan, "PathValidator")
    @patch.object(dfbscan, "IntraDataFlowAnalyzer")
    @patch.object(dfbscan, "validate_path")
    @patch.object(dfbscan, "analyze_candidate")
    @patch.object(dfbscan, "extract_candidates")
    @patch.object(dfbscan, "inspect_repository")
    def test_single_candidate_failure_does_not_stop_later_candidates(
        self,
        inspect_repository,
        extract_candidates,
        analyze_candidate,
        validate_path,
        intra_analyzer,
        path_validator,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = FIXTURES_ROOT / "clean-python"
            result_directory = root / "result"
            log_file = root / "logs" / "dfbscan.log"
            result_directory.mkdir(parents=True)
            inspect_repository.side_effect = lambda *args, **kwargs: RepositoryProfile(
                run_id=kwargs["run_id"],
                repository_root=repository.resolve().as_posix(),
                language="Python",
                source_files=["app.py"],
                file_type_counts={".py": 1},
                function_count=1,
                supported_bug_types=["NPD"],
            )

            def candidates_for(profile, *args, **kwargs):
                first = make_candidate(profile.run_id)
                second = replace(first, candidate_id="cand_bbbbbbbbbbbbbbbbbbbbbbbb")
                return [first, second]

            extract_candidates.side_effect = candidates_for
            analyze_candidate.side_effect = [RuntimeError("secret response"), []]
            intra_analyzer.return_value = Mock()
            path_validator.return_value = Mock()

            with (
                patch.object(
                    dfbscan,
                    "_staged_artifact_paths",
                    return_value=(result_directory, log_file),
                ),
                patch.object(dfbscan, "Logger", return_value=Mock()),
                redirect_stdout(io.StringIO()),
            ):
                store = RunStore(root / "runs")
                run = dfbscan.run_full_scan(
                    str(repository),
                    "Python",
                    "NPD",
                    "model",
                    run_store=store,
                )

            self.assertEqual(run.status, "completed")
            self.assertEqual(analyze_candidate.call_count, 2)
            validate_path.assert_not_called()
            errors = store.load_errors(run.run_id)
            self.assertTrue(
                any(error.code == "CANDIDATE_ANALYSIS_FAILED" for error in errors)
            )
            self.assertNotIn(
                "secret response", "".join(error.to_json() for error in errors)
            )
