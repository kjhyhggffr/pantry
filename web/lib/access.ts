/**
 * Who may use the dashboard. ALLOWED_EMAILS is a comma-separated list; when it
 * is unset nobody gets in, so a missing env var fails closed rather than open.
 *
 * This sits on top of Supabase's own checks (sign-up disabled, magic links
 * only for existing users): even an account created some other way cannot
 * see the pantry unless its address is on this list.
 */

export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
