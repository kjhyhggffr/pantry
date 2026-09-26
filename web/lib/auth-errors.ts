/**
 * When a magic link fails (expired, already used), Supabase sends the browser
 * to the Site URL with the reason in the query string, e.g.
 * `/?error=access_denied&error_code=otp_expired&error_description=...`.
 * Protected pages bounce unauthenticated visitors to /login; this keeps that
 * failure visible there instead of dropping it with the rest of the query.
 *
 * Supabase repeats the same params in the URL fragment, which never reaches
 * the server, so only the query is looked at.
 */

const AUTH_ERROR_PARAMS = ['error', 'error_code', 'error_description'];

export function hasAuthError(searchParams: URLSearchParams): boolean {
  return AUTH_ERROR_PARAMS.some((name) => searchParams.has(name));
}

/** Where to send a visitor who is not signed in. */
export function loginPathFor(searchParams: URLSearchParams): string {
  return hasAuthError(searchParams) ? '/login?error=1' : '/login';
}
