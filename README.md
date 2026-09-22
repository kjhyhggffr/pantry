# Pantry scanner

Two printed barcodes turn a cheap keyboard-wedge scanner into a pantry system.

Scan **PANTRY IN**, then scan groceries as you put them away — each one is
looked up, named, and counted into a Google Sheet. Scan **CART OUT**, then scan
the empty packet as you throw it away — it comes off the pantry count and lands
in a shopping queue that gets pushed into your [Frisco](https://www.frisco.pl)
cart.

```
  scanner ──► listener ──► Vercel ──► Google Sheet
  (types)     (laptop      (Next.js)   ├── pantry     what you have
              or Pi)                   ├── cart_queue what to buy
                                       ├── log        every scan, undoable
                                       └── products   barcode → name cache
                                            │
                          frisco_worker.py ─┘──► frisco CLI ──► your cart
```

## Repository layout

| Path | What it is |
| --- | --- |
| `web/` | The Vercel app: scan ingest, the Sheets store, the dashboard. Set this as the project's root directory. |
| `agent/scanner_listener.py` | Reads the scanner, holds the current mode, posts scans. |
| `agent/frisco_worker.py` | Drains the cart queue into Frisco. Runs on your machine, not on Vercel. |
| `barcodes/` | The printable control barcodes, plus the script that made them. |

## The control barcodes

| Barcode | Encodes | What it does |
| --- | --- | --- |
| **PANTRY IN** | `!!MODE:IN!!` | Every scan from now on adds to the pantry. |
| **CART OUT** | `!!MODE:OUT!!` | Every scan from now on removes from the pantry and queues the item for Frisco. |
| **UNDO LAST** | `!!MODE:UNDO!!` | Reverses the last scan. Does not change the mode. |

They are Code 128, which encodes arbitrary text, so nothing you buy can
collide with them. Already generated in `barcodes/` — open `cards.html` and
print it at **100% scale** (a "fit to page" shrink narrows the bars past what
most scanners resolve). The same page is served at `/barcodes` once deployed,
so you can reprint without the repo.

The mode is sticky and lives in the listener, not on the server. Your scanner
does not need to support programming modes or prefixes; it just types.

---

## Setup

### 1. The spreadsheet

Create a blank Google Sheet. Its ID is the long string in the URL between
`/d/` and `/edit`. The four tabs are created automatically on first use — you
do not need to set anything up inside it.

### 2. A service account

The server writes to the sheet as a robot, so there is no OAuth dance and no
token to refresh.

1. In the [Google Cloud console](https://console.cloud.google.com), create a
   project (or reuse one).
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   Name it anything; no roles needed.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
5. Back in your spreadsheet, hit **Share** and add the service account's email
   address (it ends in `.iam.gserviceaccount.com`) as an **Editor**.

This last step is the one people forget. Without it every request comes back
403 and the dashboard says it cannot read the spreadsheet.

### 3. Deploy to Vercel

Push this repo to GitHub, then import it at
[vercel.com/new](https://vercel.com/new).

- **Root Directory**: `web`
- Framework preset: Next.js (detected automatically)

Add four environment variables (see `.env.example`):

| Name | Value |
| --- | --- |
| `GOOGLE_SHEET_ID` | from the sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` in the JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` in the JSON key, pasted whole |
| `SCANNER_TOKEN` | `openssl rand -hex 32` |

Redeploy after adding them. Open the deployment URL: you should get an empty
dashboard rather than an error.

### 4. The listener

On whatever machine the scanner is plugged into — your laptop is fine to start
with, a Raspberry Pi later.

```bash
git clone https://github.com/YOURNAME/pantry-scanner.git
cd pantry-scanner/agent

cat > .env <<'EOF'
PANTRY_SERVER_URL=https://your-project.vercel.app
SCANNER_TOKEN=the-same-token-you-put-in-vercel
EOF

python3 scanner_listener.py
```

That reads from stdin, which is the quickest way to prove the whole chain
works: click into the terminal, scan a tin of tomatoes, watch the name appear.
Scan the PANTRY IN card and it announces the mode switch.

**Exclusive mode (Linux, recommended once it is permanent):**

```bash
pip install evdev
python3 scanner_listener.py --list-devices   # find yours
python3 scanner_listener.py --device auto
```

This grabs the scanner device, so barcodes stop spraying into whatever window
happens to be focused. `agent/pantry-scanner.service` runs it at boot under
systemd when you get the Pi.

The listener spools scans to `.scanner_outbox.jsonl` if the server is
unreachable and replays them on the next start, so scanning in a kitchen with
patchy wifi does not lose anything.

### 5. The Frisco worker

Vercel cannot hold a Frisco session — the [frisco CLI](https://github.com/rrudol/frisco)
authenticates through a real Chrome login and stores cookies in
`~/.frisco-cli/session.json`, which a serverless function has nowhere to keep.
So the queue lives on Vercel and this drains it locally.

```bash
go install github.com/rrudol/frisco/cmd/frisco@latest
frisco session login

cd pantry-scanner/agent
python3 frisco_worker.py --dry-run    # show the matches, change nothing
python3 frisco_worker.py              # actually add them
python3 frisco_worker.py --watch 300  # or leave it running
```

**Start with `--dry-run`.** Frisco's catalogue is keyed by their own product
IDs, not by EAN, so matching a scanned barcode to a Frisco product means
searching by name and taking the first hit. That is right most of the time and
occasionally puts the wrong brand of passata in your cart. Items it cannot
match are left pending with a note rather than guessed at, and show up on the
dashboard for you to sort out. Items that are still called `Unknown item …`
are skipped entirely — searching Frisco for "unknown item" would match
*something*, and that something would end up in your cart.

---

## Using it

Put the two cards where you unpack shopping.

- **Unpacking:** scan PANTRY IN once, then everything as it goes in the
  cupboard. Same item twice means you have two.
- **Finishing something:** scan CART OUT once, then the empty packet before it
  goes in the bin. It leaves the pantry and joins the shopping list. Scanning
  three empty jars of the same thing queues three, not three separate lines.
- **Mis-scan:** scan UNDO LAST, or press the button on the dashboard.

The dashboard at your Vercel URL shows the pantry, the Frisco queue, the recent
scans, and a box for typing a barcode by hand. Barcodes Open Food Facts has
never seen get a **Needs a name** row — name it once and it is remembered.

## How it decides what things are

[Open Food Facts](https://world.openfoodfacts.org) — free, no API key, good
Polish and European grocery coverage. Every result is cached in the `products`
tab, so a barcode is only ever fetched once and the system gets faster as your
pantry stabilises. A lookup that fails never loses the scan; you just get
`Unknown item 5900…` until you name it.

## Notes and caveats

- **The sheet is the database.** No Postgres, no KV, nothing else to pay for,
  and you can fix anything by hand from your phone. The trade is that each scan
  is a few API round-trips — expect roughly a second per scan, which is fine
  for a pantry and would not be for a shop till.
- **One shared secret** guards every write endpoint. The dashboard uses server
  actions, so the browser never sees the token. Anyone with your Vercel URL can
  still see the dashboard, though — if that matters, turn on Vercel
  Authentication in the project's Deployment Protection settings.
- **Quantities are counts, not weights.** Half a bag of flour reads as one bag
  until you scan it out.
- **The Frisco matching is the weak link**, as above. Everything else in the
  chain is exact; that one step is a guess.

## Licence

MIT.
