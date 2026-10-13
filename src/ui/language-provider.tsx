import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { LanguageContext, readStoredLanguage, storeLanguage, type Language } from './i18n';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo(
    () => ({
      language,
      setLanguage: (next: Language) => {
        storeLanguage(next);
        setLanguageState(next);
      },
    }),
    [language],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
