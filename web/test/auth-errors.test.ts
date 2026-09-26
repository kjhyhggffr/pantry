import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loginPathFor } from '../lib/auth-errors';

const params = (query: string) => new URLSearchParams(query);

test('a failed magic link lands on the login page with the error shown', () => {
  const failed = params(
    'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
  );
  assert.equal(loginPathFor(failed), '/login?error=1');
});

test('any one of the Supabase error params is enough', () => {
  assert.equal(loginPathFor(params('error=access_denied')), '/login?error=1');
  assert.equal(loginPathFor(params('error_code=otp_expired')), '/login?error=1');
  assert.equal(loginPathFor(params('error_description=nope')), '/login?error=1');
});

test('an ordinary visit goes to a plain login page', () => {
  assert.equal(loginPathFor(params('')), '/login');
  assert.equal(loginPathFor(params('sent=1&next=%2F')), '/login');
});
