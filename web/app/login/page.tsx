/**
 * Magic-link sign-in. Supabase only mails a link to an address that already
 * has an account (shouldCreateUser: false), and the app refuses anything not
 * on ALLOWED_EMAILS before even asking. The page says the same thing either
 * way, so it does not reveal which addresses are allowed.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { isAllowedEmail } from '@/lib/access';
import { supabaseAuthClient } from '@/lib/supabase-auth';

export const dynamic = 'force-dynamic';

async function sendLinkAction(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '').trim().toLowerCase();

  if (isAllowedEmail(email)) {
    const requestHeaders = await headers();
    const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
    const proto = requestHeaders.get('x-forwarded-proto') ?? 'https';

    const supabase = await supabaseAuthClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${proto}://${host}/auth/callback`,
      },
    });
    if (error) console.error('[login] signInWithOtp failed', error.message);
  }

  redirect('/login?sent=1');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return (
    <main>
      <h1>Pantry scanner</h1>
      <section className="panel">
        <h2>Sign in</h2>
        {sent ? (
          <p>If that address is allowed in, a sign-in link is on its way. Check your inbox.</p>
        ) : (
          <form action={sendLinkAction} className="manual">
            <input name="email" type="email" placeholder="you@example.com" required />
            <button type="submit" className="button">
              Email me a link
            </button>
          </form>
        )}
        {error && <p className="muted">That link did not work. Ask for a new one.</p>}
      </section>
    </main>
  );
}
