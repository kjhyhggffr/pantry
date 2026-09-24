/**
 * GET  /api/queue           -> the items waiting to go into the Frisco cart
 * POST /api/queue           -> mark an item done / failed / cancelled
 *
 * The Frisco CLI needs a logged-in browser session, which is not something a
 * serverless function can hold. So Vercel only ever keeps the list; a worker
 * on your own machine (agent/frisco_worker.py) drains it and reports back.
 */

import { NextResponse } from 'next/server';

import { UnauthorizedError, requireToken } from '@/lib/auth';
import { getStore } from '@/lib/supabase-store';
import type { CartStatus } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STATUSES = new Set<CartStatus>(['done', 'failed', 'cancelled', 'pending']);

export async function GET(request: Request) {
  try {
    requireToken(request);

    const items = (await getStore().listPendingCart()).map((row) => ({
      id: row.id,
      ts: row.ts,
      barcode: row.barcode,
      name: row.name,
      qty: row.qty || 1,
    }));

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireToken(request);

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    const status = String(body.status ?? '') as CartStatus;

    if (!Number.isInteger(id) || id < 1) {
      return NextResponse.json({ ok: false, error: 'Bad id' }, { status: 400 });
    }
    if (!STATUSES.has(status)) {
      return NextResponse.json({ ok: false, error: 'Bad status' }, { status: 400 });
    }

    const store = getStore();
    const target = await store.getCartItem(id);

    if (!target) {
      return NextResponse.json({ ok: false, error: 'No such item' }, { status: 404 });
    }

    await store.updateCartItem(id, {
      status,
      frisco_product_id: body.friscoProductId ?? target.frisco_product_id,
      frisco_product_name: body.friscoProductName ?? target.frisco_product_name,
      note: body.note ?? target.note,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error('[queue] failed', error);
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
