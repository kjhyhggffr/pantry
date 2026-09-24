/**
 * Every page except /login and the auth callback needs a signed-in,
 * allow-listed user. The machine endpoints (/api/scan, /api/queue) are left
 * out of the matcher entirely: they are guarded by SCANNER_TOKEN instead,
 * because the scanner has no browser to log in with.
 *
 * This also refreshes the Supabase session cookie on each request.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { isAllowedEmail } from './lib/access';

const PUBLIC_PATHS = ['/login', '/auth/'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((path) => pathname.startsWith(path));

  // Misconfigured: fail closed on protected pages instead of showing data.
  if (!url || !key) {
    return isPublic ? response : new NextResponse('Auth is not configured', { status: 503 });
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isPublic && (!user || !isAllowedEmail(user.email))) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  matcher: ['/((?!api/scan|api/queue|_next/static|_next/image|favicon.ico).*)'],
};
