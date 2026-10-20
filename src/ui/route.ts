import { useEffect, useState } from 'react';

/**
 * Hash routing between the home page and the demo, so a reload, a shared link
 * and the browser's Back button all land where the user was, and no server
 * rewrite is needed on a static host:
 *
 *   ''  or '#/'        → home
 *   '#/<section>'      → home, scrolled to <section>
 *   '#/demo'           → the app
 *   '#/demo/<section>' → the app, scrolled to <section>
 */
export type Page = 'home' | 'demo';

export interface Route {
  page: Page;
  section: string | null;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'demo') return { page: 'demo', section: parts[1] ?? null };
  return { page: 'home', section: parts[0] ?? null };
}

export function href(page: Page, section?: string): string {
  const base = page === 'demo' ? '#/demo' : '#/';
  if (!section) return base;
  return page === 'demo' ? `${base}/${section}` : `${base}${section}`;
}

function currentHash(): string {
  return globalThis.location?.hash ?? '';
}

export function useRoute(): Route {
  const [hash, setHash] = useState(currentHash);
  useEffect(() => {
    const update = () => setHash(currentHash());
    globalThis.addEventListener?.('hashchange', update);
    return () => globalThis.removeEventListener?.('hashchange', update);
  }, []);
  return parseRoute(hash);
}

/** Brings a section into view; used after a route change and when the same link is pressed twice. */
export function scrollToSection(section: string | null): void {
  if (!section) {
    // scrollTop rather than scrollTo, which jsdom does not implement.
    const root = globalThis.document?.documentElement;
    if (root) root.scrollTop = 0;
    return;
  }
  globalThis.document?.getElementById(section)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
