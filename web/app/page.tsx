/**
 * The dashboard: what is in the pantry, what is queued for Frisco, what still
 * needs a name, and a manual entry box for the days the scanner is out of
 * reach. Server-rendered straight off the database on every load.
 */

import Link from 'next/link';

import { UNKNOWN_PREFIX } from '@/lib/openfoodfacts';
import { requireUser } from '@/lib/supabase-auth';
import { getStore } from '@/lib/supabase-store';
import type { CartItem, LogEntry, PantryItem } from '@/lib/store';
import {
  manualScanAction,
  renameProductAction,
  setQueueStatusAction,
  undoAction,
} from './actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  const user = await requireUser();

  let pantry: PantryItem[] = [];
  let pending: CartItem[] = [];
  let recent: LogEntry[] = [];
  let loadError: string | null = null;

  try {
    const store = getStore();
    [pantry, pending, recent] = await Promise.all([
      store.listPantry(),
      store.listPendingCart(),
      store.recentLog(12),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not reach the database';
  }

  const inStock = pantry.filter((item) => item.qty > 0);
  const unnamed = pantry.filter((item) => item.name.startsWith(UNKNOWN_PREFIX));

  const lastScan = recent.find((entry) => !entry.undone_at);
  const currentMode = lastScan?.direction === 'out' ? 'out' : 'in';

  if (loadError) {
    return (
      <main>
        <h1>Pantry scanner</h1>
        <div className="panel error">
          <h2>Cannot read the database</h2>
          <p>{loadError}</p>
          <p className="muted">
            Check that the Supabase integration is connected to this Vercel project and
            that the build ran its migrations (<code>scripts/setup-db.mjs</code>).
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="masthead">
        <div>
          <h1>Pantry scanner</h1>
          <p className="muted">
            {inStock.length} items in stock &middot; {pending.length} queued for Frisco
          </p>
        </div>
        <div className="masthead-actions">
          <span className={`mode mode-${currentMode}`}>
            last scan: {currentMode === 'out' ? 'cart out' : 'pantry in'}
          </span>
          <Link className="button ghost" href="/barcodes">
            Print control barcodes
          </Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="button ghost small" title={user.email}>
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="panel">
        <h2>Frisco queue</h2>
        {pending.length === 0 ? (
          <p className="muted">
            Nothing waiting. Scan the <strong>CART OUT</strong> card and then an empty
            packet to add something here.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th>Barcode</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td className="num">{item.qty}</td>
                  <td className="code">{item.barcode}</td>
                  <td className="row-actions">
                    <form action={setQueueStatusAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="status" value="done" />
                      <button type="submit" className="button small">
                        Bought
                      </button>
                    </form>
                    <form action={setQueueStatusAction}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="status" value="cancelled" />
                      <button type="submit" className="button small ghost">
                        Drop
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {unnamed.length > 0 && (
        <section className="panel">
          <h2>Needs a name</h2>
          <p className="muted">
            Open Food Facts had never seen these barcodes. Name one once and it sticks
            forever.
          </p>
          <ul className="naming">
            {unnamed.map((item) => (
              <li key={item.barcode}>
                <form action={renameProductAction}>
                  <span className="code">{item.barcode}</span>
                  <input type="hidden" name="barcode" value={item.barcode} />
                  <input name="name" placeholder="What is it?" required />
                  <input name="brand" placeholder="Brand (optional)" />
                  <button type="submit" className="button small">
                    Save
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>In the pantry</h2>
        {inStock.length === 0 ? (
          <p className="muted">Empty. Scan the PANTRY IN card and start scanning tins.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Brand</th>
                <th>Size</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {inStock.map((item) => (
                <tr key={item.barcode}>
                  <td>{item.name}</td>
                  <td className="muted">{item.brand}</td>
                  <td className="muted">{item.size}</td>
                  <td className="num">{item.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="split">
        <section className="panel">
          <h2>Type a barcode</h2>
          <p className="muted">For when the scanner is in the other room.</p>
          <form action={manualScanAction} className="manual">
            <input name="barcode" placeholder="5900512300108" required />
            <select name="mode" defaultValue="in">
              <option value="in">Into the pantry</option>
              <option value="out">Out to the cart</option>
            </select>
            <button type="submit" className="button">
              Record
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>Recent scans</h2>
          {recent.length === 0 ? (
            <p className="muted">No scans yet.</p>
          ) : (
            <ol className="feed">
              {recent.map((entry) => (
                <li key={entry.id} className={entry.undone_at ? 'undone' : ''}>
                  <span className={`pill pill-${entry.direction}`}>{entry.direction}</span>
                  <span className="feed-name">{entry.name}</span>
                  <time dateTime={entry.ts}>{formatTime(entry.ts)}</time>
                </li>
              ))}
            </ol>
          )}
          <form action={undoAction}>
            <button type="submit" className="button ghost small">
              Undo last scan
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
