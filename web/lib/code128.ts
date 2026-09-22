/**
 * Minimal Code 128 (subset B) encoder, dependency-free.
 *
 * Subset B covers every printable ASCII character from space (32) to DEL-1
 * (126), which is all the control codes in lib/codes.ts need. Returns an SVG
 * string so the dashboard can render printable cards without any image
 * pipeline.
 *
 * The bar patterns below are the canonical Code 128 symbol table, one
 * 11-module binary string per symbol value 0..105. A "1" is a bar, a "0" is a
 * space.
 */

const PATTERNS: readonly string[] = [
  '11011001100', '11001101100', '11001100110', '10010011000',
  '10010001100', '10001001100', '10011001000', '10011000100',
  '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100',
  '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100',
  '11100110100', '11100110010', '11011011000', '11011000110',
  '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110',
  '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000',
  '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000',
  '10100001100', '10010110000', '10010000110', '10000101100',
  '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010',
  '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100',
  '11110010010', '11011011110', '11011110110', '11110110110',
  '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100',
  '11010010000', '11010011100',
];

const STOP = '1100011101011';
const START_B = 104;

export function encodeCode128B(text: string): string {
  const values: number[] = [START_B];

  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error(`Code 128 subset B cannot encode character ${JSON.stringify(ch)}`);
    }
    values.push(code - 32);
  }

  // Checksum: start value, then each data value weighted by its 1-based position.
  let checksum = START_B;
  for (let i = 1; i < values.length; i += 1) {
    checksum += values[i] * i;
  }
  values.push(checksum % 103);

  return values.map((v) => PATTERNS[v]).join('') + STOP;
}

export interface BarcodeSvgOptions {
  /** Width of one module in user units. 2 renders crisply on screen and in print. */
  moduleWidth?: number;
  /** Height of the bars, excluding the caption. */
  height?: number;
  /** Modules of blank space on each side. Code 128 wants at least 10. */
  quietZone?: number;
  /** Print the encoded text under the bars. */
  showText?: boolean;
}

/** Render `text` as a self-contained Code 128 SVG string. */
export function barcodeSvg(text: string, options: BarcodeSvgOptions = {}): string {
  const moduleWidth = options.moduleWidth ?? 2;
  const height = options.height ?? 80;
  const quietZone = options.quietZone ?? 12;
  const showText = options.showText ?? true;

  const bits = encodeCode128B(text);
  const captionHeight = showText ? 20 : 0;
  const totalModules = bits.length + quietZone * 2;
  const width = totalModules * moduleWidth;
  const totalHeight = height + captionHeight;

  const bars: string[] = [];
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === '0') {
      index += 1;
      continue;
    }
    let run = 0;
    while (index + run < bits.length && bits[index + run] === '1') {
      run += 1;
    }
    const x = (quietZone + index) * moduleWidth;
    bars.push(
      `<rect x="${x}" y="0" width="${run * moduleWidth}" height="${height}" />`,
    );
    index += run;
  }

  const caption = showText
    ? `<text x="${width / 2}" y="${height + 15}" text-anchor="middle" ` +
      `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" ` +
      `letter-spacing="1.5" fill="#16150f">${escapeXml(text)}</text>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" ` +
    `viewBox="0 0 ${width} ${totalHeight}" role="img" aria-label="Barcode: ${escapeXml(text)}">` +
    `<rect width="${width}" height="${totalHeight}" fill="#ffffff" />` +
    `<g fill="#000000">${bars.join('')}</g>${caption}</svg>`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
