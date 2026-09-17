'use server';

/**
 * Server actions behind the dashboard's little forms. Using actions rather
 * than client-side fetch keeps SCANNER_TOKEN on the server -- the browser
 * never needs it, so the dashboard has no secret to leak.
 */

import { revalidatePath } from 'next/cache';

import { renameProduct } from '@/lib/openfoodfacts';
import { recordScan, undoLastScan } from '@/lib/pantry';
import { TABS, getRecords, updateRow } from '@/lib/sheets';
import type { CartQueueRecord } from '@/lib/pantry';
import type { Mode } from '@/lib/codes';

export async function renameProductAction(formData: FormData): Promise<void> {
  const barcode = String(formData.get('barcode') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const brand = String(formData.get('brand') ?? '').trim();

  if (!barcode || !name) return;

  await renameProduct(barcode, name, brand);
  revalidatePath('/');
}

export async function manualScanAction(formData: FormData): Promise<void> {
  const barcode = String(formData.get('barcode') ?? '').trim();
  const mode = (String(formData.get('mode') ?? 'in') === 'out' ? 'out' : 'in') as Mode;

  if (!barcode) return;

  await recordScan(barcode, mode, 'dashboard');
  revalidatePath('/');
}

export async function undoAction(): Promise<void> {
  await undoLastScan();
  revalidatePath('/');
}

export async function setQueueStatusAction(formData: FormData): Promise<void> {
  const row = Number(formData.get('row'));
  const status = String(formData.get('status') ?? '');

  if (!Number.isInteger(row) || !['done', 'cancelled', 'pending'].includes(status)) {
    return;
  }

  const records = await getRecords<CartQueueRecord>(TABS.cartQueue);
  const target = records.find((record) => record._row === row);
  if (!target) return;

  await updateRow(TABS.cartQueue, row, { ...target, status });
  revalidatePath('/');
}
