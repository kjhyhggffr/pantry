/**
 * Barcode -> product name, via Open Food Facts.
 *
 * Free, no API key, and its European grocery coverage is good, which matters
 * if you are shopping on Frisco. Every lookup is cached in the `products`
 * table so a barcode is only ever fetched once, and anything Open Food Facts
 * does not know gets a placeholder row you can rename from the dashboard.
 */

import type { Product, Store } from './store';

export type Fetch = typeof fetch;

const OFF_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_FIELDS = 'product_name,product_name_pl,brands,quantity,image_small_url';

/** Open Food Facts asks every client to identify itself. */
const USER_AGENT =
  'pantry-scanner/1.0 (https://github.com/kjhyhggffr/pantry) - personal pantry tracker';

export const UNKNOWN_PREFIX = 'Unknown item ';

/**
 * Look the barcode up in the cache, then Open Food Facts, then give up and
 * store a placeholder. Always returns something usable.
 */
export async function resolveProduct(
  store: Store,
  barcode: string,
  fetchImpl: Fetch = fetch,
): Promise<Product> {
  const cached = await store.getProduct(barcode);
  if (cached) return cached;

  const fetched = await fetchFromOpenFoodFacts(barcode, fetchImpl);

  const product: Product = fetched ?? {
    barcode,
    name: `${UNKNOWN_PREFIX}${barcode}`,
    brand: '',
    size: '',
    image_url: '',
    source: 'unknown',
  };

  await store.upsertProduct(product);
  return product;
}

async function fetchFromOpenFoodFacts(
  barcode: string,
  fetchImpl: Fetch,
): Promise<Product | null> {
  try {
    const url = `${OFF_ENDPOINT}/${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`;
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });

    if (!response.ok) return null;

    const body = await response.json();
    if (body.status !== 1 || !body.product) return null;

    const name: string = body.product.product_name_pl || body.product.product_name || '';
    if (!name.trim()) return null;

    return {
      barcode,
      name: name.trim(),
      brand: (body.product.brands ?? '').split(',')[0].trim(),
      size: (body.product.quantity ?? '').trim(),
      image_url: body.product.image_small_url ?? '',
      source: 'off',
    };
  } catch {
    // A lookup failure must never lose a scan. Fall through to the placeholder.
    return null;
  }
}

/** Rename a cached product, e.g. from the dashboard's unknown-items list. */
export async function renameProduct(
  store: Store,
  barcode: string,
  name: string,
  brand = '',
  size = '',
): Promise<void> {
  const hit = await store.getProduct(barcode);

  await store.upsertProduct({
    barcode,
    name,
    brand,
    size,
    image_url: hit?.image_url ?? '',
    source: 'manual',
  });

  // Keep the pantry row's display name in step with the catalogue.
  const pantryHit = await store.getPantryItem(barcode);
  if (pantryHit) {
    await store.upsertPantryItem({ ...pantryHit, name, brand, size });
  }
}
