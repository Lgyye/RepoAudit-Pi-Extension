"""Public services for staged RepoAudit operations."""

from .candidate_generator import generate_candidates
from .repository_inspector import inspect_repository

__all__ = ["generate_candidates", "inspect_repository"]
