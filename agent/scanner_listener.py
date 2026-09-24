#!/usr/bin/env python3
"""
The listener. Reads what the barcode scanner types and posts it to the server.

A USB/Bluetooth scanner in the usual "HID keyboard wedge" mode is, as far as
the operating system is concerned, a keyboard that types very fast and presses
Enter. So there are two ways to read it:

  * evdev  -- grab the scanner device exclusively. Nothing else on the machine
              sees the keystrokes, so scanning does not spray barcodes into
              whatever window happens to be focused. Linux only; this is the
              mode to use on a Raspberry Pi.
  * stdin  -- just read lines from a terminal. Works anywhere, including macOS
              and Windows, and is the easy way to try the whole thing out
              before any dedicated hardware exists.

Mode ("in" vs "out") lives here rather than on the server, deliberately: the
scanner is physically in front of you, and a deploy or a dropped connection
should never silently change what your next scan means. The mode is also
written to a small state file so a restart picks up where it left off.

Usage:
    python scanner_listener.py                      # read from stdin
    python scanner_listener.py --device auto        # grab the scanner (Linux)
    python scanner_listener.py --list-devices       # find your scanner

Configuration comes from the environment or a .env file beside this script:
    PANTRY_SERVER_URL=https://your-project.vercel.app
    SCANNER_TOKEN=...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
STATE_FILE = HERE / ".scanner_state.json"
OUTBOX_FILE = HERE / ".scanner_outbox.jsonl"
REJECTED_FILE = HERE / ".scanner_outbox.rejected.jsonl"

# Keep in sync with web/lib/codes.ts and barcodes/generate.py
CONTROL_CODES = {
    "!!MODE:IN!!": "in",
    "!!MODE:OUT!!": "out",
    "!!MODE:UNDO!!": "undo",
}

MODE_BANNERS = {
    "in": "\n  >>> PANTRY IN -- scans now go into the pantry\n",
    "out": "\n  >>> CART OUT -- scans now leave the pantry and go to the Frisco queue\n",
}

# A scanner types a whole barcode in a few milliseconds. Anything slower than
# this between the last two characters was a human at a keyboard, which is
# worth knowing about but not worth rejecting.
HUMAN_TYPING_THRESHOLD_S = 0.5


# ---------------------------------------------------------------- config


def load_dotenv() -> None:
    """Read a .env file beside this script, without adding a dependency."""
    env_path = HERE / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def config() -> tuple[str, str]:
    load_dotenv()
    url = os.environ.get("PANTRY_SERVER_URL", "").rstrip("/")
    token = os.environ.get("SCANNER_TOKEN", "")

    if not url or not token:
        sys.exit(
            "PANTRY_SERVER_URL and SCANNER_TOKEN must be set.\n"
            "Copy .env.example to agent/.env and fill it in."
        )
    return url, token


# ---------------------------------------------------------------- state


def read_mode() -> str:
    try:
        return json.loads(STATE_FILE.read_text())["mode"]
    except Exception:
        return "in"


def write_mode(mode: str) -> None:
    try:
        STATE_FILE.write_text(json.dumps({"mode": mode, "updated": time.time()}))
    except OSError as exc:
        print(f"  ! could not save mode: {exc}", file=sys.stderr)


# ---------------------------------------------------------------- network


def post_scan(url: str, token: str, code: str, mode: str, timeout: float = 15.0) -> dict:
    payload = json.dumps({"code": code, "mode": mode, "source": "scanner"}).encode()
    request = urllib.request.Request(
        f"{url}/api/scan",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def spool(code: str, mode: str) -> None:
    """Park a scan that could not be sent, so nothing is lost off-line."""
    entry = json.dumps({"code": code, "mode": mode, "ts": time.time()})
    with OUTBOX_FILE.open("a", encoding="utf-8") as handle:
        handle.write(entry + "\n")


def parse_spooled(line: str) -> tuple[str, str] | None:
    """(code, mode) from one outbox line, or None if the line is not usable."""
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    if not isinstance(entry, dict):
        return None
    code, mode = entry.get("code"), entry.get("mode")
    if not isinstance(code, str) or not code.strip() or mode not in ("in", "out"):
        return None
    return code, mode


def reject(line: str) -> None:
    """Set aside an outbox line that can never be replayed, keeping it for a human."""
    print(f"  ! unreadable spooled scan moved to {REJECTED_FILE.name}: {line}", file=sys.stderr)
    with REJECTED_FILE.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def drain_outbox(url: str, token: str) -> None:
    """Replay anything that was spooled while the server was unreachable."""
    if not OUTBOX_FILE.exists():
        return

    lines = [line for line in OUTBOX_FILE.read_text(encoding="utf-8").splitlines() if line]
    if not lines:
        OUTBOX_FILE.unlink(missing_ok=True)
        return

    print(f"  .. replaying {len(lines)} spooled scan(s)")
    remaining: list[str] = []

    for index, line in enumerate(lines):
        parsed = parse_spooled(line)
        if parsed is None:
            # A half-written or foreign line will never parse. Quarantine it
            # instead of mistaking it for "server down" and wedging the queue.
            reject(line)
            continue
        try:
            post_scan(url, token, *parsed)
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                # A bad token or a malformed row will never succeed. Drop it
                # rather than wedging the queue behind it forever.
                print(f"  ! discarding undeliverable scan ({exc.code}): {line}", file=sys.stderr)
                continue
            remaining = lines[index:]
            break
        except Exception:
            # Still down. Keep this one and everything after it, in order.
            remaining = lines[index:]
            break

    if remaining:
        OUTBOX_FILE.write_text("\n".join(remaining) + "\n", encoding="utf-8")
        print(f"  .. {len(remaining)} scan(s) still spooled")
    else:
        OUTBOX_FILE.unlink(missing_ok=True)
        print("  .. outbox empty")


# ---------------------------------------------------------------- handling


def describe(result: dict) -> str:
    if result.get("undone") is True:
        return (
            f"undid {result.get('direction')} of {result.get('name')} "
            f"-> now {result.get('qty')}"
        )
    if result.get("undone") is False:
        return result.get("reason", "nothing to undo")

    name = result.get("name", "?")
    qty = result.get("qty", "?")
    note = "  (queued for Frisco)" if result.get("queuedForCart") else ""
    unknown = "  [unknown barcode -- name it on the dashboard]" if result.get(
        "unknownProduct"
    ) else ""
    return f"{name} -> {qty}{note}{unknown}"


def handle_code(code: str, mode: str, url: str, token: str) -> str:
    """Process one scanned string. Returns the mode to use for the next scan."""
    code = code.strip()
    if not code:
        return mode

    action = CONTROL_CODES.get(code.upper())

    if action in ("in", "out"):
        write_mode(action)
        print(MODE_BANNERS[action])
        return action

    if action == "undo":
        try:
            print("  " + describe(post_scan(url, token, "!!MODE:UNDO!!", mode)))
        except Exception as exc:
            print(f"  ! undo failed: {exc}", file=sys.stderr)
        return mode

    # An ordinary product barcode.
    try:
        result = post_scan(url, token, code, mode)
        if result.get("ok"):
            print(f"  [{mode}] {describe(result)}")
        else:
            print(f"  ! server refused {code}: {result.get('error')}", file=sys.stderr)
    except urllib.error.HTTPError as exc:
        # The request arrived. A 5xx is worth retrying; a 4xx (bad token, bad
        # payload) never will be, so spooling it would only wedge the queue.
        if exc.code >= 500:
            spool(code, mode)
            print(f"  ~ server error {exc.code}, spooled {code}", file=sys.stderr)
        else:
            print(f"  ! server rejected {code}: {exc.code} {exc.reason}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        spool(code, mode)
        print(f"  ~ offline, spooled {code} ({exc})", file=sys.stderr)
    except Exception as exc:
        print(f"  ! {code} failed: {exc}", file=sys.stderr)

    return mode


# ---------------------------------------------------------------- input sources


def read_from_stdin(url: str, token: str) -> None:
    mode = read_mode()
    print(f"Reading from stdin. Current mode: {mode.upper()}.")
    print("Scan a control card to switch modes, or Ctrl-C to stop.\n")

    last_char_at = 0.0
    for line in sys.stdin:
        now = time.monotonic()
        if last_char_at and (now - last_char_at) > HUMAN_TYPING_THRESHOLD_S:
            pass  # typed by hand rather than scanned; accepted either way
        last_char_at = now

        mode = handle_code(line, mode, url, token)


def find_scanner_devices():
    """List input devices that look like a barcode scanner."""
    import evdev  # imported lazily so stdin mode needs no dependencies

    candidates = []
    for path in evdev.list_devices():
        device = evdev.InputDevice(path)
        capabilities = device.capabilities()
        # A keyboard-wedge scanner reports EV_KEY and can emit Enter.
        keys = capabilities.get(evdev.ecodes.EV_KEY, [])
        if evdev.ecodes.KEY_ENTER in keys and len(keys) > 30:
            candidates.append(device)
    return candidates


def read_from_device(device_arg: str, url: str, token: str) -> None:
    import evdev
    from evdev import categorize, ecodes

    if device_arg == "auto":
        devices = find_scanner_devices()
        if not devices:
            sys.exit("No keyboard-like input device found. Try --list-devices.")
        if len(devices) > 1:
            print("Several candidates found; using the first. Override with --device:")
            for device in devices:
                print(f"  {device.path}  {device.name}")
        device = devices[0]
    else:
        device = evdev.InputDevice(device_arg)

    # Exclusive grab: keystrokes stop leaking into whatever window has focus.
    device.grab()

    mode = read_mode()
    print(f"Listening on {device.path} ({device.name}). Current mode: {mode.upper()}.\n")

    # evdev gives key codes, not characters. This covers what appears in a
    # barcode plus the punctuation the control codes use.
    unshifted = {
        **{getattr(ecodes, f"KEY_{d}"): str(d) for d in range(10)},
        **{
            getattr(ecodes, f"KEY_{c}"): c.lower()
            for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        },
        ecodes.KEY_MINUS: "-",
        ecodes.KEY_EQUAL: "=",
        ecodes.KEY_DOT: ".",
        ecodes.KEY_SLASH: "/",
        ecodes.KEY_SEMICOLON: ";",
        ecodes.KEY_SPACE: " ",
    }
    shifted = {
        **{getattr(ecodes, f"KEY_{c}"): c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
        ecodes.KEY_1: "!",
        ecodes.KEY_2: "@",
        ecodes.KEY_3: "#",
        ecodes.KEY_4: "$",
        ecodes.KEY_5: "%",
        ecodes.KEY_6: "^",
        ecodes.KEY_7: "&",
        ecodes.KEY_8: "*",
        ecodes.KEY_9: "(",
        ecodes.KEY_0: ")",
        ecodes.KEY_MINUS: "_",
        ecodes.KEY_EQUAL: "+",
        ecodes.KEY_SEMICOLON: ":",
        ecodes.KEY_SLASH: "?",
    }

    buffer: list[str] = []
    shift_held = False

    try:
        for event in device.read_loop():
            if event.type != ecodes.EV_KEY:
                continue

            key = categorize(event)

            if key.scancode in (ecodes.KEY_LEFTSHIFT, ecodes.KEY_RIGHTSHIFT):
                shift_held = key.keystate in (key.key_down, key.key_hold)
                continue

            if key.keystate != key.key_down:
                continue

            if key.scancode in (ecodes.KEY_ENTER, ecodes.KEY_KPENTER):
                code = "".join(buffer)
                buffer.clear()
                mode = handle_code(code, mode, url, token)
                continue

            table = shifted if shift_held else unshifted
            char = table.get(key.scancode)
            if char:
                buffer.append(char)
    finally:
        device.ungrab()


# ---------------------------------------------------------------- entry point


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--device",
        help="evdev path such as /dev/input/event3, or 'auto' to pick one (Linux only)",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="print candidate input devices and exit",
    )
    args = parser.parse_args()

    if args.list_devices:
        try:
            for device in find_scanner_devices():
                print(f"{device.path}\t{device.name}")
        except ImportError:
            sys.exit("evdev is not installed. pip install evdev")
        return

    url, token = config()
    drain_outbox(url, token)

    try:
        if args.device:
            read_from_device(args.device, url, token)
        else:
            read_from_stdin(url, token)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
