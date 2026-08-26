"""Shared public-contract fixtures for the dormant TASK-011 test suite."""

from pathlib import Path
from typing import Optional

from protocol import (
    AnalysisEvent,
    AuditCandidate,
    AuditRun,
    DataFlowPath,
    DataFlowStep,
    RepositoryProfile,
    SourceLocation,
    SourceSinkPair,
    StructuredError,
    ValidationResult,
    make_candidate_id,
    make_path_id,
)


NOT_RUN_REASON = "NOT RUN: execution is deferred until the test environment is restored"
RUN_ID = "run_0123456789abcdef0123456789abcdef"
OTHER_RUN_ID = "run_fedcba9876543210fedcba9876543210"
FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"


def make_pair() -> SourceSinkPair:
    return SourceSinkPair(
        source=SourceLocation("app.py", 2, start_column=13),
        sink=SourceLocation("app.py", 3, start_column=12),
        source_symbol="None",
        sink_symbol="account",
        relation="must_not_reach",
    )


def make_candidate(run_id: str = RUN_ID) -> AuditCandidate:
    pair = make_pair()
    return AuditCandidate(
        run_id=run_id,
        candidate_id=make_candidate_id(
            run_id,
            "NPD",
            pair,
            source_function="vulnerable_lookup",
            sink_function="vulnerable_lookup",
        ),
        bug_type="NPD",
        source_sink_pair=pair,
        source_function="vulnerable_lookup",
        sink_function="vulnerable_lookup",
        reason_codes=["NULL_SOURCE_EXTRACTED", "DEREFERENCE_SINK_EXTRACTED"],
    )


def make_steps() -> list[DataFlowStep]:
    return [
        DataFlowStep(
            step_index=1,
            kind="source",
            location=SourceLocation("app.py", 2, start_column=13),
            function_name="vulnerable_lookup",
            value="None",
            description="Candidate source selected for analysis.",
        ),
        DataFlowStep(
            step_index=2,
            kind="sink",
            location=SourceLocation("app.py", 3, start_column=12),
            function_name="vulnerable_lookup",
            value="account",
            description="The source reaches the selected sink.",
        ),
    ]


def make_path(
    run_id: str = RUN_ID,
    candidate: Optional[AuditCandidate] = None,
    *,
    status: str = "complete",
) -> DataFlowPath:
    selected = make_candidate(run_id) if candidate is None else candidate
    steps = make_steps()
    return DataFlowPath(
        run_id=run_id,
        candidate_id=selected.candidate_id,
        path_id=make_path_id(run_id, selected.candidate_id, steps),
        steps=steps,
        status=status,
        reason_codes=["SOURCE_REACHES_SINK"],
    )


def make_run(repository_root: str, run_id: str = RUN_ID) -> AuditRun:
    return AuditRun(
        run_id=run_id,
        repository_root=repository_root,
        language="Python",
        bug_type="NPD",
        stage="analyze",
        status="running",
    )


def make_profile(repository_root: str, run_id: str = RUN_ID) -> RepositoryProfile:
    return RepositoryProfile(
        run_id=run_id,
        repository_root=repository_root,
        language="Python",
        source_files=["app.py"],
        file_type_counts={".py": 1},
        function_count=1,
        call_relation_count=0,
        supported_bug_types=["NPD"],
    )


def make_validation(
    run_id: str = RUN_ID,
    candidate: Optional[AuditCandidate] = None,
    path: Optional[DataFlowPath] = None,
) -> ValidationResult:
    selected_candidate = make_candidate(run_id) if candidate is None else candidate
    selected_path = make_path(run_id, selected_candidate) if path is None else path
    return ValidationResult(
        run_id=run_id,
        candidate_id=selected_candidate.candidate_id,
        path_id=selected_path.path_id,
        verdict="reachable",
        summary="The validator reported the selected path as reachable.",
        reason_codes=["PATH_VALIDATOR_REACHABLE"],
        evidence=["app.py:2 -> app.py:3"],
        validator="PathValidator",
    )


def make_error(run_id: str = RUN_ID) -> StructuredError:
    return StructuredError(
        code="TEST_ERROR",
        message="A safe test failure.",
        stage="test",
        run_id=run_id,
        details={"secret_included": False},
    )


def make_event(run: AuditRun) -> AnalysisEvent:
    return AnalysisEvent(
        event_type="run_started",
        sequence=1,
        run_id=run.run_id,
        payload={"run": run},
    )
