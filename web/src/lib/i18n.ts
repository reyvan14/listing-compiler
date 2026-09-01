import type { ReactNode } from 'react';

export const i18n = {
  _: (value: string) => value,
  t: (value: string) => value,
};

export function I18nProvider({ children }: { children: ReactNode; i18n?: unknown }) {
  return children;
}

export function useLingui() {
  return { i18n, t: (value: string) => value };
}
