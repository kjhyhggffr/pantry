/**
 * Where the magic link lands. Supabase sends either a PKCE `code` (the
 * default email template) or a `token_hash` (a customised template); both
 * end in a session cookie and a redirect to the dashboard.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { supabaseAuthClient } from '@/lib/supabase-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  const supabase = await supabaseAuthClient();

  let failed = true;
  if (code) {
    failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  } else if (tokenHash && type) {
    failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error);
  }

  return NextResponse.redirect(`${origin}${failed ? '/login?error=1' : '/'}`);
}
