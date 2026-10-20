import { useCallback, useEffect, useState } from 'react';

/**
 * Light or dark theme. With no stored choice the page follows the operating
 * system (the CSS reads prefers-color-scheme); pressing the toggle stores an
 * explicit choice on <html data-theme>, which the CSS honours over the system.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ui-theme';

function readStoredTheme(): Theme | null {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [stored, setStored] = useState<Theme | null>(readStoredTheme);
  const theme = stored ?? systemTheme();

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (stored) root.dataset['theme'] = stored;
    else delete root.dataset['theme'];
  }, [stored]);

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Without storage the choice lasts until the page is reloaded.
    }
    setStored(next);
  }, [theme]);

  return { theme, toggle };
}
