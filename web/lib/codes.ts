/**
 * The control codes the scanner can emit.
 *
 * These strings are what the barcode actually encodes. The listener on the Pi
 * (agent/scanner_listener.py) recognises them locally so it knows which mode
 * it is in; the server recognises them too so the dashboard can show the mode
 * and so a scan posted with the wrong mode can still be classified.
 *
 * Keep this list in sync with CARDS in barcodes/generate.py and CONTROL_CODES
 * in agent/scanner_listener.py.
 */

export const CONTROL_CODES = {
  '!!MODE:IN!!': 'in',
  '!!MODE:OUT!!': 'out',
  '!!MODE:UNDO!!': 'undo',
} as const;

export type ControlAction = (typeof CONTROL_CODES)[keyof typeof CONTROL_CODES];

/** The two persistent scanner modes. `undo` is a one-shot action, not a mode. */
export type Mode = 'in' | 'out';

export const MODE_LABELS: Record<Mode, string> = {
  in: 'Pantry in',
  out: 'Cart out',
};

export const CARDS = [
  {
    code: '!!MODE:IN!!',
    title: 'PANTRY IN',
    blurb: 'Everything scanned after this goes into the pantry sheet.',
    accent: '#1f7a3d',
  },
  {
    code: '!!MODE:OUT!!',
    title: 'CART OUT',
    blurb:
      'Everything scanned after this leaves the pantry and lands in the Frisco cart queue.',
    accent: '#b3421a',
  },
  {
    code: '!!MODE:UNDO!!',
    title: 'UNDO LAST',
    blurb: 'Reverses the most recent scan. Does not change the current mode.',
    accent: '#4b4b4b',
  },
] as const;

export function controlActionFor(code: string): ControlAction | null {
  const normalised = code.trim().toUpperCase();
  return (CONTROL_CODES as Record<string, ControlAction>)[normalised] ?? null;
}

/**
 * Scanners sometimes prepend a zero to a 12-digit UPC, or a store prints an
 * EAN-8. We keep the digits as scanned but strip whitespace and any stray
 * non-alphanumerics so the same tin always hashes to the same row.
 */
export function normaliseBarcode(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/** A barcode that looks like a real retail product code rather than a typo. */
export function looksLikeProductBarcode(code: string): boolean {
  return /^\d{6,14}$/.test(code);
}
