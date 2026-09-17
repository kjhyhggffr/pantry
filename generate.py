#!/usr/bin/env python3
"""
Generate the printable control barcodes for the pantry scanner.

These are Code 128 barcodes. Your scanner reads them exactly like a product
barcode -- it types the text and presses Enter -- but the listener script
recognises the text as a command instead of a product.

    pip install python-barcode pillow
    python generate.py

Outputs PNG + SVG for each card into this directory, plus cards.html which
you can open in a browser and print (one A4 page, three cards).
"""

from pathlib import Path

import barcode
from barcode.writer import ImageWriter, SVGWriter

HERE = Path(__file__).parent

# Keep these in sync with agent/scanner_listener.py and web/lib/codes.ts
CARDS = [
    {
        "code": "!!MODE:IN!!",
        "slug": "MODE_PANTRY_IN",
        "title": "PANTRY IN",
        "blurb": "Everything scanned after this goes INTO the pantry sheet.",
        "accent": "#1f7a3d",
    },
    {
        "code": "!!MODE:OUT!!",
        "slug": "MODE_CART_OUT",
        "title": "CART OUT",
        "blurb": "Everything scanned after this leaves the pantry and lands in the Frisco cart queue.",
        "accent": "#b3421a",
    },
    {
        "code": "!!MODE:UNDO!!",
        "slug": "MODE_UNDO",
        "title": "UNDO LAST",
        "blurb": "Reverses the most recent scan. Does not change the current mode.",
        "accent": "#4b4b4b",
    },
]

# Code 128 is quiet-zone sensitive. module_width in mm; 0.33 is comfortable
# for a handheld scanner reading a laser-printed card from ~15 cm.
WRITER_OPTS = {
    "module_width": 0.33,
    "module_height": 22.0,
    "quiet_zone": 8.0,
    "font_size": 11,
    "text_distance": 4.0,
    "write_text": True,
}


def generate() -> None:
    code128 = barcode.get_barcode_class("code128")

    for card in CARDS:
        png_path = HERE / card["slug"]
        svg_path = HERE / card["slug"]

        code128(card["code"], writer=ImageWriter()).save(
            str(png_path), options={**WRITER_OPTS, "dpi": 300}
        )
        code128(card["code"], writer=SVGWriter()).save(
            str(svg_path), options=WRITER_OPTS
        )
        print(f"wrote {card['slug']}.png and {card['slug']}.svg")

    (HERE / "cards.html").write_text(build_html(), encoding="utf-8")
    print("wrote cards.html  (open it and print at 100% scale -- do not 'fit to page')")


def build_html() -> str:
    cards = "\n".join(
        f"""    <section class="card" style="--accent: {c['accent']}">
      <header>
        <span class="dot"></span>
        <h2>{c['title']}</h2>
      </header>
      <img src="{c['slug']}.svg" alt="{c['title']} barcode" />
      <p>{c['blurb']}</p>
      <code>{c['code']}</code>
    </section>"""
        for c in CARDS
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Pantry scanner &mdash; control barcodes</title>
<style>
  @page {{ size: A4; margin: 14mm; }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 24px; color: #16150f; background: #faf9f5;
  }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .lede {{ margin: 0 0 24px; color: #6b6963; font-size: 13px; max-width: 60ch; }}
  .card {{
    border: 1.5px solid #e3e1d9; border-left: 6px solid var(--accent);
    border-radius: 10px; background: #fff; padding: 18px 20px 14px;
    margin-bottom: 16px; break-inside: avoid; page-break-inside: avoid;
  }}
  .card header {{ display: flex; align-items: center; gap: 8px; }}
  .dot {{ width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }}
  h2 {{ font-size: 15px; letter-spacing: .08em; margin: 0; color: var(--accent); }}
  .card img {{ display: block; height: 78px; margin: 12px 0 6px; }}
  .card p {{ margin: 0 0 8px; font-size: 13px; color: #44423c; max-width: 62ch; }}
  .card code {{ font-size: 11px; color: #8a8880; }}
  @media print {{ body {{ background: #fff; padding: 0; }} }}
</style>
</head>
<body>
  <h1>Pantry scanner &mdash; control barcodes</h1>
  <p class="lede">Print at 100% scale, cut along the cards, and tape them where you
  use the scanner. Scanning one switches the mode; it stays in that mode until you
  scan the other one.</p>
{cards}
</body>
</html>
"""


if __name__ == "__main__":
    generate()
