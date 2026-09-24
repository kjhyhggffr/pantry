/**
 * What actually happens when a barcode arrives.
 *
 *   mode "in"  -> pantry quantity goes up by one
 *   mode "out" -> pantry quantity goes down by one AND the item is queued for
 *                 the Frisco cart, because the reason a thing leaves the
 *                 pantry is almost always that you just used the last of it
 *
 * Every change also writes a row to `scan_log`, which is what makes undo
 * possible: undo reads the newest log row that has not already been undone and
 * applies its inverse.
 *
 * The store is passed in rather than imported so tests can use an in-memory one.
 */

import { resolveProduct, type Fetch } from './openfoodfacts';
import type { Mode } from './codes';
import type { Store } from './store';

export interface ScanResult {
  ok: true;
  mode: Mode;
  barcode: string;
  name: string;
  brand: string;
  qty: number;
  queuedForCart: boolean;
  unknownProduct: boolean;
}

export async function recordScan(
  store: Store,
  barcode: string,
  mode: Mode,
  source = 'scanner',
  fetchImpl?: Fetch,
): Promise<ScanResult> {
  const product = await resolveProduct(store, barcode, fetchImpl);
  const now = new Date().toISOString();

  const existing = await store.getPantryItem(barcode);

  const delta = mode === 'in' ? 1 : -1;
  // Scanning something out that the pantry never knew about is normal -- you
  // are allowed to run out of a thing you never scanned in. Clamp at zero
  // rather than going negative.
  const nextQty = Math.max(0, (existing?.qty ?? 0) + delta);

  await store.upsertPantryItem({
    barcode,
    name: product.name,
    brand: product.brand,
    size: product.size,
    qty: nextQty,
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
  });

  await store.appendLog({
    ts: now,
    direction: mode,
    barcode,
    name: product.name,
    qty_after: nextQty,
    source,
  });

  if (mode === 'out') {
    await queueForCart(store, barcode, product.name, now);
  }

  return {
    ok: true,
    mode,
    barcode,
    name: product.name,
    brand: product.brand,
    qty: nextQty,
    queuedForCart: mode === 'out',
    unknownProduct: product.source === 'unknown',
  };
}

/**
 * Add to the cart queue, or bump the quantity if the same item is already
 * sitting there unfetched. Scanning three empty jars of the same passata
 * should mean "buy three", not three separate queue rows.
 */
async function queueForCart(
  store: Store,
  barcode: string,
  name: string,
  now: string,
): Promise<void> {
  const pending = await store.getPendingCartItem(barcode);

  if (pending) {
    await store.updateCartItem(pending.id, { name, qty: pending.qty + 1, ts: now });
    return;
  }

  await store.insertCartItem({
    ts: now,
    barcode,
    name,
    qty: 1,
    status: 'pending',
    frisco_product_id: null,
    frisco_product_name: null,
    note: null,
  });
}

export interface UndoResult {
  ok: true;
  undone: true;
  barcode: string;
  name: string;
  direction: Mode;
  qty: number;
}

export interface NothingToUndo {
  ok: true;
  undone: false;
  reason: string;
}

/** Reverse the newest scan that has not already been reversed. */
export async function undoLastScan(store: Store): Promise<UndoResult | NothingToUndo> {
  const target = await store.lastActiveLog();

  if (!target) {
    return { ok: true, undone: false, reason: 'There is nothing left to undo.' };
  }

  const now = new Date().toISOString();
  const row = await store.getPantryItem(target.barcode);

  // The inverse of the original move: an "in" becomes a decrement.
  const delta = target.direction === 'in' ? -1 : 1;
  const nextQty = Math.max(0, (row?.qty ?? 0) + delta);

  if (row) {
    await store.upsertPantryItem({ ...row, qty: nextQty, last_seen: now });
  }

  if (target.direction === 'out') {
    await unqueueFromCart(store, target.barcode);
  }

  await store.markLogUndone(target.id, now);

  return {
    ok: true,
    undone: true,
    barcode: target.barcode,
    name: target.name,
    direction: target.direction,
    qty: nextQty,
  };
}

/** Take one unit back off the pending cart row, cancelling it at zero. */
async function unqueueFromCart(store: Store, barcode: string): Promise<void> {
  const pending = await store.getPendingCartItem(barcode);
  if (!pending) return;

  const nextQty = pending.qty - 1;

  if (nextQty <= 0) {
    await store.updateCartItem(pending.id, {
      qty: 0,
      status: 'cancelled',
      note: 'undone at the scanner',
    });
    return;
  }

  await store.updateCartItem(pending.id, { qty: nextQty });
}
