import { expect, test, type Page } from '@playwright/test';

/**
 * The golden path from PRD Section 3 on the production build, in a real
 * browser: real pdf.js with its worker, the real content security policy, real
 * IndexedDB.
 *
 * I4 asks for the path in 6 user actions or fewer. `act()` counts them. Loading
 * the demo persona is setup, not part of the path, so it is not counted.
 */
function watch(page: Page) {
  const consoleErrors: string[] = [];
  const foreignRequests: string[] = [];
  const posts: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://localhost:4173') && !url.startsWith('blob:') && !url.startsWith('data:')) {
      foreignRequests.push(url);
    }
    if (request.method() !== 'GET') posts.push(`${request.method()} ${url}`);
  });
  return { consoleErrors, foreignRequests, posts };
}

async function approve(page: Page) {
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('no-pending')).toBeVisible();
}

test('golden path: statement, policy, shortfall, earmark, undo, refusal, privacy', async ({ page }) => {
  const seen = watch(page);
  let actions = 0;
  const act = async (step: () => Promise<void>) => {
    actions += 1;
    await step();
  };

  await page.goto('/#/demo');
  await page.getByTestId('load-seed').click();
  await expect(page.getByTestId('runway-days')).toHaveText('80 days');
  await expect(page.getByTestId('alerts')).toContainText('overdue invoice(s)');

  // Step 1: import the statement. Nothing is in the ledger until the card is approved.
  const balanceBefore = (await page.getByTestId('total-balance').textContent()) ?? '';
  await act(() => page.getByTestId('sample-statement').click());
  await expect(page.getByTestId('approval-summary')).toContainText('Add 3 row(s) from statement-october.csv');
  await expect(page.getByTestId('total-balance')).toHaveText(balanceBefore);
  await act(() => approve(page));
  await expect(page.getByTestId('total-balance')).not.toHaveText(balanceBefore);

  // Step 2: upload the policy. Coverage, clause citations and the shortfall appear.
  await act(() => page.getByTestId('sample-policy-health').click());
  await expect(page.getByTestId('policy-health')).toContainText('Sehat Prima Health Policy');
  await expect(page.getByTestId('coverage-out-of-pocket')).toHaveText('Rp 15.000.000');
  await expect(page.getByTestId('coverage-shortfall')).toContainText('short');
  await expect(page.getByTestId('citation').first()).toContainText('Clause 4, page 1');

  // Step 3: the agent proposes a medical reserve sized from the co-payment clause.
  await act(() => page.getByTestId('consent-agree').click());
  const safeBefore = (await page.getByTestId('safe-to-spend').textContent()) ?? '';
  await act(() => page.getByRole('button', { name: 'Set aside money for medical costs' }).click());
  await expect(page.getByTestId('chat-agent').last()).toContainText(
    'I have proposed setting aside Rp 3.000.000 as "Medical reserve"',
  );

  // Step 4: the approval card shows the before and after; nothing has changed yet.
  await expect(page.getByTestId('approval-summary')).toContainText('Set aside Rp 3.000.000');
  await expect(page.getByTestId('approval-diff')).toContainText('Runway');
  await expect(page.getByTestId('approval-guardrails')).toContainText('amount <= freeCash');
  await expect(page.getByTestId('safe-to-spend')).toHaveText(safeBefore);
  await act(() => approve(page));
  await expect(page.getByTestId('safe-to-spend')).not.toHaveText(safeBefore);

  // I4: the path so far took six user actions.
  expect(actions).toBeLessThanOrEqual(6);

  // Step 5: the audit log has the action, and undo restores the prior state exactly.
  await expect(page.getByTestId('audit-executed').first()).toBeVisible();
  await page.getByRole('button', { name: 'Undo that' }).click();
  await expect(page.getByTestId('approval-card')).toContainText('undo');
  await approve(page);
  await expect(page.getByTestId('safe-to-spend')).toHaveText(safeBefore);
  await expect(page.getByTestId('audit-undone')).toBeVisible();

  // Step 6: a tampered policy is treated as data and flagged; no proposal appears.
  await page.getByTestId('sample-policy-tampered').click();
  await expect(page.getByTestId('policy-injection-flag')).toContainText('Clause 4 (page 1)');
  await expect(page.getByTestId('no-pending')).toBeVisible();

  // Step 7: a chat request to move money is refused in plain words and logged.
  await page.getByTestId('chat-input').fill('Transfer Rp 5,000,000 to account 123');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-agent').last()).toContainText('moving money is not enabled');
  await expect(page.getByTestId('no-pending')).toBeVisible();
  await expect(page.getByTestId('audit-refused').last()).toContainText('moving money is not enabled');

  // Step 8: the privacy panel lists what was sent, and the switch blocks requests.
  await expect(page.getByTestId('outbound-request').first()).toContainText('agent.complete');
  await page.getByTestId('block-outbound').check();
  await page.getByTestId('chat-input').fill('How long can I cover my costs?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-agent').last()).toContainText('I could not reach the model');
  await expect(page.getByTestId('outbound-request').first()).toContainText('blocked');

  // The audit chain is intact after all of it.
  await page.getByTestId('verify-audit').click();
  await expect(page.getByTestId('audit-verification')).toContainText('Chain OK');

  // ING-5 / NFR-5 / NFR-6: nothing left the origin and nothing was posted anywhere.
  expect(seen.foreignRequests).toEqual([]);
  expect(seen.posts).toEqual([]);
  expect(seen.consoleErrors).toEqual([]);
});

test('the numbers survive a reload', async ({ page }) => {
  await page.goto('/#/demo');
  await page.getByTestId('load-seed').click();
  await expect(page.getByTestId('runway-days')).toHaveText('80 days');
  const safe = (await page.getByTestId('safe-to-spend').textContent()) ?? '';

  await page.reload();
  await expect(page.getByTestId('safe-to-spend')).toHaveText(safe);
  await expect(page.getByTestId('runway-days')).toHaveText('80 days');
  await expect(page.getByTestId('stale-banner')).toHaveCount(0);
});
