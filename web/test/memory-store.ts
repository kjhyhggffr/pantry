/** In-memory Store for tests: same contract as lib/supabase-store.ts, no network. */

import type { CartItem, LogEntry, PantryItem, Product, Store } from '../lib/store';

export class MemoryStore implements Store {
  products = new Map<string, Product>();
  pantry = new Map<string, PantryItem>();
  log: LogEntry[] = [];
  cart: CartItem[] = [];
  private nextLogId = 1;
  private nextCartId = 1;

  async getProduct(barcode: string) {
    return clone(this.products.get(barcode) ?? null);
  }
  async upsertProduct(product: Product) {
    this.products.set(product.barcode, clone(product));
  }

  async getPantryItem(barcode: string) {
    return clone(this.pantry.get(barcode) ?? null);
  }
  async upsertPantryItem(item: PantryItem) {
    if (item.qty < 0) throw new Error('qty check constraint violated');
    this.pantry.set(item.barcode, clone(item));
  }
  async listPantry() {
    return [...this.pantry.values()].map(clone);
  }

  async appendLog(entry: Omit<LogEntry, 'id' | 'undone_at'>) {
    this.log.push({ ...entry, id: this.nextLogId++, undone_at: null });
  }
  async lastActiveLog() {
    const active = this.log.filter((entry) => !entry.undone_at);
    return clone(active.at(-1) ?? null);
  }
  async markLogUndone(id: number, at: string) {
    const entry = this.log.find((e) => e.id === id);
    if (entry) entry.undone_at = at;
  }
  async recentLog(limit: number) {
    return this.log.slice(-limit).reverse().map(clone);
  }

  async getPendingCartItem(barcode: string) {
    return clone(this.cart.find((c) => c.barcode === barcode && c.status === 'pending') ?? null);
  }
  async getCartItem(id: number) {
    return clone(this.cart.find((c) => c.id === id) ?? null);
  }
  async insertCartItem(item: Omit<CartItem, 'id'>) {
    // Mirrors the cart_queue_one_pending unique index.
    if (item.status === 'pending' && (await this.getPendingCartItem(item.barcode))) {
      throw new Error('duplicate pending cart row');
    }
    this.cart.push({ ...item, id: this.nextCartId++ });
  }
  async updateCartItem(id: number, patch: Partial<Omit<CartItem, 'id'>>) {
    const item = this.cart.find((c) => c.id === id);
    if (item) Object.assign(item, patch);
  }
  async listPendingCart() {
    return this.cart.filter((c) => c.status === 'pending' && c.qty > 0).map(clone);
  }
}

function clone<T>(value: T): T {
  return value === null ? value : structuredClone(value);
}

/** A fetch that answers every Open Food Facts lookup from a fixed table. */
export function fakeOpenFoodFacts(
  known: Record<string, { name: string; brand?: string; size?: string }>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fake = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const barcode = decodeURIComponent(url.split('/product/')[1].split('.json')[0]);
    const hit = known[barcode];
    const body = hit
      ? {
          status: 1,
          product: { product_name: hit.name, brands: hit.brand ?? '', quantity: hit.size ?? '' },
        }
      : { status: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetch: fake, calls };
}
