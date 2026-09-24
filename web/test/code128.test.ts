import assert from 'node:assert/strict';
import { test } from 'node:test';

import { barcodeSvg, encodeCode128B } from '../lib/code128';
import { CONTROL_CODES } from '../lib/codes';
import { PYTHON_BARCODE } from './code128.fixtures';

for (const [text, expected] of Object.entries(PYTHON_BARCODE)) {
  test(`encodes ${JSON.stringify(text)} exactly like python-barcode`, () => {
    assert.equal(encodeCode128B(text), expected);
  });
}

test('every control code is covered by a fixture', () => {
  for (const code of Object.keys(CONTROL_CODES)) {
    assert.ok(code in PYTHON_BARCODE, `missing fixture for ${code}`);
  }
});

test('rejects characters outside subset B', () => {
  assert.throws(() => encodeCode128B('żółw'));
  assert.throws(() => encodeCode128B('tab\there'));
});

test('renders an SVG', () => {
  assert.match(barcodeSvg('!!MODE:IN!!'), /^<svg[\s\S]*<\/svg>$/);
});
