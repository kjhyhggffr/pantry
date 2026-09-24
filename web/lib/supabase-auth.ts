/**
 * Supabase Auth for the dashboard: a cookie-backed client using the public
 * (anon/publishable) key. It can only manage the session -- row-level security
 * keeps it away from the pantry tables, which the server reads with the
 * service-role key in lib/supabase-store.ts.
 */

import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

import { isAllowedEmail } from './access';

export function supabasePublicEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
  }
  return { url, key };
}

export async function supabaseAuthClient() {
  const cookieStore = await cookies();
  const { url, key } = supabasePublicEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot set cookies; the middleware refreshes them.
        }
      },
    },
  });
}

/** The signed-in, allow-listed user, or a redirect to /login. */
export async function requireUser(): Promise<User> {
  const supabase = await supabaseAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAllowedEmail(user.email)) redirect('/login');
  return user;
}
