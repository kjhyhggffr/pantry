/**
 * Store backed by Supabase Postgres, using the service-role key. Server-only:
 * the key bypasses row-level security, so it must never reach a browser.
 */

import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { CartItem, LogEntry, PantryItem, Product, Store } from './store';

let cached: Store | null = null;

export function getStore(): Store {
  if (!cached) cached = new SupabaseStore(adminClient());
  return cached;
}

function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Unwrap a Supabase response, turning its error into a thrown one. */
function check<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  async getProduct(barcode: string) {
    return check(
      await this.db.from('products').select('*').eq('barcode', barcode).maybeSingle(),
    ) as Product | null;
  }

  async upsertProduct(product: Product) {
    check(
      await this.db
        .from('products')
        .upsert({ ...product, updated_at: new Date().toISOString() }),
    );
  }

  async getPantryItem(barcode: string) {
    return check(
      await this.db.from('pantry').select('*').eq('barcode', barcode).maybeSingle(),
    ) as PantryItem | null;
  }

  async upsertPantryItem(item: PantryItem) {
    check(await this.db.from('pantry').upsert(item));
  }

  async listPantry() {
    return check(
      await this.db.from('pantry').select('*').order('last_seen', { ascending: false }),
    ) as PantryItem[];
  }

  async appendLog(entry: Omit<LogEntry, 'id' | 'undone_at'>) {
    check(await this.db.from('scan_log').insert(entry));
  }

  async lastActiveLog() {
    return check(
      await this.db
        .from('scan_log')
        .select('*')
        .is('undone_at', null)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ) as LogEntry | null;
  }

  async markLogUndone(id: number, at: string) {
    check(await this.db.from('scan_log').update({ undone_at: at }).eq('id', id));
  }

  async recentLog(limit: number) {
    return check(
      await this.db
        .from('scan_log')
        .select('*')
        .order('id', { ascending: false })
        .limit(limit),
    ) as LogEntry[];
  }

  async getPendingCartItem(barcode: string) {
    return check(
      await this.db
        .from('cart_queue')
        .select('*')
        .eq('barcode', barcode)
        .eq('status', 'pending')
        .maybeSingle(),
    ) as CartItem | null;
  }

  async getCartItem(id: number) {
    return check(
      await this.db.from('cart_queue').select('*').eq('id', id).maybeSingle(),
    ) as CartItem | null;
  }

  async insertCartItem(item: Omit<CartItem, 'id'>) {
    check(await this.db.from('cart_queue').insert(item));
  }

  async updateCartItem(id: number, patch: Partial<Omit<CartItem, 'id'>>) {
    check(await this.db.from('cart_queue').update(patch).eq('id', id));
  }

  async listPendingCart() {
    return check(
      await this.db
        .from('cart_queue')
        .select('*')
        .eq('status', 'pending')
        .gt('qty', 0)
        .order('ts', { ascending: true }),
    ) as CartItem[];
  }
}
