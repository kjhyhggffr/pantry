"""Tests for agent/scanner_listener.py.

Run from the repo root:
    uv run --no-project python -m unittest discover -s agent/tests -t . -v

The script keeps its state/outbox next to itself (HERE / ".scanner_*"). The
in-process tests patch the module-level STATE_FILE / OUTBOX_FILE / HERE into a
temp dir; the end-to-end tests copy the script into a temp dir and run it as a
real subprocess, so its HERE *is* the temp dir.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ._support import AGENT_DIR, NO_PROXY_ENV, MockServer, load_script, no_proxy_patch, unused_port

TOKEN = "test-token-123"


class ListenerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pantry-listener-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.mod = self.fresh_module()

        proxy = no_proxy_patch()
        proxy.start()
        self.addCleanup(proxy.stop)

        self.server = MockServer(default=(200, {"ok": True, "name": "Milk", "qty": 1}))
        self.server.__enter__()
        self.addCleanup(self.server.__exit__, None, None, None)

        # Quiet the script's banners/progress output.
        for redirect in (contextlib.redirect_stdout, contextlib.redirect_stderr):
            cm = redirect(io.StringIO())
            cm.__enter__()
            self.addCleanup(cm.__exit__, None, None, None)

    def fresh_module(self):
        """A newly imported listener pointed at the temp dir (simulates a restart)."""
        mod = load_script("scanner_listener.py")
        mod.HERE = self.tmp
        mod.STATE_FILE = self.tmp / ".scanner_state.json"
        mod.OUTBOX_FILE = self.tmp / ".scanner_outbox.jsonl"
        mod.REJECTED_FILE = self.tmp / ".scanner_outbox.rejected.jsonl"
        return mod

    # helpers
    def scan(self, code, mode="in", url=None):
        return self.mod.handle_code(code, mode, url or self.server.url, TOKEN)

    def outbox(self) -> list[dict]:
        if not self.mod.OUTBOX_FILE.exists():
            return []
        text = self.mod.OUTBOX_FILE.read_text("utf-8")
        return [json.loads(line) for line in text.splitlines() if line]

    def write_outbox(self, entries):
        self.mod.OUTBOX_FILE.write_text(
            "".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8"
        )

    def rejected(self) -> list[str]:
        if not self.mod.REJECTED_FILE.exists():
            return []
        return self.mod.REJECTED_FILE.read_text("utf-8").splitlines()

    def state(self) -> dict:
        return json.loads(self.mod.STATE_FILE.read_text())


class ModeSwitchTests(ListenerTestCase):
    def test_mode_out_code_switches_persists_and_is_not_posted(self):
        self.assertEqual(self.scan("!!MODE:OUT!!", "in"), "out")
        self.assertEqual(self.state()["mode"], "out")
        self.assertEqual(self.server.requests, [])

    def test_mode_in_code_switches_back(self):
        self.scan("!!MODE:OUT!!", "in")
        self.assertEqual(self.scan("!!MODE:IN!!", "out"), "in")
        self.assertEqual(self.state()["mode"], "in")
        self.assertEqual(self.server.requests, [])

    def test_control_codes_are_case_insensitive_and_trimmed(self):
        self.assertEqual(self.scan("  !!mode:out!!\n", "in"), "out")
        self.assertEqual(self.state()["mode"], "out")
        self.assertEqual(self.server.requests, [])

    def test_blank_line_is_ignored(self):
        self.assertEqual(self.scan("   \n", "out"), "out")
        self.assertEqual(self.server.requests, [])
        self.assertFalse(self.mod.STATE_FILE.exists())

    def test_read_mode_defaults_to_in_when_missing_or_corrupt(self):
        self.assertEqual(self.mod.read_mode(), "in")
        self.mod.STATE_FILE.write_text("{not json")
        self.assertEqual(self.mod.read_mode(), "in")

    def test_mode_survives_restart(self):
        self.scan("!!MODE:OUT!!", "in")
        self.mod = self.fresh_module()  # new module object, state re-read from disk
        self.assertEqual(self.mod.read_mode(), "out")
        self.scan("5901234123457", self.mod.read_mode())
        self.assertEqual(self.server.bodies()[-1]["mode"], "out")


class ProductScanTests(ListenerTestCase):
    def test_product_scan_carries_mode_and_bearer_token(self):
        for mode in ("in", "out"):
            with self.subTest(mode=mode):
                self.assertEqual(self.scan("5901234123457\n", mode), mode)
                req = self.server.requests[-1]
                self.assertEqual(req["method"], "POST")
                self.assertEqual(req["path"], "/api/scan")
                self.assertEqual(req["headers"]["Authorization"], f"Bearer {TOKEN}")
                self.assertEqual(req["headers"]["Content-Type"], "application/json")
                self.assertEqual(
                    req["json"], {"code": "5901234123457", "mode": mode, "source": "scanner"}
                )
        self.assertEqual(self.outbox(), [])

    def test_undo_is_posted_with_current_mode_and_keeps_mode(self):
        self.scan("!!MODE:OUT!!", "in")
        before = self.mod.STATE_FILE.read_text()
        self.server.script("POST", "/api/scan", (200, {"ok": True, "undone": True}))
        self.assertEqual(self.scan("!!MODE:UNDO!!", "out"), "out")
        self.assertEqual(
            self.server.bodies(),
            [{"code": "!!MODE:UNDO!!", "mode": "out", "source": "scanner"}],
        )
        self.assertEqual(self.mod.STATE_FILE.read_text(), before)

    def test_undo_failure_is_not_spooled(self):
        # Actual behaviour: an undo that fails is reported, never replayed later.
        self.server.script("POST", "/api/scan", (503, {"ok": False}))
        self.assertEqual(self.scan("!!MODE:UNDO!!", "in"), "in")
        self.assertEqual(self.outbox(), [])

    def test_connection_refused_is_spooled(self):
        dead = f"http://127.0.0.1:{unused_port()}"
        self.assertEqual(self.scan("111", "out", url=dead), "out")
        spooled = self.outbox()
        self.assertEqual(len(spooled), 1)
        self.assertEqual((spooled[0]["code"], spooled[0]["mode"]), ("111", "out"))
        self.assertIn("ts", spooled[0])

    def test_5xx_is_spooled(self):
        for status in (500, 503):
            with self.subTest(status=status):
                self.server.script("POST", "/api/scan", (status, {"ok": False}))
                self.scan(f"code-{status}", "in")
        self.assertEqual([e["code"] for e in self.outbox()], ["code-500", "code-503"])

    def test_4xx_is_not_spooled(self):
        for status in (400, 401):
            with self.subTest(status=status):
                self.server.script("POST", "/api/scan", (status, {"ok": False}))
                self.assertEqual(self.scan(f"code-{status}", "in"), "in")
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.outbox(), [])

    def test_ok_false_response_is_not_spooled(self):
        self.server.script("POST", "/api/scan", (200, {"ok": False, "error": "nope"}))
        self.scan("222", "in")
        self.assertEqual(self.outbox(), [])


class OutboxReplayTests(ListenerTestCase):
    ENTRIES = [
        {"code": "A", "mode": "in", "ts": 1},
        {"code": "B", "mode": "out", "ts": 2},
        {"code": "C", "mode": "in", "ts": 3},
    ]

    def drain(self, url=None):
        self.mod.drain_outbox(url or self.server.url, TOKEN)

    def test_replays_in_order_and_clears_outbox(self):
        self.write_outbox(self.ENTRIES)
        self.drain()
        self.assertEqual(
            [(b["code"], b["mode"]) for b in self.server.bodies()],
            [("A", "in"), ("B", "out"), ("C", "in")],
        )
        for req in self.server.requests:
            self.assertEqual(req["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertFalse(self.mod.OUTBOX_FILE.exists())

    def test_entry_without_mode_is_quarantined_not_guessed(self):
        # spool() always writes a mode; a line without one is not ours, and
        # guessing "in" could silently turn a CART OUT scan into a restock.
        self.write_outbox([{"code": "X"}, {"code": "Y", "mode": "out"}])
        self.drain()
        self.assertEqual([b["code"] for b in self.server.bodies()], ["Y"])
        self.assertEqual(self.rejected(), [json.dumps({"code": "X"})])
        self.assertFalse(self.mod.OUTBOX_FILE.exists())

    def test_5xx_mid_replay_stops_and_keeps_remaining_in_order(self):
        self.write_outbox(self.ENTRIES)
        self.server.script("POST", "/api/scan", (200, {"ok": True}), (503, {"ok": False}))
        self.drain()
        # A delivered; B failed -> replay stopped, C never attempted.
        self.assertEqual([b["code"] for b in self.server.bodies()], ["A", "B"])
        self.assertEqual([e["code"] for e in self.outbox()], ["B", "C"])

    def test_server_down_keeps_whole_outbox(self):
        self.write_outbox(self.ENTRIES)
        self.drain(url=f"http://127.0.0.1:{unused_port()}")
        self.assertEqual([e["code"] for e in self.outbox()], ["A", "B", "C"])

    def test_4xx_during_replay_is_discarded_and_replay_continues(self):
        self.write_outbox(self.ENTRIES)
        self.server.script("POST", "/api/scan", (200, {"ok": True}), (401, {"ok": False}))
        self.drain()
        self.assertEqual([b["code"] for b in self.server.bodies()], ["A", "B", "C"])
        self.assertFalse(self.mod.OUTBOX_FILE.exists())

    def test_empty_outbox_file_is_removed_without_requests(self):
        self.mod.OUTBOX_FILE.write_text("\n\n", encoding="utf-8")
        self.drain()
        self.assertFalse(self.mod.OUTBOX_FILE.exists())
        self.assertEqual(self.server.requests, [])

    def test_malformed_lines_are_quarantined_and_replay_continues(self):
        bad = [
            "{truncated",
            json.dumps({"mode": "in"}),  # no code
            json.dumps({"code": "", "mode": "in"}),  # empty code
            json.dumps({"code": "D", "mode": "sideways"}),  # unknown mode
            json.dumps(["not", "an", "object"]),
            "42",
        ]
        lines = [json.dumps({"code": "A", "mode": "in"}), *bad, json.dumps({"code": "C", "mode": "out"})]
        self.mod.OUTBOX_FILE.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        self.drain()
        self.assertEqual(
            [(b["code"], b["mode"]) for b in self.server.bodies()], [("A", "in"), ("C", "out")]
        )
        self.assertFalse(self.mod.OUTBOX_FILE.exists())
        self.assertEqual(self.rejected(), bad)

    def test_quarantine_appends_across_drains(self):
        self.mod.OUTBOX_FILE.write_text("{one\n", encoding="utf-8")
        self.drain()
        self.mod.OUTBOX_FILE.write_text("{two\n", encoding="utf-8")
        self.drain()
        self.assertEqual(self.rejected(), ["{one", "{two"])
        self.assertEqual(self.server.requests, [])

    def test_malformed_line_behind_a_down_server_stays_spooled_in_order(self):
        # Quarantine only happens for lines the replay actually reaches.
        self.mod.OUTBOX_FILE.write_text(
            json.dumps({"code": "A", "mode": "in"}) + "\n{truncated\n", encoding="utf-8"
        )
        self.drain(url=f"http://127.0.0.1:{unused_port()}")
        self.assertEqual(
            self.mod.OUTBOX_FILE.read_text("utf-8").splitlines(),
            [json.dumps({"code": "A", "mode": "in"}), "{truncated"],
        )
        self.assertEqual(self.rejected(), [])


class EndToEndProcessTests(unittest.TestCase):
    """Run the real script (a copy in a temp dir) as a subprocess via stdin mode."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pantry-listener-e2e-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shutil.copy2(AGENT_DIR / "scanner_listener.py", self.tmp / "scanner_listener.py")
        self.server = MockServer(default=(200, {"ok": True, "name": "Milk", "qty": 1}))
        self.server.__enter__()
        self.addCleanup(self.server.__exit__, None, None, None)

    def run_listener(self, stdin: str, env_overrides=None):
        env = {
            k: v for k, v in os.environ.items() if k not in ("PANTRY_SERVER_URL", "SCANNER_TOKEN")
        }
        env.update(NO_PROXY_ENV)
        env.update(
            {
                "PANTRY_SERVER_URL": self.server.url + "/",
                "SCANNER_TOKEN": TOKEN,
                "PYTHONIOENCODING": "utf-8",
            }
        )
        env.update(env_overrides or {})
        return subprocess.run(
            [sys.executable, str(self.tmp / "scanner_listener.py")],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=60,
        )

    def test_drains_outbox_on_start_before_new_scans_and_persists_mode(self):
        outbox = self.tmp / ".scanner_outbox.jsonl"
        outbox.write_text(
            json.dumps({"code": "OLD1", "mode": "in"})
            + "\n"
            + json.dumps({"code": "OLD2", "mode": "out"})
            + "\n",
            encoding="utf-8",
        )
        proc = self.run_listener("!!MODE:OUT!!\nNEW1\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            [(b["code"], b["mode"]) for b in self.server.bodies()],
            [("OLD1", "in"), ("OLD2", "out"), ("NEW1", "out")],
        )
        # trailing slash on PANTRY_SERVER_URL is stripped
        self.assertTrue(all(r["path"] == "/api/scan" for r in self.server.requests))
        self.assertFalse(outbox.exists())
        state = json.loads((self.tmp / ".scanner_state.json").read_text())
        self.assertEqual(state["mode"], "out")

        # Restart: a brand-new process picks the persisted mode up.
        proc = self.run_listener("NEW2\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Current mode: OUT", proc.stdout)
        self.assertEqual(
            self.server.bodies()[-1], {"code": "NEW2", "mode": "out", "source": "scanner"}
        )

    def test_missing_config_exits_with_error(self):
        proc = self.run_listener("123\n", {"SCANNER_TOKEN": ""})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("SCANNER_TOKEN", proc.stderr)
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    unittest.main()
