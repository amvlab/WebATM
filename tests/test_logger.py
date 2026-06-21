"""Tests for WebATM.logger."""

import logging

from WebATM.logger import FileNameFormatter, configure_logging, get_logger


class TestFileNameFormatter:
    def _record(self, pathname, msg, name="WebATM.test"):
        return logging.LogRecord(
            name=name,
            level=logging.INFO,
            pathname=pathname,
            lineno=1,
            msg=msg,
            args=(),
            exc_info=None,
        )

    def test_adds_filename_prefix(self):
        fmt = FileNameFormatter("%(message)s")
        record = self._record("/path/to/main.py", "starting up")
        assert fmt.format(record) == "[Main] starting up"

    def test_underscores_become_titlecase(self):
        fmt = FileNameFormatter("%(message)s")
        record = self._record("/path/to/session_manager.py", "hi")
        assert fmt.format(record) == "[SessionManager] hi"

    def test_werkzeug_special_case(self):
        fmt = FileNameFormatter("%(message)s")
        record = self._record("/whatever.py", "GET /", name="werkzeug")
        assert fmt.format(record) == "[Werkzeug] GET /"


class TestGetLogger:
    def test_returns_logger_instance(self):
        log = get_logger("mymodule")
        assert isinstance(log, logging.Logger)
        assert log.name == "WebATM.mymodule"

    def test_logger_is_cached(self):
        assert get_logger("cachedname") is get_logger("cachedname")

    def test_auto_name_from_caller(self):
        # When no name is given, the caller's filename stem is used.
        log = get_logger()
        assert log.name.startswith("WebATM.")


class TestConfigureLogging:
    def test_sets_level(self):
        configure_logging(level=logging.DEBUG)
        root = logging.getLogger("WebATM")
        assert root.level == logging.DEBUG
        # restore default
        configure_logging(level=logging.INFO)

    def test_writes_to_file(self, tmp_path):
        log_file = tmp_path / "webatm.log"
        configure_logging(level=logging.INFO, log_file=str(log_file))
        root = logging.getLogger("WebATM")
        root.info("hello file")
        for handler in root.handlers:
            handler.flush()
        assert log_file.exists()
        assert "hello file" in log_file.read_text()
        # restore default console-only config
        configure_logging(level=logging.INFO)

    def test_console_only_has_no_file_handler(self):
        configure_logging(level=logging.INFO, include_console=True)
        root = logging.getLogger("WebATM")
        assert any(isinstance(h, logging.StreamHandler) for h in root.handlers)
