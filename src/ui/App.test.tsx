// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { AppProvider } from './app-context';
import { AppStateProvider } from './app-state-provider';
import { createAppServices, type AppServices } from './services';

/**
 * The UI shell, exercised against the real services on fake-indexeddb: seed
 * load, propose, approve, execute and undo.
 */
const services: AppServices[] = [];

function setup(): AppServices {
  const created = createAppServices({ databaseName: `ui-test-${Math.random().toString(16).slice(2)}` });
  services.push(created);
  render(
    <AppProvider services={created}>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </AppProvider>,
  );
  return created;
}

afterEach(async () => {
  cleanup();
  while (services.length > 0) {
    const current = services.pop();
    if (current) {
      current.db.close();
      await current.db.delete();
    }
  }
});

describe('UI shell', () => {
  it('starts empty and loads the seeded ledger', async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();

    await user.click(screen.getByTestId('load-seed'));

    const safeToSpend = await screen.findByTestId('safe-to-spend');
    expect(safeToSpend.textContent).toMatch(/^Rp /);
    expect(screen.getByTestId('total-balance').textContent).toMatch(/^Rp /);
    expect(screen.getByTestId('no-earmarks')).toBeInTheDocument();
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();
  });

  it('proposes an earmark, shows the approval card and changes nothing until Approve', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));

    const before = (await screen.findByTestId('safe-to-spend')).textContent;

    await user.clear(screen.getByTestId('earmark-amount'));
    await user.type(screen.getByTestId('earmark-amount'), '3000000');
    await user.click(screen.getByTestId('earmark-submit'));

    const card = await screen.findByTestId('approval-card');
    expect(card).toHaveTextContent('earmark.create');
    expect(card).toHaveTextContent('T2');
    expect(screen.getByTestId('approval-diff')).toHaveTextContent('Safe to spend');

    // Nothing has changed yet.
    expect(screen.getByTestId('safe-to-spend').textContent).toBe(before);
    expect(screen.getByTestId('no-earmarks')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('approve')).toBeEnabled());
    await user.click(screen.getByTestId('approve'));

    await waitFor(() => expect(screen.getByTestId('safe-to-spend').textContent).not.toBe(before));
    expect(screen.queryByTestId('no-earmarks')).not.toBeInTheDocument();
    expect(await screen.findByTestId('audit-executed')).toBeInTheDocument();
  });

  it('restores safe-to-spend with the Undo button', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));

    const before = (await screen.findByTestId('safe-to-spend')).textContent;

    await user.clear(screen.getByTestId('earmark-amount'));
    await user.type(screen.getByTestId('earmark-amount'), '2000000');
    await user.click(screen.getByTestId('earmark-submit'));
    await waitFor(() => expect(screen.getByTestId('approve')).toBeEnabled());
    await user.click(screen.getByTestId('approve'));
    await waitFor(() => expect(screen.getByTestId('safe-to-spend').textContent).not.toBe(before));

    await user.click(screen.getByTestId('undo'));
    await waitFor(() => expect(screen.getByTestId('approve')).toBeEnabled());
    await user.click(screen.getByTestId('approve'));

    await waitFor(() => expect(screen.getByTestId('safe-to-spend').textContent).toBe(before));
    expect(await screen.findByTestId('audit-undone')).toBeInTheDocument();
  });

  it('verifies the audit chain from the UI', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));
    await screen.findByTestId('safe-to-spend');

    await user.click(screen.getByTestId('verify-audit'));
    expect(await screen.findByTestId('audit-verification')).toHaveTextContent('Chain OK');
  });

  it('refuses an earmark larger than free cash and says why', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));
    await screen.findByTestId('safe-to-spend');

    await user.clear(screen.getByTestId('earmark-amount'));
    await user.type(screen.getByTestId('earmark-amount'), '999999999');
    await user.click(screen.getByTestId('earmark-submit'));

    expect(await screen.findByTestId('earmark-message')).toHaveTextContent(/refused by guardrails/);
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
    expect(await screen.findByTestId('audit-refused')).toBeInTheDocument();
  });

  it('changes settings only with the PIN', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));
    await screen.findByTestId('safe-to-spend');

    await user.type(screen.getByTestId('settings-cap'), '4000000');
    await user.click(screen.getByTestId('settings-save'));
    expect(await screen.findByTestId('settings-message')).toHaveTextContent('wrong PIN');

    await user.type(screen.getByTestId('settings-pin'), '123456');
    await user.click(screen.getByTestId('settings-save'));
    expect(await screen.findByTestId('settings-message')).toHaveTextContent('Limits updated');
  });

  it('records outbound requests and honours the block switch', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('load-seed'));
    await screen.findByTestId('safe-to-spend');

    expect(screen.getByTestId('privacy-empty')).toBeInTheDocument();

    await user.click(screen.getByTestId('probe-outbound'));
    expect(await screen.findByText(/privacy\.probe/)).toBeInTheDocument();

    await user.click(screen.getByTestId('block-outbound'));
    await user.click(screen.getByTestId('probe-outbound'));
    expect(await screen.findByText('blocked')).toBeInTheDocument();
  });
});
