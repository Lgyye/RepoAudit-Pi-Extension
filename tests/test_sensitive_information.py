import io
import unittest

from agent.dfbscan import _RecordingEventWriter, _ensure_failure_event
from service.validation_service import _invoke_without_sensitive_logs
from tests._support import NOT_RUN_REASON, RUN_ID


class _CaptureLogger:
    def __init__(self):
        self.messages = []

    def print_log(self, *args):
        self.messages.append(" ".join(str(value) for value in args))


class _LeakyValidator:
    def __init__(self, logger, secret):
        self.logger = logger
        self.model = type("Model", (), {"logger": logger})()
        self.secret = secret

    def invoke(self, validator_input, output_type):
        self.logger.print_log("prompt", self.secret)
        self.model.logger.print_log("response", self.secret)
        return None


@unittest.skip(NOT_RUN_REASON)
class SensitiveInformationLeakageTests(unittest.TestCase):
    def test_structured_failure_does_not_include_exception_text_or_secret(self):
        secret = "sk-test-never-publish"
        event_stream = io.StringIO()
        writer = _RecordingEventWriter(event_stream)

        _ensure_failure_event(
            writer,
            RUN_ID,
            RuntimeError(secret),
            "validate",
            code="MODEL_CALL_FAILED",
            message="The configured model call failed.",
        )
        serialized = event_stream.getvalue()

        self.assertNotIn(secret, serialized)
        self.assertNotIn("Traceback", serialized)
        self.assertNotIn("prompt", serialized.lower())

    def test_validator_prompt_and_response_logs_are_suppressed_and_restored(self):
        secret = "raw-model-response"
        logger = _CaptureLogger()
        validator = _LeakyValidator(logger, secret)

        _invoke_without_sensitive_logs(validator, object(), object)

        self.assertEqual(logger.messages, [])
        self.assertIs(validator.logger, logger)
        self.assertIs(validator.model.logger, logger)
