/**
 * A very small Google Sheets client.
 *
 * The spreadsheet is the entire database: no Postgres, no KV, nothing else to
 * pay for or keep alive. That is a deliberate trade -- a few hundred pantry
 * items is well inside what Sheets handles comfortably, and you get a free
 * editable UI on your phone.
 *
 * Auth is a service account. Create one in Google Cloud, enable the Sheets
 * API, download the JSON key, then share the spreadsheet with the service
 * account's email address as an Editor. See README.md.
 */

import { JWT } from 'google-auth-library';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export const TABS = {
  pantry: 'pantry',
  log: 'log',
  cartQueue: 'cart_queue',
  products: 'products',
} as const;

export const HEADERS: Record<string, string[]> = {
  [TABS.pantry]: ['barcode', 'name', 'brand', 'size', 'qty', 'first_seen', 'last_seen'],
  [TABS.log]: ['ts', 'direction', 'barcode', 'name', 'qty_after', 'source', 'undone'],
  [TABS.cartQueue]: [
    'ts',
    'barcode',
    'name',
    'qty',
    'status',
    'frisco_product_id',
    'frisco_product_name',
    'note',
  ],
  [TABS.products]: ['barcode', 'name', 'brand', 'size', 'image_url', 'source', 'updated'],
};

let cachedClient: JWT | null = null;
let tabsEnsured = false;

function spreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID is not set');
  return id;
}

function authClient(): JWT {
  if (cachedClient) return cachedClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must both be set',
    );
  }

  // Vercel's env UI stores the newlines in the PEM as literal backslash-n.
  const key = rawKey.replace(/\\n/g, '\n');

  cachedClient = new JWT({ email, key, scopes: SCOPES });
  return cachedClient;
}

async function sheetsFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<any> {
  const client = authClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not get a Google access token');

  const url = new URL(`${SHEETS_API}/${spreadsheetId()}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sheets API ${response.status} on ${path}: ${body.slice(0, 400)}`);
  }

  return response.json();
}

/**
 * Create any missing tab and write its header row. Cheap enough to call on
 * every cold start, and it means a brand-new empty spreadsheet just works.
 */
export async function ensureTabs(): Promise<void> {
  if (tabsEnsured) return;

  const meta = await sheetsFetch('', { query: { fields: 'sheets.properties.title' } });
  const existing = new Set<string>(
    (meta.sheets ?? []).map((s: any) => s.properties.title),
  );

  const missing = Object.values(TABS).filter((tab) => !existing.has(tab));

  if (missing.length > 0) {
    await sheetsFetch(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      }),
    });

    for (const tab of missing) {
      await sheetsFetch(`/values/${encodeURIComponent(`${tab}!A1`)}`, {
        method: 'PUT',
        query: { valueInputOption: 'RAW' },
        body: JSON.stringify({ values: [HEADERS[tab]] }),
      });
    }
  }

  tabsEnsured = true;
}

/** Every data row of a tab, header excluded, padded to the header width. */
export async function getRows(tab: string): Promise<string[][]> {
  await ensureTabs();
  const data = await sheetsFetch(`/values/${encodeURIComponent(tab)}`, {
    query: { majorDimension: 'ROWS' },
  });

  const values: string[][] = data.values ?? [];
  const width = HEADERS[tab].length;

  return values
    .slice(1)
    .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

/** Rows as objects keyed by the header names, plus the 1-based sheet row number. */
export async function getRecords<T extends Record<string, string>>(
  tab: string,
): Promise<Array<T & { _row: number }>> {
  const rows = await getRows(tab);
  const headers = HEADERS[tab];

  return rows.map((row, index) => {
    const record: Record<string, string | number> = { _row: index + 2 };
    headers.forEach((header, i) => {
      record[header] = row[i] ?? '';
    });
    return record as T & { _row: number };
  });
}

export async function appendRow(tab: string, record: Record<string, unknown>): Promise<void> {
  await ensureTabs();
  const row = HEADERS[tab].map((header) => stringify(record[header]));

  await sheetsFetch(`/values/${encodeURIComponent(`${tab}!A1`)}:append`, {
    method: 'POST',
    query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    body: JSON.stringify({ values: [row] }),
  });
}

export async function updateRow(
  tab: string,
  rowNumber: number,
  record: Record<string, unknown>,
): Promise<void> {
  await ensureTabs();
  const row = HEADERS[tab].map((header) => stringify(record[header]));
  const lastColumn = columnLetter(HEADERS[tab].length);

  await sheetsFetch(
    `/values/${encodeURIComponent(`${tab}!A${rowNumber}:${lastColumn}${rowNumber}`)}`,
    {
      method: 'PUT',
      query: { valueInputOption: 'RAW' },
      body: JSON.stringify({ values: [row] }),
    },
  );
}

/** Overwrite a single cell, addressed by header name. */
export async function updateCell(
  tab: string,
  rowNumber: number,
  header: string,
  value: unknown,
): Promise<void> {
  await ensureTabs();
  const index = HEADERS[tab].indexOf(header);
  if (index === -1) throw new Error(`No column "${header}" on tab "${tab}"`);

  const cell = `${columnLetter(index + 1)}${rowNumber}`;
  await sheetsFetch(`/values/${encodeURIComponent(`${tab}!${cell}`)}`, {
    method: 'PUT',
    query: { valueInputOption: 'RAW' },
    body: JSON.stringify({ values: [[stringify(value)]] }),
  });
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function columnLetter(oneBasedIndex: number): string {
  let index = oneBasedIndex;
  let letters = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    index = Math.floor((index - 1) / 26);
  }
  return letters;
}
