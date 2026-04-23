import { createI18n } from 'vue-i18n';
import en from './en.json';
import zh from './zh.json';

function detectLocale(): 'en' | 'zh' {
  const stored = localStorage.getItem('esp-pt-locale');
  if (stored === 'en' || stored === 'zh') return stored;
  const nav = navigator.language.toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { en, zh },
});
