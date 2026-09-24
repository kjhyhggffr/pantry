import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { isAllowedEmail } from '../lib/access';

const original = process.env.ALLOWED_EMAILS;
afterEach(() => {
  process.env.ALLOWED_EMAILS = original;
});

test('fails closed when ALLOWED_EMAILS is unset', () => {
  delete process.env.ALLOWED_EMAILS;
  assert.equal(isAllowedEmail('someone@example.com'), false);
});

test('matches case- and whitespace-insensitively', () => {
  process.env.ALLOWED_EMAILS = ' Owner@Example.com , second@example.com';
  assert.equal(isAllowedEmail('owner@example.com'), true);
  assert.equal(isAllowedEmail('SECOND@example.com '), true);
});

test('rejects everyone else, and missing emails', () => {
  process.env.ALLOWED_EMAILS = 'owner@example.com';
  assert.equal(isAllowedEmail('owner@example.com.evil.test'), false);
  assert.equal(isAllowedEmail(undefined), false);
  assert.equal(isAllowedEmail(''), false);
});
