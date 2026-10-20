import { expect, test } from '@playwright/test';

/**
 * The home page and the route to and from the demo. The demo used to be a
 * one-way door: once the ledger was loaded the landing page never came back.
 */
test('home page launches the demo, and the demo leads back home', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('asks before it acts');

  await page.getByTestId('launch-demo').click();
  await expect(page).toHaveURL(/#\/demo$/);
  await page.getByTestId('load-seed').click();
  await expect(page.getByTestId('safe-to-spend')).toContainText('Rp');

  // The browser's Back button returns home, and the dashboard is one click away again.
  await page.goBack();
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('launch-demo')).toContainText('Open your dashboard');
  await page.getByTestId('launch-demo').click();
  await expect(page.getByTestId('safe-to-spend')).toBeVisible();

  // So does the Home link in the top bar, and a reload keeps the route.
  await page.getByTestId('go-home').click();
  await expect(page.getByTestId('home')).toBeVisible();
  await page.goto('/#/demo/trust');
  await expect(page.getByTestId('audit-log')).toBeInViewport();
  await page.reload();
  await expect(page.getByTestId('audit-log')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
