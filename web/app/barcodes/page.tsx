/**
 * A printable page of the control barcodes, rendered from the same strings the
 * listener matches against. Losing the printout is then a non-event: open this
 * page, hit print.
 */

import Link from 'next/link';

import { CARDS } from '@/lib/codes';
import { barcodeSvg } from '@/lib/code128';

export default function BarcodesPage() {
  return (
    <main className="print-page">
      <header className="masthead no-print">
        <div>
          <h1>Control barcodes</h1>
          <p className="muted">
            Print at 100% scale &mdash; do not let the dialog &ldquo;fit to page&rdquo;, it
            narrows the bars past what the scanner can read.
          </p>
        </div>
        <Link className="button ghost" href="/">
          Back to the dashboard
        </Link>
      </header>

      {CARDS.map((card) => (
        <section
          key={card.code}
          className="card"
          style={{ ['--accent' as string]: card.accent }}
        >
          <div className="card-head">
            <span className="dot" />
            <h2>{card.title}</h2>
          </div>
          <div
            className="barcode"
            // The SVG is built from a fixed string in lib/codes.ts, never from
            // user input, so there is nothing here to inject.
            dangerouslySetInnerHTML={{
              __html: barcodeSvg(card.code, { moduleWidth: 2.2, height: 88 }),
            }}
          />
          <p>{card.blurb}</p>
        </section>
      ))}
    </main>
  );
}
