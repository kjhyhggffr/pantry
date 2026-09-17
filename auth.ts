/**
 * One shared secret guards every write endpoint. The listener sends it as
 * `Authorization: Bearer <SCANNER_TOKEN>`; the dashboard's own forms send it
 * from the server side, so the browser never sees it.
 *
 * Generate one with:  openssl rand -hex 32
 */

export class UnauthorizedError extends Error {
  constructor() {
    super('Missing or invalid scanner token');
    this.name = 'UnauthorizedError';
  }
}

export function requireToken(request: Request): void {
  const expected = process.env.SCANNER_TOKEN;
  if (!expected) throw new Error('SCANNER_TOKEN is not set on the server');

  const header = request.headers.get('authorization') ?? '';
  const presented = header.replace(/^Bearer\s+/i, '').trim();

  if (!presented || !timingSafeEqual(presented, expected)) {
    throw new UnauthorizedError();
  }
}

/** Constant-time comparison so the token can't be guessed a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
