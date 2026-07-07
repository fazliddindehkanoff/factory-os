/**
 * QA-прогон 2026-07-07, класс «баги данных/миграций»: журнал drizzle и файлы
 * миграций обязаны совпадать 1:1 и монотонно — рассинхрон уже кусался на проде
 * (0011–0013 применены мимо журнала → db:migrate падал с 42710).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'drizzle');

describe('консистентность миграций', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  it('каждой записи журнала соответствует файл, и наоборот', () => {
    const tags = journal.entries.map((e) => e.tag).sort();
    const names = files.map((f) => f.replace(/\.sql$/, '')).sort();
    expect(names).toEqual(tags);
  });

  it('idx и when в журнале строго возрастают, дублей тегов нет', () => {
    const es = journal.entries;
    for (let i = 1; i < es.length; i++) {
      expect(es[i].idx, `idx не возрастает на ${es[i].tag}`).toBe(es[i - 1].idx + 1);
      expect(es[i].when, `when не возрастает на ${es[i].tag}`).toBeGreaterThan(es[i - 1].when);
    }
    expect(new Set(es.map((e) => e.tag)).size).toBe(es.length);
  });

  it('sql-файлы без CRLF (классика с Windows-копирований)', () => {
    for (const f of files) {
      const body = readFileSync(join(DIR, f), 'utf8');
      expect(body.includes('\r'), `${f} содержит CRLF`).toBe(false);
    }
  });
});
