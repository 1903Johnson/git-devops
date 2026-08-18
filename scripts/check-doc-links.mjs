#!/usr/bin/env node
// Verifies that relative links between markdown files actually resolve.
// The docs are the deliverable until Sprint 0 lands code, so a broken cross-reference
// is a real defect rather than a cosmetic one.
//
// Usage:  node scripts/check-doc-links.mjs

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
const broken = [];

for (const file of walk(ROOT)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const [, href] of text.matchAll(LINK_RE)) {
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        const target = resolve(dirname(file), href.split('#')[0]);
        if (!existsSync(target)) {
          broken.push({ file: rel(file), line: i + 1, href });
        }
      }
    });
}

if (broken.length === 0) {
  console.log('doc links: clean');
  process.exit(0);
}

console.error(`\ndoc link check FAILED — ${broken.length} broken link(s)\n`);
for (const b of broken) console.error(`  ${b.file}:${b.line}  →  ${b.href}`);
console.error('');
process.exit(1);
