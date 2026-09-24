#!/usr/bin/env python3
"""
Drains the Frisco cart queue.

Why this runs on your machine and not on Vercel: the frisco tool authenticates
with a browser session stored in ~/.frisco-cli/session.json, refreshed by a
real Chrome login. A serverless function has no persistent home directory and
no browser, so it cannot hold that session. Vercel keeps the list of what you
need; this script puts it in the cart.

    # once, to authenticate
    go install github.com/rrudol/frisco/cmd/frisco@latest
    frisco session login

    # then, whenever you want the queue emptied into your cart
    python frisco_worker.py
    python frisco_worker.py --dry-run     # show what it would do, touch nothing
    python frisco_worker.py --watch 300   # keep going, every 5 minutes

Matching a pantry barcode to a Frisco product is the genuinely uncertain part:
Frisco's catalogue is keyed by their own product IDs, not by EAN. This script
searches by product name and takes the first result, which is right most of the
time and wrong often enough that --dry-run is worth using first. Anything it
cannot match is left pending and reported, not guessed at.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent

# Items already in the Frisco cart whose "done" has not reached the server yet.
# Without it, a report lost to a network blip means the next pass buys it again.
JOURNAL_FILE = HERE / ".frisco_added.jsonl"

# Frisco search is a plain text match, so strip the things that only ever hurt:
# pack sizes, units, and punctuation that came from the Open Food Facts title.
NOISE_TOKENS = {"g", "kg", "ml", "l", "szt", "x", "op", "pcs"}


def load_dotenv() -> None:
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
        sys.exit("PANTRY_SERVER_URL and SCANNER_TOKEN must be set (see agent/.env).")
    return url, token


# ---------------------------------------------------------------- server


def api(url: str, token: str, path: str, payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{url}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode())


def fetch_queue(url: str, token: str) -> list[dict]:
    result = api(url, token, "/api/queue")
    return result.get("items", [])


def report(url: str, token: str, item_id: int, status: str, **extra) -> None:
    api(url, token, "/api/queue", {"id": item_id, "status": status, **extra})


# ---------------------------------------------------------------- journal


def read_journal() -> list[dict]:
    if not JOURNAL_FILE.exists():
        return []

    entries = []
    for line in JOURNAL_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            entry = None
        if not isinstance(entry, dict) or "id" not in entry:
            # Some item is in the cart and we can no longer tell which. Adding
            # anything now could buy it twice, so stop and ask a human.
            raise RuntimeError(
                f"{JOURNAL_FILE} has an unreadable line: {line!r}. Check the Frisco "
                "cart, mark that item done on the dashboard, then remove the line."
            )
        entries.append(entry)
    return entries


def journal_add(item_id: int, product_id: str, product_name: str, qty: int) -> None:
    entry = {
        "id": item_id,
        "frisco_product_id": product_id,
        "frisco_product_name": product_name,
        "qty": qty,
        "ts": time.time(),
    }
    with JOURNAL_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def journal_remove(item_id: int) -> None:
    keep = [entry for entry in read_journal() if entry["id"] != item_id]
    if not keep:
        JOURNAL_FILE.unlink(missing_ok=True)
        return
    scratch = JOURNAL_FILE.with_name(JOURNAL_FILE.name + ".tmp")
    scratch.write_text("".join(json.dumps(entry) + "\n" for entry in keep), encoding="utf-8")
    os.replace(scratch, JOURNAL_FILE)


def resend_journal(url: str, token: str, entries: list[dict]) -> None:
    """Tell the server about cart adds whose "done" got lost last time.

    Any failure other than "no such item" propagates and ends the pass: the
    server is unreachable, and the journal keeps these safe until it is back.
    """
    for entry in entries:
        try:
            report(
                url,
                token,
                entry["id"],
                "done",
                friscoProductId=entry.get("frisco_product_id"),
                friscoProductName=entry.get("frisco_product_name"),
            )
            print(f"  + item {entry['id']}: added on an earlier pass, now reported done")
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code != 404:
                raise
            print(f"  ? item {entry['id']}: no longer on the server; it is in the cart already")
        journal_remove(entry["id"])


# ---------------------------------------------------------------- frisco


def frisco(*args: str) -> subprocess.CompletedProcess:
    """Run the frisco CLI. Raises FileNotFoundError if it isn't installed."""
    return subprocess.run(
        ["frisco", *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def is_unnamed(name: str) -> bool:
    """True for the placeholder the server writes when a lookup found nothing.

    Searching Frisco for "Unknown item" would match something, and that
    something would end up in your cart. Better to skip and say so.
    """
    return name.strip().lower().startswith("unknown item")


def search_term(name: str) -> str:
    """Turn 'Passata pomidorowa Łowicz 500 g' into something Frisco can match.

    Splitting is on whitespace only -- a comma inside '3,2%' is part of the
    number, not a separator.
    """
    words = []
    for word in name.split():
        cleaned = word.strip(".,()[]").lower()
        if not cleaned or cleaned.isdigit() or cleaned in NOISE_TOKENS:
            continue
        words.append(word.strip(".,()[]"))
        if len(words) == 4:
            break
    return " ".join(words) or name


def find_product(name: str) -> dict | None:
    """Best-effort name -> Frisco product. Returns None rather than guessing wildly."""
    result = frisco("products", "search", "--search", search_term(name), "--format", "json")

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "frisco products search failed")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        # Older builds print a table when --format json isn't supported on a
        # subcommand. That is a broken search, not "Frisco has no such thing",
        # so say so rather than leaving a misleading "no match" note.
        raise RuntimeError("frisco products search did not return JSON (old frisco build?)")

    products = payload if isinstance(payload, list) else payload.get("products", [])
    if not products:
        return None

    first = products[0]
    product_id = first.get("productId") or first.get("id") or first.get("product_id")
    if product_id is None:
        return None

    return {
        "id": str(product_id),
        "name": first.get("name") or first.get("productName") or "",
    }


def add_to_cart(product_id: str, quantity: int) -> None:
    result = frisco(
        "cart", "add", "--product-id", product_id, "--quantity", str(quantity)
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "frisco cart add failed")


# ---------------------------------------------------------------- main loop


def run_once(url: str, token: str, dry_run: bool) -> int:
    journaled = read_journal()
    already_added = {entry["id"] for entry in journaled}
    if journaled and not dry_run:
        resend_journal(url, token, journaled)

    items = fetch_queue(url, token)

    if not items:
        print("Queue is empty.")
        return 0

    print(f"{len(items)} item(s) to add.\n")
    handled = 0

    for item in items:
        label = f"{item['name']} x{item['qty']}"

        if item["id"] in already_added:
            print(f"  = {label}: already in the cart, waiting to be reported -- not adding again")
            continue

        if is_unnamed(item["name"]):
            print(f"  ? {label}: still unnamed -- name it on the dashboard first")
            continue

        try:
            match = find_product(item["name"])
        except Exception as exc:
            # Unlike "no match", this says nothing about Frisco's catalogue:
            # leave it pending so the next pass retries, and put the reason
            # on the dashboard.
            print(f"  ! {label}: search failed -- {exc}")
            if not dry_run:
                report(url, token, item["id"], "pending", note=f"search failed: {exc}"[:200])
            continue

        if not match:
            print(f"  ? {label}: no Frisco match for '{search_term(item['name'])}'")
            if not dry_run:
                report(
                    url,
                    token,
                    item["id"],
                    "pending",
                    note=f"no match for '{search_term(item['name'])}'",
                )
            continue

        if dry_run:
            print(f"  - {label}  ->  {match['name']} (id {match['id']})")
            continue

        try:
            add_to_cart(match["id"], item["qty"])
        except Exception as exc:
            print(f"  ! {label}: add failed -- {exc}")
            report(url, token, item["id"], "failed", note=str(exc)[:200])
            continue

        # It is in the cart now. Write that down before telling the server, so
        # a report that never arrives cannot lead to adding it a second time.
        try:
            journal_add(item["id"], match["id"], match["name"], item["qty"])
        except OSError as exc:
            print(f"  ! could not write {JOURNAL_FILE.name}: {exc}", file=sys.stderr)

        print(f"  + {label}  ->  {match['name']}")
        try:
            report(
                url,
                token,
                item["id"],
                "done",
                friscoProductId=match["id"],
                friscoProductName=match["name"],
            )
        except Exception:
            print(f"  ! {label}: in the cart, but the server did not hear about it; will retry")
            raise
        journal_remove(item["id"])
        handled += 1

    return handled


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show the matches without touching the cart or the queue",
    )
    parser.add_argument(
        "--watch",
        type=int,
        metavar="SECONDS",
        help="keep running, checking the queue this often",
    )
    args = parser.parse_args()

    if shutil.which("frisco") is None:
        sys.exit(
            "The `frisco` CLI is not on your PATH.\n"
            "  go install github.com/rrudol/frisco/cmd/frisco@latest\n"
            "  frisco session login"
        )

    url, token = config()

    if not args.watch:
        try:
            run_once(url, token, args.dry_run)
        except Exception as exc:
            sys.exit(f"  ! pass failed: {exc}")
        return

    print(f"Watching the queue every {args.watch}s. Ctrl-C to stop.\n")
    try:
        while True:
            try:
                run_once(url, token, args.dry_run)
            except Exception as exc:
                print(f"  ! pass failed: {exc}", file=sys.stderr)
            time.sleep(args.watch)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
