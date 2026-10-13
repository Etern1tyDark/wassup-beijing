import { createContext, useContext } from 'react';
import type { AppState } from './app-state';

export interface AppStateValue {
  state: AppState;
  reload: () => void;
  loading: boolean;
}

export const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppStateContext(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppStateContext must be used inside <AppStateProvider>');
  return value;
}
