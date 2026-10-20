import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './app-context';
import { AppStateProvider } from './app-state-provider';
import { LanguageProvider } from './language-provider';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <AppStateProvider>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </AppStateProvider>
    </AppProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
