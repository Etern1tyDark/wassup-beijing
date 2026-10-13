import { useMemo, type ReactNode } from 'react';
import { createAppServices, type AppServices } from './services';
import { ServicesContext } from './services-context';

export function AppProvider({ children, services }: { children: ReactNode; services?: AppServices }) {
  const value = useMemo(() => services ?? createAppServices(), [services]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}
