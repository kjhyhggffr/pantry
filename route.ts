/**
 * GET  /api/queue           -> the items waiting to go into the Frisco cart
 * POST /api/queue           -> mark an item done / failed / cancelled
 *
 * The Frisco MCP needs a logged-in browser session, which is not something a
 * serverless function can hold. So Vercel only ever keeps the list; a worker
 * on your own machine (agent/frisco_worker.py) drains it and reports back.
 */

import { NextResponse } from 'next/server';

import { UnauthorizedError, requireToken } from '@/lib/auth';
import { TABS, getRecords, updateRow } from '@/lib/sheets';
import type { CartQueueRecord } from '@/lib/pantry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'pending']);

export async function GET(request: Request) {
  try {
    requireToken(request);

    const records = await getRecords<CartQueueRecord>(TABS.cartQueue);
    const items = records
      .filter((row) => row.status === 'pending' && Number(row.qty) > 0)
      .map((row) => ({
        row: row._row,
        ts: row.ts,
        barcode: row.barcode,
        name: row.name,
        qty: Number(row.qty) || 1,
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
    const rowNumber = Number(body.row);
    const status = String(body.status ?? '');

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      return NextResponse.json({ ok: false, error: 'Bad row number' }, { status: 400 });
    }
    if (!TERMINAL_STATUSES.has(status)) {
      return NextResponse.json({ ok: false, error: 'Bad status' }, { status: 400 });
    }

    const records = await getRecords<CartQueueRecord>(TABS.cartQueue);
    const target = records.find((row) => row._row === rowNumber);

    if (!target) {
      return NextResponse.json({ ok: false, error: 'No such row' }, { status: 404 });
    }

    await updateRow(TABS.cartQueue, rowNumber, {
      ...target,
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
