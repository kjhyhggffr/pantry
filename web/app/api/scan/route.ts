/**
 * POST /api/scan
 *
 * The one endpoint the scanner listener talks to.
 *
 *   { "code": "5900512300108", "mode": "in" }   -> a product scan
 *   { "code": "!!MODE:OUT!!" }                  -> a mode switch
 *   { "code": "!!MODE:UNDO!!" }                 -> reverse the last scan
 *
 * The listener already knows what mode it is in, so it sends `mode` along with
 * every product scan. The server trusts it: the listener is the thing holding
 * the physical scanner, and it keeps working through a deploy or a wobbly
 * connection.
 */

import { NextResponse } from 'next/server';

import { UnauthorizedError, requireToken } from '@/lib/auth';
import { controlActionFor, normaliseBarcode } from '@/lib/codes';
import type { Mode } from '@/lib/codes';
import { recordScan, undoLastScan } from '@/lib/pantry';
import { getStore } from '@/lib/supabase-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Open Food Facts plus a handful of database round-trips; leave headroom.
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    requireToken(request);

    const body = await request.json().catch(() => ({}));
    const rawCode = typeof body.code === 'string' ? body.code : '';
    const code = normaliseBarcode(rawCode);

    if (!code) {
      return NextResponse.json({ ok: false, error: 'No code supplied' }, { status: 400 });
    }

    const control = controlActionFor(code);

    if (control === 'undo') {
      return NextResponse.json(await undoLastScan(getStore()));
    }

    if (control === 'in' || control === 'out') {
      // Nothing to store: the listener holds the mode. Echo it back so the
      // listener can confirm the server agrees, and so a curl test works.
      return NextResponse.json({ ok: true, type: 'mode', mode: control });
    }

    const mode: Mode = body.mode === 'out' ? 'out' : 'in';
    const source = typeof body.source === 'string' ? body.source : 'scanner';

    const result = await recordScan(getStore(), code, mode, source);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[scan] failed', error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
