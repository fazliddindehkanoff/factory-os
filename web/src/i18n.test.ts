import { describe, expect, it } from 'vitest';
import { resolveInitialLang } from './i18n';

describe('resolveInitialLang', () => {
  it('only returns languages that exist in the visible switcher', () => {
    expect(resolveInitialLang('uz', 'en-US')).toBe('uz');
    expect(resolveInitialLang('tr', 'en-US')).toBe('tr');
    expect(resolveInitialLang('ru', 'en-US')).toBe('ru');
    expect(resolveInitialLang('en', 'en-US')).toBe('ru');
    expect(resolveInitialLang(null, 'en-US')).toBe('ru');
  });

  it('uses supported browser languages when no preference is saved', () => {
    expect(resolveInitialLang(null, 'uz-UZ')).toBe('uz');
    expect(resolveInitialLang(null, 'tr-TR')).toBe('tr');
    expect(resolveInitialLang(null, 'ru-RU')).toBe('ru');
  });
});
