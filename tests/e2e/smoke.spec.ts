import { expect, test } from '@playwright/test';

/**
 * Smoke test: the app loads, the seed data shows, and an earmark can be
 * approved and undone. One test, end to end, on the production build.
 */
test('app loads, seed data shows, earmark approve and undo work', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/#/demo');

  // Empty state until the demo data is loaded.
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('load-seed').click();

  const safeToSpend = page.getByTestId('safe-to-spend');
  await expect(safeToSpend).toContainText('Rp');
  await expect(page.getByTestId('total-balance')).toContainText('Rp');
  await expect(page.getByTestId('stale-banner')).toHaveCount(0);
  await expect(page.getByTestId('no-earmarks')).toBeVisible();

  const before = (await safeToSpend.textContent()) ?? '';
  expect(before).toMatch(/^Rp [\d.]+$/);

  // Propose an earmark.
  await page.getByTestId('earmark-label').fill('Medical reserve');
  await page.getByTestId('earmark-amount').fill('3000000');
  await page.getByTestId('earmark-submit').click();

  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('earmark.create');
  await expect(page.getByTestId('approval-diff')).toContainText('Safe to spend');

  // Nothing changes before approval.
  await expect(safeToSpend).toHaveText(before);
  await expect(page.getByTestId('no-earmarks')).toBeVisible();

  // Approve and execute.
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approve').click();

  await expect(page.getByTestId('no-pending')).toBeVisible();
  await expect(safeToSpend).not.toHaveText(before);
  await expect(page.getByTestId('audit-executed')).toBeVisible();

  // Undo restores the previous state exactly.
  await page.getByTestId('undo').click();
  await expect(card).toBeVisible();
  await expect(card).toContainText('undo');
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approve').click();

  await expect(page.getByTestId('no-pending')).toBeVisible();
  await expect(safeToSpend).toHaveText(before);
  await expect(page.getByTestId('audit-undone')).toBeVisible();

  // The audit chain still verifies.
  await page.getByTestId('verify-audit').click();
  await expect(page.getByTestId('audit-verification')).toContainText('Chain OK');

  expect(consoleErrors).toEqual([]);
});
