// S49: every error code the API can answer has a Vietnamese and an English text in the web dictionary
// (apps/web/src/i18n/dict/errors.ts), and every {placeholder} of those texts is filled by the throw site's params.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERRORS } from '../../web/src/i18n/dict/errors';

const SRC = join(__dirname, '../src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const sources = files.map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

/** Top-level arguments of the call whose '(' is at `open` (skips strings, template literals and nesting). */
function callArgs(s: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      i = s.indexOf(c, i + 1);
      while (s[i - 1] === '\\') i = s.indexOf(c, i + 1);
      continue;
    }
    if (c === '`') {
      // template literal: skip to the closing backtick, minding ${ ... } (no nested templates in these files)
      i++;
      while (s[i] !== '`') {
        if (s[i] === '\\') i++;
        else if (s[i] === '$' && s[i + 1] === '{') {
          let d = 0;
          for (; ; i++) {
            if (s[i] === '{') d++;
            else if (s[i] === '}' && --d === 0) break;
          }
        }
        i++;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        args.push(s.slice(start, i).trim());
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}

/** Keys of an object literal argument ("{ a: 1, b }" -> a, b). */
function objectKeys(arg: string | undefined): string[] {
  if (!arg) return [];
  const inner = arg.trim();
  if (!inner.startsWith('{')) return ['*']; // a variable: cannot check, accept everything
  return callArgs(`(${inner.slice(1, -1)})`, 0).map((p) => p.match(/^(\w+)/)?.[1] ?? '').filter(Boolean);
}

interface Site { file: string; code: string; params: string[] }
const sites: Site[] = [];
for (const { file, text } of sources) {
  for (const m of text.matchAll(/new ApiError\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = callArgs(text, open);
    if (file === 'errors.ts' && args[1] === 'code') continue; // the class itself
    const code = args[1]!.match(/^'([a-z0-9_]+)'$/)?.[1];
    if (!code) throw new Error(`${file}: ApiError code is not a string literal: ${args[1]}`);
    sites.push({ file, code, params: objectKeys(args[3]) });
  }
}
// codes produced by the exception filter itself (problem(...) without params)
const filter = sources.find((s) => s.file === 'errors.ts')!.text;
for (const m of filter.matchAll(/problem\(([^;]*)\)/g)) for (const c of m[1]!.matchAll(/'([a-z0-9_]+)'/g)) sites.push({ file: 'errors.ts', code: c[1]!, params: [] });

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

describe('API error codes (S49)', () => {
  it('finds the throw sites', () => {
    expect(sites.length).toBeGreaterThan(100);
    expect(sites.map((s) => s.code)).toEqual(expect.arrayContaining(['invalid_request', 'route_not_found', 'internal_error', 'not_found', 'error']));
  });

  it('vi and en dictionaries have the same codes', () => {
    expect(Object.keys(ERRORS.en).sort()).toEqual(Object.keys(ERRORS.vi).sort());
  });

  it('every code the API throws has a text', () => {
    const missing = [...new Set(sites.filter((s) => !(s.code in ERRORS.vi)).map((s) => `${s.file}: ${s.code}`))];
    expect(missing).toEqual([]);
  });

  it('every placeholder of a text is given by each throw site of that code', () => {
    const bad: string[] = [];
    for (const s of sites) {
      if (s.params.includes('*')) continue;
      for (const lang of ['vi', 'en'] as const) {
        const text = ERRORS[lang][s.code];
        if (!text) continue;
        for (const p of placeholders(text)) if (!s.params.includes(p)) bad.push(`${s.file} ${s.code} (${lang}): {${p}} not in params`);
      }
    }
    expect(bad).toEqual([]);
  });
});
