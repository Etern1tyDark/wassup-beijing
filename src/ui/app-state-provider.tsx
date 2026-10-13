import type { ReactNode } from 'react';
import { AppStateContext } from './app-state-context';
import { useAppState } from './use-app-state';

export function AppStateProvider({ children }: { children: ReactNode }) {
  const value = useAppState();
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}
