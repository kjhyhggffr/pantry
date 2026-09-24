'use server';

/**
 * Server actions behind the dashboard's little forms. Each one re-checks the
 * signed-in user: the middleware already guards the page, but an action is
 * its own POST endpoint and should not rely on that alone.
 */

import { revalidatePath } from 'next/cache';

import { renameProduct } from '@/lib/openfoodfacts';
import { recordScan, undoLastScan } from '@/lib/pantry';
import { requireUser } from '@/lib/supabase-auth';
import { getStore } from '@/lib/supabase-store';
import type { CartStatus } from '@/lib/store';
import type { Mode } from '@/lib/codes';

export async function renameProductAction(formData: FormData): Promise<void> {
  await requireUser();
  const barcode = String(formData.get('barcode') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const brand = String(formData.get('brand') ?? '').trim();

  if (!barcode || !name) return;

  await renameProduct(getStore(), barcode, name, brand);
  revalidatePath('/');
}

export async function manualScanAction(formData: FormData): Promise<void> {
  await requireUser();
  const barcode = String(formData.get('barcode') ?? '').trim();
  const mode = (String(formData.get('mode') ?? 'in') === 'out' ? 'out' : 'in') as Mode;

  if (!barcode) return;

  await recordScan(getStore(), barcode, mode, 'dashboard');
  revalidatePath('/');
}

export async function undoAction(): Promise<void> {
  await requireUser();
  await undoLastScan(getStore());
  revalidatePath('/');
}

const DASHBOARD_STATUSES: CartStatus[] = ['done', 'cancelled', 'pending'];

export async function setQueueStatusAction(formData: FormData): Promise<void> {
  await requireUser();
  const id = Number(formData.get('id'));
  const status = String(formData.get('status') ?? '') as CartStatus;

  if (!Number.isInteger(id) || !DASHBOARD_STATUSES.includes(status)) return;

  const store = getStore();
  if (!(await store.getCartItem(id))) return;

  await store.updateCartItem(id, { status });
  revalidatePath('/');
}
