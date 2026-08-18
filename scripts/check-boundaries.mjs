#!/usr/bin/env node
// Structural invariants for the optional-module architecture (docs/01 §2, docs/02 §6).
//
// These are the rules that keep the module system real over time. They are cheap to
// state and expensive to rediscover after they have been violated for six months, so
// they run as a blocking CI job from day one — before there is any code to check.
//
// Usage:  node scripts/check-boundaries.mjs
// Exit:   0 = clean, 1 = violations found

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

// Backend core. These must never depend on an optional module.
const CORE_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages'];

// Generated or aggregating packages legitimately mention every module.
const CORE_EXEMPT = ['packages/sdk', 'packages/contracts'];

// Client shells (admin-web, member-mobile, kiosk) are deliberately NOT checked here.
// They lazy-load module UI bundles, so a compile-time reference is expected. The
// invariant that matters for them — navigation is rendered from GET /me/modules and
// never hardcoded — is a review-checklist item, not something grep can prove.

// Narrow, documented exceptions to "a module key appears nowhere outside its module".
const KEY_EXEMPTIONS = {
  // The kiosk is the device client for children's check-in and must know its own
  // module key in order to refuse startup when the module is disabled for the
  // church it is paired with (docs/02 §4).
  children_checkin: ['apps/kiosk/'],
};

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

const violations = [];
const report = (rule, file, line, message) => violations.push({ rule, file, line, message });

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
const isExempt = (file, prefixes) => prefixes.some((p) => rel(file).startsWith(p));

function eachLine(file, fn) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => fn(text, i + 1));
}

// --- discover modules --------------------------------------------------------------

const MODULES_DIR = join(ROOT, 'modules');
const moduleDirs = existsSync(MODULES_DIR)
  ? readdirSync(MODULES_DIR).filter((d) => statSync(join(MODULES_DIR, d)).isDirectory())
  : [];

// Module key is declared in the manifest; the directory name is the kebab-case form.
function moduleKey(dirName) {
  const manifest = join(MODULES_DIR, dirName, 'module.manifest.ts');
  if (existsSync(manifest)) {
    const match = readFileSync(manifest, 'utf8').match(/key:\s*['"]([\w-]+)['"]/);
    if (match) return match[1];
  }
  return dirName.replace(/-/g, '_');
}

function declaredRequires(dirName) {
  const manifest = join(MODULES_DIR, dirName, 'module.manifest.ts');
  if (!existsSync(manifest)) return [];
  const block = readFileSync(manifest, 'utf8').match(/requires:\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]);
}

const modules = moduleDirs.map((dir) => ({
  dir,
  key: moduleKey(dir),
  requires: declaredRequires(dir),
}));

// --- C1: core must not import from modules/* ---------------------------------------

const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

for (const root of CORE_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    if (!CODE_EXT.has(file.slice(file.lastIndexOf('.')))) continue;
    if (isExempt(file, CORE_EXEMPT)) continue;
    eachLine(file, (text, line) => {
      for (const [, spec] of text.matchAll(IMPORT_RE)) {
        if (/(^|\/)modules\//.test(spec) || /^@church\/mod-/.test(spec)) {
          report('C1', rel(file), line, `core imports from an optional module: "${spec}"`);
        }
      }
    });
  }
}

// --- C2: cross-module imports must be declared in requires[] ------------------------

for (const mod of modules) {
  for (const file of walk(join(MODULES_DIR, mod.dir))) {
    if (!CODE_EXT.has(file.slice(file.lastIndexOf('.')))) continue;
    eachLine(file, (text, line) => {
      for (const [, spec] of text.matchAll(IMPORT_RE)) {
        const hit = spec.match(/(?:^|\/)modules\/([\w-]+)/) || spec.match(/^@church\/mod-([\w-]+)/);
        if (!hit) continue;
        const target = modules.find((m) => m.dir === hit[1] || m.key === hit[1]);
        if (!target || target.dir === mod.dir) continue;
        if (!mod.requires.includes(target.key)) {
          report(
            'C2',
            rel(file),
            line,
            `imports "${target.key}" without declaring it in manifest requires[]`,
          );
        }
      }
    });
  }
}

// --- C3: a module key appears nowhere outside its own module ------------------------

for (const mod of modules) {
  const allowed = KEY_EXEMPTIONS[mod.key] ?? [];
  for (const root of CORE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (!CODE_EXT.has(file.slice(file.lastIndexOf('.')))) continue;
      if (isExempt(file, [...CORE_EXEMPT, ...allowed])) continue;
      eachLine(file, (text, line) => {
        if (text.includes(mod.key)) {
          report('C3', rel(file), line, `references module key "${mod.key}" outside its module`);
        }
      });
    }
  }
}

// --- C4: module tables must be prefixed mod_<key>_ ----------------------------------

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)["`]?/gi;

for (const mod of modules) {
  for (const file of walk(join(MODULES_DIR, mod.dir))) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(file, 'utf8');
    for (const [, raw] of sql.matchAll(CREATE_TABLE_RE)) {
      const table = raw.includes('.') ? raw.split('.').pop() : raw;
      const prefix = `mod_${mod.key}_`;
      if (!table.startsWith(prefix)) {
        report('C4', rel(file), 0, `table "${table}" must be prefixed "${prefix}" (purge safety)`);
      }
    }
  }
}

// --- C5: tenant-scoped tables must enable RLS ---------------------------------------
// A table carrying church_id without RLS is a cross-tenant leak waiting for one bad
// query. The application-layer tenant context is the plan; RLS is the backstop.

for (const file of walk(ROOT).filter((f) => f.endsWith('.sql'))) {
  if (rel(file).startsWith('node_modules')) continue;
  const sql = readFileSync(file, 'utf8');
  const lower = sql.toLowerCase();
  for (const match of sql.matchAll(CREATE_TABLE_RE)) {
    const raw = match[1];
    const table = (raw.includes('.') ? raw.split('.').pop() : raw).toLowerCase();
    const body = sql.slice(match.index, match.index + 4000).toLowerCase();
    const bodyEnd = body.indexOf(');');
    if (!body.slice(0, bodyEnd === -1 ? undefined : bodyEnd).includes('church_id')) continue;
    if (!lower.includes(`alter table ${table} enable row level security`.toLowerCase())) {
      report(
        'C5',
        rel(file),
        0,
        `tenant-scoped table "${table}" does not enable row level security`,
      );
    }
  }
}

// --- output --------------------------------------------------------------------------

const RULES = {
  C1: 'core must not depend on an optional module',
  C2: 'cross-module imports must be declared in manifest requires[]',
  C3: 'module keys must not leak outside their module',
  C4: 'module tables must use the mod_<key>_ prefix',
  C5: 'tenant-scoped tables must enable row level security',
};

if (modules.length === 0) {
  console.log('boundary check: no modules/ directory yet — rules are armed, nothing to check.');
}

if (violations.length === 0) {
  console.log(`boundary check: clean (${modules.length} module(s) checked)`);
  process.exit(0);
}

console.error(`\nboundary check FAILED — ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}\n        ${v.message}`);
}
console.error('\nRules:');
for (const [id, text] of Object.entries(RULES)) console.error(`  ${id}  ${text}`);
console.error('\nSee docs/01-architecture.md §2 and docs/02-module-system.md §6.\n');
process.exit(1);
