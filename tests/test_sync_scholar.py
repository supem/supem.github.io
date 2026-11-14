"""Regression checks for denied requests, preserved data and published health."""

from copy import deepcopy
from email.message import Message
from http.client import IncompleteRead
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_scholar as sync


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.old = {
            "profile_id": sync.PROFILE_ID,
            "metrics": {"citations": 121, "h_index": 6, "i10_index": 5},
            "papers": [{"id": f"{sync.PROFILE_ID}:paper", "title": "Paper",
                        "authors": "C Mao", "venue": "Journal", "year": 2026,
                        "citations": 121}],
            "updated_at": "2026-11-04T02:28:16+00:00",
        }
        self.fresh = deepcopy(self.old)
        self.fresh["metrics"]["citations"] = 123
        del self.fresh["updated_at"]

    def http_error(self, code):
        return HTTPError(sync.PROFILE_URL, code, "Request failed", Message(), BytesIO())

    @patch.object(sync.time, "sleep")
    @patch.object(sync, "build_opener")
    def test_denials_and_rate_limits_do_not_retry(self, opener, sleep):
        for code in (401, 403, 429):
            with self.subTest(code=code):
                opener.reset_mock()
                opener.return_value.open.side_effect = self.http_error(code)
                with self.assertRaises(sync.SyncError) as raised:
                    sync.fetch(sync.PROFILE_URL, "profile")
                self.assertEqual(raised.exception.code, f"http_{code}")
                self.assertIn("profile", str(raised.exception))
                self.assertEqual(opener.return_value.open.call_count, 1)
                sleep.assert_not_called()

    @patch.object(sync.time, "sleep")
    @patch.object(sync, "build_opener")
    def test_temporary_failure_can_recover(self, opener, sleep):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.read.return_value = b"verified page"
        response.headers.get_content_charset.return_value = "utf-8"
        opener.return_value.open.side_effect = [self.http_error(503),
                                              opener.return_value.open.return_value]
        self.assertEqual(sync.fetch(sync.PROFILE_URL, "profile"), "verified page")
        self.assertEqual(opener.return_value.open.call_count, 2)
        sleep.assert_called_once_with(5)

    @patch.object(sync.time, "sleep")
    @patch.object(sync, "build_opener")
    def test_network_retries_are_bounded(self, opener, sleep):
        opener.return_value.open.side_effect = URLError("offline")
        with self.assertRaises(sync.SyncError) as raised:
            sync.fetch(sync.PROFILE_URL, "profile")
        self.assertEqual(raised.exception.code, "network_error")
        self.assertEqual(opener.return_value.open.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 15])

    @patch.object(sync.time, "sleep")
    @patch.object(sync, "build_opener")
    def test_truncated_response_is_a_network_failure(self, opener, sleep):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.read.side_effect = IncompleteRead(b"partial")
        with self.assertRaises(sync.SyncError) as raised:
            sync.fetch(sync.PROFILE_URL, "profile")
        self.assertEqual(raised.exception.code, "network_error")
        self.assertEqual(opener.return_value.open.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def run_sync(self, directory, error=None, page_source=None):
        output = Path(directory) / "scholar.json"
        output.write_text(json.dumps(self.old), encoding="utf-8")
        original = output.read_bytes()
        page = Path(directory) / "index.html"
        template = ('<head><meta name="scholar-snapshot" content="2026-11-04T02:28:16+00:00"></head>'
                    '<body><span id="citation-total">121</span> citations</body>')
        page.write_text(page_source or template, encoding="utf-8")
        args = ["sync_scholar.py", "--output", str(output), "--update-page", str(page)]
        with patch.object(sys, "argv", args), patch.object(sys, "stderr", StringIO()), \
                patch.object(sys, "stdout", StringIO()), \
                patch.object(sync, "fetch_profile", return_value="html", side_effect=error), \
                patch.object(sync, "parse_profile", return_value=deepcopy(self.fresh)):
            result = sync.main()
        health = json.loads(output.with_name("scholar-status.json").read_text(encoding="utf-8"))
        return result, output, page, health, original

    def test_403_publishes_failure_and_preserves_verified_snapshot(self):
        with TemporaryDirectory() as directory:
            result, output, page, health, original = self.run_sync(
                directory, sync.SyncError("profile request failed (HTTP 403)", "http_403"))
            self.assertEqual(result, 1)
            self.assertEqual(output.read_bytes(), original)
            self.assertIn('>121</span>', page.read_text(encoding="utf-8"))
            self.assertEqual(health["status"], "failure")
            self.assertEqual(health["error_code"], "http_403")
            self.assertEqual(health["last_success_at"], self.old["updated_at"])
            self.assertGreater(health["last_attempt_at"], health["last_success_at"])

    def test_success_updates_visible_count_hidden_timestamp_and_health(self):
        with TemporaryDirectory() as directory:
            result, output, page, health, _ = self.run_sync(directory)
            data = json.loads(output.read_text(encoding="utf-8"))
            html = BeautifulSoup(page.read_text(encoding="utf-8"), "html.parser")
            self.assertEqual(result, 0)
            self.assertEqual(data["metrics"]["citations"], 123)
            self.assertEqual(html.body.get_text(" ", strip=True), "123 citations")
            self.assertEqual(html.head.select_one('meta[name="scholar-snapshot"]')["content"],
                             data["updated_at"])
            self.assertEqual(health["status"], "success")
            self.assertIsNone(health["error_code"])
            self.assertEqual(health["last_success_at"], data["updated_at"])

    def test_unexpected_page_markup_preserves_snapshot(self):
        with TemporaryDirectory() as directory:
            result, output, _, health, original = self.run_sync(directory, page_source="<main />")
            self.assertEqual(result, 1)
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(health["error_code"], "validation_error")

    def test_page_write_failure_rolls_back_snapshot(self):
        original_write = sync.write_text

        def failing_page_write(path, text):
            if path.name == "index.html":
                raise OSError("Page could not be replaced")
            original_write(path, text)

        with TemporaryDirectory() as directory, patch.object(sync, "write_text", side_effect=failing_page_write):
            result, output, page, health, original = self.run_sync(directory)
            self.assertEqual(result, 1)
            self.assertEqual(output.read_bytes(), original)
            self.assertIn('>121</span>', page.read_text(encoding="utf-8"))
            self.assertEqual(health["status"], "failure")
            self.assertEqual(health["error_code"], "storage_error")
            self.assertEqual(health["last_success_at"], self.old["updated_at"])


if __name__ == "__main__":
    unittest.main()
