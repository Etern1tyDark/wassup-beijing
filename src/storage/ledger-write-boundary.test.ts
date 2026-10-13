import { describe, expect, it } from 'vitest';
// Plain ESM tool shared with `npm run lint:boundary`.
import { scanLedgerWrites } from '../../tools/check-ledger-writes.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('ledger write boundary (LED-3)', () => {
  it('finds no violation in the source tree', () => {
    const { violations, checked } = scanLedgerWrites(decodeURIComponent(root));
    expect(checked).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });
});
