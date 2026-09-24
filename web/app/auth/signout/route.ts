import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAuthClient } from '@/lib/supabase-auth';

export async function POST(request: NextRequest) {
  const supabase = await supabaseAuthClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${request.nextUrl.origin}/login`, { status: 303 });
}
