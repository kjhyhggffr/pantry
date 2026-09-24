/**
 * The storage seam. Everything that decides *what* happens to the pantry
 * (lib/pantry.ts, lib/openfoodfacts.ts) talks to this interface; only
 * lib/supabase-store.ts knows it is Postgres underneath. Tests hand in an
 * in-memory implementation instead.
 */

import type { Mode } from './codes';

export type ProductSource = 'off' | 'manual' | 'unknown';
export type CartStatus = 'pending' | 'done' | 'failed' | 'cancelled';

export interface Product {
  barcode: string;
  name: string;
  brand: string;
  size: string;
  image_url: string;
  source: ProductSource;
}

export interface PantryItem {
  barcode: string;
  name: string;
  brand: string;
  size: string;
  qty: number;
  first_seen: string;
  last_seen: string;
}

export interface LogEntry {
  id: number;
  ts: string;
  direction: Mode;
  barcode: string;
  name: string;
  qty_after: number;
  source: string;
  undone_at: string | null;
}

export interface CartItem {
  id: number;
  ts: string;
  barcode: string;
  name: string;
  qty: number;
  status: CartStatus;
  frisco_product_id: string | null;
  frisco_product_name: string | null;
  note: string | null;
}

export interface Store {
  getProduct(barcode: string): Promise<Product | null>;
  upsertProduct(product: Product): Promise<void>;

  getPantryItem(barcode: string): Promise<PantryItem | null>;
  upsertPantryItem(item: PantryItem): Promise<void>;
  listPantry(): Promise<PantryItem[]>;

  appendLog(entry: Omit<LogEntry, 'id' | 'undone_at'>): Promise<void>;
  /** The newest log entry that has not been undone, if any. */
  lastActiveLog(): Promise<LogEntry | null>;
  markLogUndone(id: number, at: string): Promise<void>;
  recentLog(limit: number): Promise<LogEntry[]>;

  getPendingCartItem(barcode: string): Promise<CartItem | null>;
  getCartItem(id: number): Promise<CartItem | null>;
  insertCartItem(item: Omit<CartItem, 'id'>): Promise<void>;
  updateCartItem(id: number, patch: Partial<Omit<CartItem, 'id'>>): Promise<void>;
  listPendingCart(): Promise<CartItem[]>;
}
