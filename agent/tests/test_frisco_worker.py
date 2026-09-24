"""Tests for agent/frisco_worker.py.

Run from the repo root:
    uv run --no-project python -m unittest discover -s agent/tests -t . -v

The frisco CLI is never executed: `subprocess.run` inside the loaded module is
replaced by FakeFrisco, which records argv and returns scripted results. The
pantry server is a local ThreadingHTTPServer (see _support.MockServer).
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ._support import MockServer, load_script, no_proxy_patch

TOKEN = "worker-token"


class FakeFrisco:
    """Stand-in for subprocess.run for the `frisco` CLI."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.kwargs: list[dict] = []
        # search term -> (returncode, stdout, stderr); default: no results
        self.search: dict[str, tuple[int, str, str]] = {}
        self.search_default = (0, "[]", "")
        self.cart_result = (0, "", "")

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        self.kwargs.append(kwargs)
        assert argv[0] == "frisco", argv
        if argv[1:3] == ["products", "search"]:
            term = argv[argv.index("--search") + 1]
            rc, out, err = self.search.get(term, self.search_default)
        elif argv[1:3] == ["cart", "add"]:
            rc, out, err = self.cart_result
        else:
            raise AssertionError(f"unexpected frisco call {argv}")
        return subprocess.CompletedProcess(argv, rc, out, err)

    def searches(self) -> list[str]:
        return [c[c.index("--search") + 1] for c in self.calls if c[1:3] == ["products", "search"]]

    def cart_adds(self) -> list[tuple[str, str]]:
        return [
            (c[c.index("--product-id") + 1], c[c.index("--quantity") + 1])
            for c in self.calls
            if c[1:3] == ["cart", "add"]
        ]


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        self.mod = load_script("frisco_worker.py")
        self.tmp = Path(tempfile.mkdtemp(prefix="pantry-worker-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod.JOURNAL_FILE = self.tmp / ".frisco_added.jsonl"
        self.fake = FakeFrisco()
        patcher = mock.patch.object(self.mod.subprocess, "run", self.fake)
        # mod.subprocess is the real subprocess module; patch only while testing.
        patcher.start()
        self.addCleanup(patcher.stop)

        proxy = no_proxy_patch()
        proxy.start()
        self.addCleanup(proxy.stop)

        self.out = io.StringIO()
        cm = contextlib.redirect_stdout(self.out)
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)

    def search_returns(self, name, payload, rc=0, stderr=""):
        stdout = payload if isinstance(payload, str) else json.dumps(payload)
        self.fake.search[self.mod.search_term(name)] = (rc, stdout, stderr)


class FindProductTests(WorkerTestCase):
    def test_invokes_cli_with_json_format_and_cleaned_term(self):
        self.search_returns("Passata pomidorowa 500 g", [{"productId": 1, "name": "P"}])
        self.mod.find_product("Passata pomidorowa 500 g")
        call = self.fake.calls[0]
        self.assertEqual(
            call, ["frisco", "products", "search", "--search", "Passata pomidorowa", "--format", "json"]
        )
        self.assertEqual(self.fake.kwargs[0].get("check"), False)
        self.assertIn("timeout", self.fake.kwargs[0])

    def test_handles_list_and_products_wrapper_and_id_keys(self):
        shapes = {
            "list/productId": [{"productId": 11, "name": "A"}],
            "list/id": [{"id": "22", "name": "B"}],
            "list/product_id": [{"product_id": 33, "productName": "C"}],
            "wrapper/productId": {"products": [{"productId": 44, "name": "D"}]},
            "wrapper/id": {"products": [{"id": 55, "name": "E"}, {"id": 99, "name": "Z"}]},
            "wrapper/product_id": {"products": [{"product_id": "66"}]},
        }
        expected = {
            "list/productId": {"id": "11", "name": "A"},
            "list/id": {"id": "22", "name": "B"},
            "list/product_id": {"id": "33", "name": "C"},
            "wrapper/productId": {"id": "44", "name": "D"},
            "wrapper/id": {"id": "55", "name": "E"},  # first result wins
            "wrapper/product_id": {"id": "66", "name": ""},
        }
        for label, payload in shapes.items():
            with self.subTest(shape=label):
                self.search_returns("Milk", payload)
                self.assertEqual(self.mod.find_product("Milk"), expected[label])

    def test_key_precedence_prefers_productId(self):
        self.search_returns("Milk", [{"productId": 1, "id": 2, "product_id": 3, "name": "M"}])
        self.assertEqual(self.mod.find_product("Milk")["id"], "1")

    def test_returns_none_for_empty_missing_id_or_non_json(self):
        cases = {
            "empty list": [],
            "empty wrapper": {"products": []},
            "wrapper without products": {"other": 1},
            "no id keys": [{"name": "nameless"}],
        }
        for label, payload in cases.items():
            with self.subTest(case=label):
                self.search_returns("Milk", payload)
                self.assertIsNone(self.mod.find_product("Milk"))

    def test_non_json_output_raises_so_it_is_not_mistaken_for_no_match(self):
        # Older builds print a table instead of JSON; that is a broken search.
        self.search_returns("Milk", "ID  NAME\n1   Milk\n")
        with self.assertRaisesRegex(RuntimeError, "JSON"):
            self.mod.find_product("Milk")

    def test_nonzero_exit_raises_with_stderr(self):
        self.search_returns("Milk", "", rc=1, stderr="session expired\n")
        with self.assertRaisesRegex(RuntimeError, "session expired"):
            self.mod.find_product("Milk")

    def test_search_term_strips_units_numbers_and_caps_at_four_words(self):
        st = self.mod.search_term
        self.assertEqual(st("Passata pomidorowa Łowicz 500 g"), "Passata pomidorowa Łowicz")
        self.assertEqual(st("Mleko 3,2% 1 l"), "Mleko 3,2%")
        self.assertEqual(st("a b c d e f"), "a b c d")
        self.assertEqual(st("500 g"), "500 g")  # nothing left -> original name

    def test_is_unnamed(self):
        self.assertTrue(self.mod.is_unnamed("Unknown item 5901234123457"))
        self.assertTrue(self.mod.is_unnamed("  unknown ITEM"))
        self.assertFalse(self.mod.is_unnamed("Known item"))


class QueueTestCase(WorkerTestCase):
    def setUp(self):
        super().setUp()
        self.server = MockServer(default=(200, {"ok": True}))
        self.server.__enter__()
        self.addCleanup(self.server.__exit__, None, None, None)

    def queue(self, *items):
        self.server.script("GET", "/api/queue", (200, {"ok": True, "items": list(items)}))

    def run_once(self, dry_run=False):
        return self.mod.run_once(self.server.url, TOKEN, dry_run)

    def reports(self):
        return self.server.bodies("POST", "/api/queue")

    @staticmethod
    def item(id_, name, qty=1, barcode="590"):
        return {"id": id_, "ts": "2026-09-24T10:00:00Z", "barcode": barcode, "name": name, "qty": qty}


class RunOnceTests(QueueTestCase):
    def test_fetch_queue_is_authenticated_get(self):
        self.queue(self.item(1, "Milk"))
        self.assertEqual(self.mod.fetch_queue(self.server.url, TOKEN)[0]["id"], 1)
        req = self.server.requests[0]
        self.assertEqual((req["method"], req["path"]), ("GET", "/api/queue"))
        self.assertEqual(req["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertIsNone(req["json"])

    def test_empty_queue_does_nothing(self):
        self.queue()
        self.assertEqual(self.run_once(), 0)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.reports(), [])

    def test_unnamed_items_are_skipped_not_searched_not_reported(self):
        self.queue(self.item(1, "Unknown item 5901234123457"), self.item(2, "unknown item"))
        self.assertEqual(self.run_once(), 0)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.reports(), [])
        self.assertIn("still unnamed", self.out.getvalue())

    def test_success_adds_to_cart_and_reports_done(self):
        self.queue(self.item(7, "Mleko 3,2% 1 l", qty=3))
        self.search_returns("Mleko 3,2% 1 l", {"products": [{"productId": 123, "name": "Mleko"}]})
        self.assertEqual(self.run_once(), 1)
        self.assertEqual(self.fake.cart_adds(), [("123", "3")])
        self.assertEqual(
            self.reports(),
            [{"id": 7, "status": "done", "friscoProductId": "123", "friscoProductName": "Mleko"}],
        )
        post = [r for r in self.server.requests if r["method"] == "POST"][0]
        self.assertEqual(post["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(post["headers"]["Content-Type"], "application/json")

    def test_report_posts_id_and_status_with_extras(self):
        self.mod.report(self.server.url, TOKEN, 42, "pending", note="x")
        self.assertEqual(self.reports(), [{"id": 42, "status": "pending", "note": "x"}])

    def test_cart_add_failure_reports_failed(self):
        self.queue(self.item(8, "Milk"))
        self.search_returns("Milk", [{"id": 5, "name": "Milk"}])
        self.fake.cart_result = (2, "", "out of stock\n")
        self.assertEqual(self.run_once(), 0)
        self.assertEqual(self.reports(), [{"id": 8, "status": "failed", "note": "out of stock"}])

    def test_failed_note_is_truncated_to_200_chars(self):
        self.queue(self.item(8, "Milk"))
        self.search_returns("Milk", [{"id": 5, "name": "Milk"}])
        self.fake.cart_result = (2, "", "E" * 500)
        self.run_once()
        self.assertEqual(len(self.reports()[0]["note"]), 200)

    def test_no_match_reports_pending_with_note(self):
        self.queue(self.item(9, "Obscure thing 200 g"))
        self.assertEqual(self.run_once(), 0)
        self.assertEqual(self.fake.cart_adds(), [])
        self.assertEqual(
            self.reports(),
            [{"id": 9, "status": "pending", "note": "no match for 'Obscure thing'"}],
        )

    def test_search_cli_failure_reports_pending_with_note_and_continues(self):
        self.queue(self.item(10, "Milk"), self.item(11, "Bread"))
        self.search_returns("Milk", "", rc=1, stderr="boom")
        self.search_returns("Bread", [{"id": 3, "name": "Bread"}])
        self.assertEqual(self.run_once(), 1)
        self.assertEqual(
            self.reports(),
            [
                {"id": 10, "status": "pending", "note": "search failed: boom"},
                {"id": 11, "status": "done", "friscoProductId": "3", "friscoProductName": "Bread"},
            ],
        )
        self.assertEqual(self.fake.cart_adds(), [("3", "1")])
        self.assertIn("search failed -- boom", self.out.getvalue())

    def test_cli_not_installed_is_reported_as_search_failure(self):
        self.queue(self.item(12, "Milk"))
        with mock.patch.object(self.mod.subprocess, "run", side_effect=FileNotFoundError("frisco")):
            self.assertEqual(self.run_once(), 0)
        self.assertEqual(self.reports(), [{"id": 12, "status": "pending", "note": "search failed: frisco"}])

    def test_non_json_search_output_is_a_search_failure_not_no_match(self):
        self.queue(self.item(13, "Milk"))
        self.search_returns("Milk", "ID  NAME\n1   Milk\n")
        self.assertEqual(self.run_once(), 0)
        [report] = self.reports()
        self.assertEqual((report["id"], report["status"]), (13, "pending"))
        self.assertTrue(report["note"].startswith("search failed: "), report["note"])
        self.assertNotIn("no match", report["note"])
        self.assertEqual(self.fake.cart_adds(), [])

    def test_search_failure_note_is_truncated_to_200_chars(self):
        self.queue(self.item(14, "Milk"))
        self.search_returns("Milk", "", rc=1, stderr="E" * 500)
        self.run_once()
        self.assertEqual(len(self.reports()[0]["note"]), 200)

    def test_search_failure_in_dry_run_reports_nothing(self):
        self.queue(self.item(15, "Milk"))
        self.search_returns("Milk", "", rc=1, stderr="boom")
        self.assertEqual(self.run_once(dry_run=True), 0)
        self.assertEqual(self.reports(), [])

    def test_dry_run_adds_nothing_and_reports_nothing(self):
        self.queue(
            self.item(1, "Milk"),
            self.item(2, "Nothing matches"),
            self.item(3, "Unknown item 1"),
        )
        self.search_returns("Milk", [{"productId": 77, "name": "Milk 1l"}])
        self.assertEqual(self.run_once(dry_run=True), 0)
        self.assertEqual(self.fake.cart_adds(), [])
        self.assertEqual(self.reports(), [])
        self.assertEqual(self.fake.searches(), ["Milk", "Nothing matches"])
        self.assertIn("Milk 1l (id 77)", self.out.getvalue())


class JournalTests(QueueTestCase):
    """A cart add that succeeded must never be repeated, even if reporting it fails."""

    def journal(self) -> list[dict]:
        path = self.mod.JOURNAL_FILE
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line]

    def write_journal(self, *entries):
        self.mod.JOURNAL_FILE.write_text(
            "".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8"
        )

    ENTRY = {"id": 7, "frisco_product_id": "123", "frisco_product_name": "Mleko", "qty": 3, "ts": 1.0}

    def test_success_leaves_no_journal_behind(self):
        self.queue(self.item(7, "Milk", qty=3))
        self.search_returns("Milk", [{"productId": 123, "name": "Mleko"}])
        self.assertEqual(self.run_once(), 1)
        self.assertFalse(self.mod.JOURNAL_FILE.exists())

    def test_report_failure_after_add_is_journaled_and_stops_the_pass(self):
        self.queue(self.item(7, "Milk", qty=3), self.item(8, "Bread"))
        self.search_returns("Milk", [{"productId": 123, "name": "Mleko"}])
        self.search_returns("Bread", [{"productId": 456, "name": "Chleb"}])
        self.server.script("POST", "/api/queue", (503, {"ok": False}))
        with self.assertRaises(Exception):
            self.run_once()
        self.assertEqual(self.fake.cart_adds(), [("123", "3")])  # Bread never attempted
        [entry] = self.journal()
        self.assertEqual(
            {k: entry[k] for k in ("id", "frisco_product_id", "qty")},
            {"id": 7, "frisco_product_id": "123", "qty": 3},
        )
        self.assertIsInstance(entry["ts"], (int, float))

    def test_next_pass_resends_done_and_never_adds_again(self):
        # Pass 1: added, report lost.
        self.queue(self.item(7, "Milk", qty=3))
        self.search_returns("Milk", [{"productId": 123, "name": "Mleko"}])
        self.server.script("POST", "/api/queue", (503, {"ok": False}))
        with self.assertRaises(Exception):
            self.run_once()
        # Pass 2: server healthy; even if it still lists item 7, it is not re-added.
        self.queue(self.item(7, "Milk", qty=3), self.item(8, "Bread"))
        self.search_returns("Bread", [{"productId": 456, "name": "Chleb"}])
        self.assertEqual(self.run_once(), 1)
        self.assertEqual(self.fake.cart_adds(), [("123", "3"), ("456", "1")])
        self.assertEqual(
            self.reports()[1:],
            [
                {"id": 7, "status": "done", "friscoProductId": "123", "friscoProductName": "Mleko"},
                {"id": 8, "status": "done", "friscoProductId": "456", "friscoProductName": "Chleb"},
            ],
        )
        self.assertEqual(self.journal(), [])

    def test_resend_happens_before_the_queue_is_fetched(self):
        self.write_journal(self.ENTRY)
        self.queue()
        self.run_once()
        self.assertEqual(
            [(r["method"], r["path"]) for r in self.server.requests],
            [("POST", "/api/queue"), ("GET", "/api/queue")],
        )

    def test_resend_failure_stops_the_pass_and_keeps_the_journal(self):
        self.write_journal(self.ENTRY)
        self.queue(self.item(7, "Milk", qty=3))
        self.server.script("POST", "/api/queue", (503, {"ok": False}))
        with self.assertRaises(Exception):
            self.run_once()
        self.assertEqual(self.fake.calls, [])
        self.assertEqual([e["id"] for e in self.journal()], [7])

    def test_resend_for_item_gone_from_server_is_forgotten(self):
        self.write_journal(self.ENTRY, {**self.ENTRY, "id": 9})
        self.server.script("POST", "/api/queue", (404, {"ok": False, "error": "No such item"}))
        self.queue()
        self.run_once()
        self.assertEqual([r["id"] for r in self.reports()], [7, 9])
        self.assertEqual(self.journal(), [])

    def test_dry_run_neither_writes_nor_resends_the_journal_and_skips_journaled(self):
        self.write_journal(self.ENTRY)
        self.queue(self.item(7, "Milk", qty=3), self.item(8, "Bread"))
        self.search_returns("Bread", [{"productId": 456, "name": "Chleb"}])
        self.run_once(dry_run=True)
        self.assertEqual(self.reports(), [])
        self.assertEqual(self.fake.searches(), ["Bread"])
        self.assertEqual(self.journal(), [self.ENTRY])

    def test_dry_run_does_not_create_a_journal(self):
        self.queue(self.item(8, "Bread"))
        self.search_returns("Bread", [{"productId": 456, "name": "Chleb"}])
        self.run_once(dry_run=True)
        self.assertFalse(self.mod.JOURNAL_FILE.exists())

    def test_unreadable_journal_refuses_to_run_rather_than_risk_a_double_add(self):
        self.mod.JOURNAL_FILE.write_text('{"id": 7, "frisco_prod\n', encoding="utf-8")
        self.queue(self.item(7, "Milk"))
        self.search_returns("Milk", [{"productId": 123, "name": "Mleko"}])
        with self.assertRaisesRegex(RuntimeError, ".frisco_added.jsonl"):
            self.run_once()
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.server.requests, [])


class MainTests(WorkerTestCase):
    def test_exits_when_frisco_not_on_path(self):
        with mock.patch.object(self.mod.shutil, "which", return_value=None), mock.patch(
            "sys.argv", ["frisco_worker.py"]
        ):
            with self.assertRaises(SystemExit) as ctx:
                self.mod.main()
        self.assertIn("frisco", str(ctx.exception.code))
        self.assertEqual(self.fake.calls, [])

    def test_main_dry_run_reads_env_and_touches_nothing(self):
        tmp = Path(tempfile.mkdtemp(prefix="pantry-worker-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.mod.HERE = tmp  # no .env here; config comes from the environment
        with MockServer() as server:
            server.script(
                "GET",
                "/api/queue",
                (200, {"ok": True, "items": [{"id": 1, "ts": "", "barcode": "", "name": "Milk", "qty": 2}]}),
            )
            self.search_returns("Milk", [{"id": 5, "name": "Milk"}])
            env = {"PANTRY_SERVER_URL": server.url + "/", "SCANNER_TOKEN": TOKEN}
            with mock.patch.object(self.mod.shutil, "which", return_value="/bin/frisco"), mock.patch(
                "sys.argv", ["frisco_worker.py", "--dry-run"]
            ), mock.patch.dict("os.environ", env):
                self.mod.main()
            self.assertEqual([r["method"] for r in server.requests], ["GET"])
        self.assertEqual(self.fake.cart_adds(), [])


if __name__ == "__main__":
    unittest.main()
