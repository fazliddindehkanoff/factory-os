/**
 * QA-прогон 2026-07-09, класс «разрывы между слоями» (feature gap / orphaned
 * endpoint / dead client code): каждый эндпоинт канонического API должен иметь
 * обёртку в web/src/api.ts, каждая обёртка — хотя бы один вызов в компонентах,
 * и каждый вызов клиента — существующий эндпоинт. Класс уже кусался:
 * PUT /requests/:id (правка заявки) и POST /admin/users/:id/reset-pin годами
 * жили без UI, а /approvals/:id/approve дублировал lifecycle-движок.
 *
 * compat.routes.ts не сверяется: это API легаси-дизайна public/ (SERVE_DESIGN=1),
 * его клиент — public/index.html, не React-мини-апп.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Эндпоинты, осознанно живущие без обёртки в api.ts (причина обязательна). */
const ENDPOINTS_WITHOUT_CLIENT: string[] = [
  // (пусто — новых добавлять только с причиной в комментарии)
];

/** Обёртки api.*, осознанно не вызываемые из компонентов (причина обязательна). */
const WRAPPERS_WITHOUT_CALLERS: string[] = [
  // (пусто)
];

// ── Сервер: канонический роутер (+ /admin под своим префиксом) ──
function serverEndpoints(): Map<string, string> {
  const files: { f: string; prefix: string }[] = [
    { f: 'src/http/routes.ts', prefix: '' },
    { f: 'src/http/admin.routes.ts', prefix: '/admin' },
  ];
  const out = new Map<string, string>();
  for (const { f, prefix } of files) {
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/\br\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/);
      if (m) out.set(`${m[1].toUpperCase()} ${norm(prefix + m[2])}`, `${f}:${i + 1}`);
    });
  }
  return out;
}

/** :param и ${…} → {}, чтобы пути сервера и клиента сравнивались одинаково. */
function norm(p: string): string {
  return (
    p
      .split('?')[0]
      .replace(/:[A-Za-z_]+/g, '{}')
      .replace(/\$\{[^}]*\}/g, '{}')
      .replace(/\/+$/, '') || '/'
  );
}

// ── Клиент: вызовы call() в api.ts (строка, template literal, конкатенация) ──
function clientCalls(): Map<string, number> {
  const text = readFileSync(join(ROOT, 'web/src/api.ts'), 'utf8');
  const out = new Map<string, number>();
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const line = i + 1;
    let m: RegExpExecArray | null;
    // call('/path', { method: 'PUT' }) / call(`/path/${id}`, ...) — но не конкатенация
    const reQuoted = /call\(\s*(['"`])((?:\\.|(?!\1).)+)\1(?!\s*\+)\s*(?:,\s*\{[^}]*method:\s*'(\w+)')?/g;
    while ((m = reQuoted.exec(l))) out.set(`${m[3] ?? 'GET'} ${norm(m[2])}`, line);
    // call('/path/' + id + '/tail', ...) — если строка кончается на '/', дальше сегмент
    // пути ({}), иначе приклеен query-string и путь уже полон.
    const reConcat = /call\(\s*'([^']+)'\s*\+[^,)]*(?:,\s*\{[^}]*method:\s*'(\w+)')?/g;
    while ((m = reConcat.exec(l))) {
      const path = m[1].endsWith('/') ? m[1] + '{}' : m[1];
      out.set(`${m[2] ?? 'GET'} ${norm(path)}`, line);
    }
    // Сырые fetch('/api/...') / fetch(`/api/...`) — бинарные ответы (blob) идут мимо call().
    const reFetch = /fetch\(\s*(['"`])\/api((?:\\.|(?!\1).)+)\1/g;
    while ((m = reFetch.exec(l))) out.set(`GET ${norm(m[2])}`, line);
  });
  return out;
}

// ── Клиент: обёртки api.* и их использование в компонентах ──
function apiWrappers(): string[] {
  const text = readFileSync(join(ROOT, 'web/src/api.ts'), 'utf8');
  const names: string[] = [];
  // Метод = ключ со значением-функцией (после «:» идёт «(»), в теле которого
  // есть call( или fetch( до следующего такого ключа — объекты-параметры
  // (body: {...}) под определение не попадают.
  const re = /^\s{2,4}(\w+):\s*(?:async\s*)?\(/gm;
  const keys: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) keys.push({ name: m[1], at: m.index });
  keys.forEach((k, i) => {
    const body = text.slice(k.at, keys[i + 1]?.at ?? text.length);
    if (/\b(call|fetch)\(/.test(body)) names.push(k.name);
  });
  return [...new Set(names)];
}

function webSources(): string {
  const parts: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f) && !p.endsWith('api.ts')) parts.push(readFileSync(p, 'utf8'));
    }
  })(join(ROOT, 'web/src'));
  return parts.join('\n');
}

describe('консистентность API-поверхности (сервер ↔ api.ts ↔ компоненты)', () => {
  const server = serverEndpoints();
  const client = clientCalls();

  it('каждый канонический эндпоинт вызывается клиентом (или внесён в исключения)', () => {
    const orphans: string[] = [];
    for (const [k, at] of server) {
      if (!client.has(k) && !ENDPOINTS_WITHOUT_CLIENT.includes(k)) orphans.push(`${k} (${at})`);
    }
    expect(orphans, `Эндпоинты без клиента:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('каждый вызов клиента попадает в существующий эндпоинт', () => {
    const broken: string[] = [];
    for (const [k, line] of client) {
      if (!server.has(k)) broken.push(`${k} (web/src/api.ts:${line})`);
    }
    expect(broken, `Вызовы в несуществующие эндпоинты:\n${broken.join('\n')}`).toEqual([]);
  });

  it('каждая обёртка api.* используется хотя бы одним компонентом', () => {
    const web = webSources();
    const dead = apiWrappers().filter(
      (name) => !new RegExp(`\\.${name}\\b`).test(web) && !WRAPPERS_WITHOUT_CALLERS.includes(name),
    );
    expect(dead, `Мёртвые обёртки api.*: ${dead.join(', ')}`).toEqual([]);
  });
});
