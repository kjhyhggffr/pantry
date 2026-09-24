import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { renameProduct } from '../lib/openfoodfacts';
import { recordScan, undoLastScan } from '../lib/pantry';
import { MemoryStore, fakeOpenFoodFacts } from './memory-store';

const PASSATA = '5900512300108';
const MYSTERY = '0000000000000';

let store: MemoryStore;
let off: ReturnType<typeof fakeOpenFoodFacts>;

beforeEach(() => {
  store = new MemoryStore();
  off = fakeOpenFoodFacts({ [PASSATA]: { name: 'Passata', brand: 'Łowicz, Other', size: '500 g' } });
});

const scan = (barcode: string, mode: 'in' | 'out') =>
  recordScan(store, barcode, mode, 'test', off.fetch);

describe('recordScan', () => {
  test('scan in creates the pantry row with product details', async () => {
    const result = await scan(PASSATA, 'in');
    assert.equal(result.qty, 1);
    assert.equal(result.name, 'Passata');
    assert.equal(result.brand, 'Łowicz');
    assert.equal(result.queuedForCart, false);
    assert.equal(store.pantry.get(PASSATA)?.size, '500 g');
    assert.equal(store.cart.length, 0);
  });

  test('repeat scans in accumulate and keep first_seen', async () => {
    await scan(PASSATA, 'in');
    const firstSeen = store.pantry.get(PASSATA)!.first_seen;
    await scan(PASSATA, 'in');
    const result = await scan(PASSATA, 'in');
    assert.equal(result.qty, 3);
    assert.equal(store.pantry.get(PASSATA)!.first_seen, firstSeen);
    assert.equal(store.log.length, 3);
  });

  test('scan out decrements and queues for the cart', async () => {
    await scan(PASSATA, 'in');
    await scan(PASSATA, 'in');
    const result = await scan(PASSATA, 'out');
    assert.equal(result.qty, 1);
    assert.equal(result.queuedForCart, true);
    assert.equal(store.cart.length, 1);
    assert.deepEqual(
      { qty: store.cart[0].qty, status: store.cart[0].status },
      { qty: 1, status: 'pending' },
    );
  });

  test('repeat scans out bump the pending row instead of adding rows', async () => {
    await scan(PASSATA, 'out');
    await scan(PASSATA, 'out');
    await scan(PASSATA, 'out');
    assert.equal(store.cart.length, 1);
    assert.equal(store.cart[0].qty, 3);
  });

  test('scan out of an unknown-to-pantry item clamps at zero', async () => {
    const result = await scan(PASSATA, 'out');
    assert.equal(result.qty, 0);
    assert.equal(store.pantry.get(PASSATA)!.qty, 0);
  });

  test('a finished cart row does not absorb new out-scans', async () => {
    await scan(PASSATA, 'out');
    store.cart[0].status = 'done';
    await scan(PASSATA, 'out');
    assert.equal(store.cart.length, 2);
    assert.equal(store.cart[1].status, 'pending');
  });

  test('unknown barcodes get a placeholder and are flagged', async () => {
    const result = await scan(MYSTERY, 'in');
    assert.equal(result.unknownProduct, true);
    assert.equal(result.name, `Unknown item ${MYSTERY}`);
    assert.equal(store.products.get(MYSTERY)?.source, 'unknown');
  });

  test('Open Food Facts is only asked once per barcode', async () => {
    await scan(PASSATA, 'in');
    await scan(PASSATA, 'in');
    await scan(MYSTERY, 'in');
    await scan(MYSTERY, 'in');
    assert.equal(off.calls.length, 2);
  });

  test('a failing lookup still records the scan', async () => {
    const broken = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await recordScan(store, PASSATA, 'in', 'test', broken);
    assert.equal(result.qty, 1);
    assert.equal(result.unknownProduct, true);
  });
});

describe('undoLastScan', () => {
  test('with nothing logged reports nothing to undo', async () => {
    const result = await undoLastScan(store);
    assert.equal(result.undone, false);
  });

  test('undoing an in-scan decrements', async () => {
    await scan(PASSATA, 'in');
    await scan(PASSATA, 'in');
    const result = await undoLastScan(store);
    assert.equal(result.undone, true);
    assert.equal(store.pantry.get(PASSATA)!.qty, 1);
    assert.ok(store.log[1].undone_at);
    assert.equal(store.log[0].undone_at, null);
  });

  test('undoing an out-scan restores stock and takes one off the cart row', async () => {
    await scan(PASSATA, 'in');
    await scan(PASSATA, 'out');
    await scan(PASSATA, 'out');
    await undoLastScan(store);
    assert.equal(store.pantry.get(PASSATA)!.qty, 1);
    assert.equal(store.cart[0].qty, 1);
    assert.equal(store.cart[0].status, 'pending');
  });

  test('undoing the only out-scan cancels the cart row', async () => {
    await scan(PASSATA, 'out');
    await undoLastScan(store);
    assert.equal(store.cart[0].status, 'cancelled');
    assert.equal(store.cart[0].qty, 0);
    assert.deepEqual(await store.listPendingCart(), []);
  });

  test('successive undos walk back through the log, then stop', async () => {
    await scan(PASSATA, 'in');
    await scan(PASSATA, 'in');
    await undoLastScan(store);
    await undoLastScan(store);
    assert.equal(store.pantry.get(PASSATA)!.qty, 0);
    const third = await undoLastScan(store);
    assert.equal(third.undone, false);
  });
});

describe('renameProduct', () => {
  test('renames the catalogue entry and the pantry row', async () => {
    await scan(MYSTERY, 'in');
    await renameProduct(store, MYSTERY, 'Chickpeas', 'Bakalland');
    assert.equal(store.products.get(MYSTERY)?.source, 'manual');
    assert.equal(store.pantry.get(MYSTERY)?.name, 'Chickpeas');
    assert.equal(store.pantry.get(MYSTERY)?.qty, 1);
    // The next scan uses the new name without asking Open Food Facts again.
    const result = await scan(MYSTERY, 'in');
    assert.equal(result.name, 'Chickpeas');
    assert.equal(result.unknownProduct, false);
  });
});
