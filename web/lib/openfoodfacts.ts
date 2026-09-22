/**
 * Barcode -> product name, via Open Food Facts.
 *
 * Free, no API key, and its European grocery coverage is good, which matters
 * if you are shopping on Frisco. Every lookup is cached in the `products` tab
 * so a barcode is only ever fetched once, and anything Open Food Facts does
 * not know gets a placeholder row you can rename from the dashboard.
 */

import { TABS, appendRow, getRecords, updateRow } from './sheets';

export interface Product {
  barcode: string;
  name: string;
  brand: string;
  size: string;
  image_url: string;
  source: 'off' | 'manual' | 'unknown';
}

interface ProductRecord extends Record<string, string> {
  barcode: string;
  name: string;
  brand: string;
  size: string;
  image_url: string;
  source: string;
  updated: string;
}

const OFF_ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_FIELDS = 'product_name,product_name_pl,brands,quantity,image_small_url';

/** Open Food Facts asks every client to identify itself. */
const USER_AGENT =
  'pantry-scanner/1.0 (https://github.com/yourname/pantry-scanner) - personal pantry tracker';

/**
 * Look the barcode up in the cache, then Open Food Facts, then give up and
 * store a placeholder. Always returns something usable.
 */
export async function resolveProduct(barcode: string): Promise<Product> {
  const cached = await readCache(barcode);
  if (cached) return cached;

  const fetched = await fetchFromOpenFoodFacts(barcode);

  const product: Product = fetched ?? {
    barcode,
    name: `Unknown item ${barcode}`,
    brand: '',
    size: '',
    image_url: '',
    source: 'unknown',
  };

  await appendRow(TABS.products, {
    ...product,
    updated: new Date().toISOString(),
  });

  return product;
}

async function readCache(barcode: string): Promise<Product | null> {
  const records = await getRecords<ProductRecord>(TABS.products);
  const hit = records.find((record) => record.barcode === barcode);
  if (!hit) return null;

  return {
    barcode: hit.barcode,
    name: hit.name,
    brand: hit.brand,
    size: hit.size,
    image_url: hit.image_url,
    source: (hit.source as Product['source']) || 'off',
  };
}

async function fetchFromOpenFoodFacts(barcode: string): Promise<Product | null> {
  try {
    const url = `${OFF_ENDPOINT}/${encodeURIComponent(barcode)}.json?fields=${OFF_FIELDS}`;
    const response = await fetch(url, {
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
  barcode: string,
  name: string,
  brand = '',
  size = '',
): Promise<void> {
  const records = await getRecords<ProductRecord>(TABS.products);
  const hit = records.find((record) => record.barcode === barcode);

  const payload = {
    barcode,
    name,
    brand,
    size,
    image_url: hit?.image_url ?? '',
    source: 'manual',
    updated: new Date().toISOString(),
  };

  if (hit) {
    await updateRow(TABS.products, hit._row, payload);
  } else {
    await appendRow(TABS.products, payload);
  }

  // Keep the pantry row's display name in step with the catalogue.
  const pantry = await getRecords<Record<string, string>>(TABS.pantry);
  const pantryHit = pantry.find((record) => record.barcode === barcode);
  if (pantryHit) {
    await updateRow(TABS.pantry, pantryHit._row, {
      ...pantryHit,
      name,
      brand,
      size,
    });
  }
}
