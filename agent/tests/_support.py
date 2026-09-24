"""Shared test helpers: a scripted mock HTTP server and a script loader.

Run the suite from the repo root with:
    uv run --no-project python -m unittest discover -s agent/tests -t . -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import threading
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

AGENT_DIR = Path(__file__).resolve().parent.parent

# Make sure urllib never routes 127.0.0.1 through a system/registry proxy.
NO_PROXY_ENV = {"no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}


def load_script(filename: str):
    """Import an agent script as a fresh, uniquely named module object.

    Each call returns a brand-new module, which is how the tests simulate a
    process restart (module-level state is re-created, files are re-read).
    """
    path = AGENT_DIR / filename
    name = f"_under_test_{path.stem}_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unused_port() -> int:
    """A localhost port with nothing listening on it (connection refused)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class MockServer:
    """ThreadingHTTPServer on 127.0.0.1:0 that records requests.

    Responses are scripted per (method, path) as a FIFO of (status, body)
    tuples; once a script runs out, `default` is returned.
    """

    def __init__(self, default=(200, {"ok": True})):
        self.requests: list[dict] = []
        self.scripts: dict[tuple[str, str], deque] = {}
        self.default = default
        self._lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = raw
                with server._lock:
                    server.requests.append(
                        {
                            "method": self.command,
                            "path": self.path,
                            "headers": dict(self.headers.items()),
                            "json": body,
                        }
                    )
                    queue = server.scripts.get((self.command, self.path))
                    status, payload = queue.popleft() if queue else server.default
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _handle
            do_POST = _handle

            def log_message(self, *args):  # keep test output quiet
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def script(self, method: str, path: str, *responses):
        with self._lock:
            self.scripts.setdefault((method, path), deque()).extend(responses)

    def bodies(self, method: str | None = None, path: str | None = None) -> list:
        return [
            r["json"]
            for r in self.requests
            if (method is None or r["method"] == method) and (path is None or r["path"] == path)
        ]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def no_proxy_patch():
    return mock.patch.dict(os.environ, NO_PROXY_ENV)
