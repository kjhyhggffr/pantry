/**
 * What actually happens when a barcode arrives.
 *
 *   mode "in"  -> pantry quantity goes up by one
 *   mode "out" -> pantry quantity goes down by one AND the item is queued for
 *                 the Frisco cart, because the reason a thing leaves the
 *                 pantry is almost always that you just used the last of it
 *
 * Every change also writes a row to the `log` tab, which is what makes undo
 * possible: undo reads the newest log row that has not already been undone and
 * applies its inverse.
 */

import { TABS, appendRow, getRecords, updateCell, updateRow } from './sheets';
import { resolveProduct } from './openfoodfacts';
import type { Mode } from './codes';

export interface PantryRecord extends Record<string, string> {
  barcode: string;
  name: string;
  brand: string;
  size: string;
  qty: string;
  first_seen: string;
  last_seen: string;
}

export interface LogRecord extends Record<string, string> {
  ts: string;
  direction: string;
  barcode: string;
  name: string;
  qty_after: string;
  source: string;
  undone: string;
}

export interface CartQueueRecord extends Record<string, string> {
  ts: string;
  barcode: string;
  name: string;
  qty: string;
  status: string;
  frisco_product_id: string;
  frisco_product_name: string;
  note: string;
}

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
  barcode: string,
  mode: Mode,
  source = 'scanner',
): Promise<ScanResult> {
  const product = await resolveProduct(barcode);
  const now = new Date().toISOString();

  const pantry = await getRecords<PantryRecord>(TABS.pantry);
  const existing = pantry.find((row) => row.barcode === barcode);

  const delta = mode === 'in' ? 1 : -1;
  const previousQty = existing ? parseQty(existing.qty) : 0;
  // Scanning something out that the pantry never knew about is normal -- you
  // are allowed to run out of a thing you never scanned in. Clamp at zero
  // rather than going negative, which would only ever confuse the sheet.
  const nextQty = Math.max(0, previousQty + delta);

  if (existing) {
    await updateRow(TABS.pantry, existing._row, {
      ...existing,
      name: product.name,
      brand: product.brand,
      size: product.size,
      qty: nextQty,
      last_seen: now,
    });
  } else {
    await appendRow(TABS.pantry, {
      barcode,
      name: product.name,
      brand: product.brand,
      size: product.size,
      qty: nextQty,
      first_seen: now,
      last_seen: now,
    });
  }

  await appendRow(TABS.log, {
    ts: now,
    direction: mode,
    barcode,
    name: product.name,
    qty_after: nextQty,
    source,
    undone: '',
  });

  if (mode === 'out') {
    await queueForCart(barcode, product.name, now);
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
async function queueForCart(barcode: string, name: string, now: string): Promise<void> {
  const queue = await getRecords<CartQueueRecord>(TABS.cartQueue);
  const pending = queue.find(
    (row) => row.barcode === barcode && row.status === 'pending',
  );

  if (pending) {
    await updateRow(TABS.cartQueue, pending._row, {
      ...pending,
      name,
      qty: parseQty(pending.qty) + 1,
      ts: now,
    });
    return;
  }

  await appendRow(TABS.cartQueue, {
    ts: now,
    barcode,
    name,
    qty: 1,
    status: 'pending',
    frisco_product_id: '',
    frisco_product_name: '',
    note: '',
  });
}

export interface UndoResult {
  ok: true;
  undone: true;
  barcode: string;
  name: string;
  direction: string;
  qty: number;
}

export interface NothingToUndo {
  ok: true;
  undone: false;
  reason: string;
}

/** Reverse the newest scan that has not already been reversed. */
export async function undoLastScan(): Promise<UndoResult | NothingToUndo> {
  const log = await getRecords<LogRecord>(TABS.log);

  let target: (LogRecord & { _row: number }) | undefined;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (!log[i].undone) {
      target = log[i];
      break;
    }
  }

  if (!target) {
    return { ok: true, undone: false, reason: 'There is nothing left to undo.' };
  }

  const pantry = await getRecords<PantryRecord>(TABS.pantry);
  const row = pantry.find((entry) => entry.barcode === target!.barcode);

  // The inverse of the original move: an "in" becomes a decrement.
  const delta = target.direction === 'in' ? -1 : 1;
  const nextQty = Math.max(0, (row ? parseQty(row.qty) : 0) + delta);

  if (row) {
    await updateRow(TABS.pantry, row._row, {
      ...row,
      qty: nextQty,
      last_seen: new Date().toISOString(),
    });
  }

  if (target.direction === 'out') {
    await unqueueFromCart(target.barcode);
  }

  await updateCell(TABS.log, target._row, 'undone', 'yes');

  return {
    ok: true,
    undone: true,
    barcode: target.barcode,
    name: target.name,
    direction: target.direction,
    qty: nextQty,
  };
}

/** Take one unit back off the pending cart row, dropping it at zero. */
async function unqueueFromCart(barcode: string): Promise<void> {
  const queue = await getRecords<CartQueueRecord>(TABS.cartQueue);
  const pending = queue.find(
    (row) => row.barcode === barcode && row.status === 'pending',
  );
  if (!pending) return;

  const nextQty = parseQty(pending.qty) - 1;

  if (nextQty <= 0) {
    await updateRow(TABS.cartQueue, pending._row, {
      ...pending,
      qty: 0,
      status: 'cancelled',
      note: 'undone at the scanner',
    });
    return;
  }

  await updateRow(TABS.cartQueue, pending._row, { ...pending, qty: nextQty });
}

export function parseQty(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
