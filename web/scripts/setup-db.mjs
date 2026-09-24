/**
 * Runs before `next build` on Vercel, where the Supabase integration's env
 * vars are present, so the database never needs credentials on a laptop.
 *
 *   1. Applies every supabase/migrations/*.sql not yet recorded in
 *      public.schema_migrations, each in its own transaction.
 *   2. Makes sure every address in ALLOWED_EMAILS has a (confirmed) Supabase
 *      Auth account, since magic links are only sent to existing users.
 *
 * Both steps are idempotent. With no database configured it skips with a
 * warning instead of failing, so a build without the integration still works.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'supabase', 'migrations');

async function migrate() {
  const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
  if (!url) {
    console.warn('[setup-db] POSTGRES_URL not set; skipping migrations');
    return;
  }

  // prepare: false keeps this working through Supabase's transaction pooler.
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql`
      create table if not exists public.schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )`;
    await sql`alter table public.schema_migrations enable row level security`;

    const applied = new Set((await sql`select name from public.schema_migrations`).map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(migrationsDir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into public.schema_migrations (name) values (${file})`;
      });
      console.log(`[setup-db] applied ${file}`);
    }
  } finally {
    await sql.end();
  }
}

async function ensureUsers() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const emails = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!url || !key || emails.length === 0) {
    console.warn('[setup-db] Supabase keys or ALLOWED_EMAILS missing; skipping users');
    return;
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  for (const email of emails) {
    const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (!error) console.log(`[setup-db] created auth user ${email}`);
    else if (!/already|exists|registered/i.test(error.message)) throw error;
  }
}

await migrate();
await ensureUsers();
