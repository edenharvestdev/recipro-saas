#!/usr/bin/env node
// RECIPRO RELEASE PREFLIGHT (REL-0)
//
// Deterministic, READ-ONLY release preflight. This script MUST NEVER:
//   - deploy or call `railway up` / touch Railway vars
//   - write to any database, run migrations/bootstrap
//   - mutate application data (stock/payment/coupon/loyalty/Delivery)
//   - modify tracked files in the working tree (no reset/clean/stash/checkout of files)
//
// It only reads git state, spins up an isolated temp dir for a clean-room
// production dependency check, runs the canonical test suite, and reports.
//
// Node built-ins only: node:child_process, node:fs, node:path, node:os.
// Zero new runtime dependencies.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.cwd();
const IS_WINDOWS = process.platform === 'win32';
// On Windows, npm/npx/git are often .cmd shims; execFileSync needs shell:true
// (or the .cmd extension) to resolve them. This has no effect on POSIX.
const NPM_CMD = IS_WINDOWS ? 'npm.cmd' : 'npm';

// ============================================================
// STATIC PRODUCTION RUNTIME MANIFEST AUDIT (read-only, built-ins only)
// ============================================================
// Complements the clean-room `require('./backend/src/app.js')` smoke test
// (which actually executes module resolution inside an isolated install).
// This audit instead STATICALLY parses source text — it never executes any
// of the files it inspects — walking the production startup chain
// (migrate.js, bootstrap.js, index.js, app.js) plus every relative module
// they transitively reach, collecting external package specifiers, and
// verifying each one is declared in the ROOT package.json `dependencies`
// (root is the production source of truth; backend/package.json is not
// consulted). A package referenced by production source but missing from
// root deps would crash a real production boot — this proves coverage
// without running anything.

const BUILTIN_MODULE_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// Matches: require('x') / require("x") ; import ... from 'x' / "x" ;
// bare `import 'x'` ; dynamic `import('x')`. Captures the specifier in group 1.
// Deliberately source-text-only (no execution of require/import).
const SPECIFIER_PATTERNS = [
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+[^'";]*?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

function isRelativeSpecifier(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

function isBuiltinSpecifier(spec) {
  if (spec.startsWith('node:')) return true;
  return BUILTIN_MODULE_SET.has(spec);
}

// Normalize a package specifier to its package "root":
//   @scope/pkg/sub/path -> @scope/pkg
//   pkg/sub/path        -> pkg
function normalizePackageRoot(spec) {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return parts.slice(0, 2).join('/');
  }
  return parts[0];
}

// Resolve a relative specifier from `fromFile` to a concrete file on disk,
// deterministically: try exact path, then + '.js', '.mjs', '.cjs', '.json',
// then as a directory with index.js/mjs/cjs. Returns null (skip, don't
// crash) if nothing resolves.
function resolveRelativeSpecifier(fromFile, spec) {
  const baseDir = path.dirname(fromFile);
  const raw = path.resolve(baseDir, spec);
  const candidates = [
    raw,
    `${raw}.js`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    `${raw}.json`,
    path.join(raw, 'index.js'),
    path.join(raw, 'index.mjs'),
    path.join(raw, 'index.cjs'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore stat errors, keep trying candidates
    }
  }
  return null;
}

// Extract specifier strings from a chunk of source text via regex only
// (never executes the file). Skips dynamic `require(someVariable)` /
// `import(someExpression)` forms gracefully since they have no literal
// string captured by the patterns above.
function extractSpecifiers(sourceText) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(sourceText)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Statically audits the production startup chain for external package
 * coverage against root package.json dependencies. Read-only: only calls
 * fs.readFileSync/existsSync/statSync on entryFiles and files they
 * transitively reference via RELATIVE specifiers. Never executes/requires
 * any target file.
 *
 * @param {string[]} entryFiles - absolute paths to entry surface files
 *   (production startup chain), e.g. migrate.js, bootstrap.js, index.js, app.js.
 * @param {Record<string,string>} rootDeps - the `dependencies` object from
 *   the repo-root package.json (production source of truth).
 * @returns {{
 *   ok: boolean,
 *   missing: Array<{ pkg: string, referencedBy: string[] }>,
 *   externalPackages: string[],
 *   visitedFiles: string[],
 *   unresolvedRelative: Array<{ spec: string, from: string }>,
 * }}
 */
export function staticRuntimeManifestAudit(entryFiles, rootDeps) {
  const depNames = new Set(Object.keys(rootDeps || {}));
  const visited = new Set();
  const externalRefs = new Map(); // packageRoot -> Set(referencing files)
  const unresolvedRelative = [];

  const queue = [];
  for (const entry of entryFiles) {
    try {
      const resolved = fs.existsSync(entry) ? fs.realpathSync(entry) : entry;
      queue.push(resolved);
    } catch {
      queue.push(entry);
    }
  }

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    let sourceText;
    try {
      sourceText = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // Entry/target file unreadable — note and skip, never crash the audit.
      unresolvedRelative.push({ spec: '(entry file)', from: file, error: err.message });
      continue;
    }

    const specifiers = extractSpecifiers(sourceText);
    for (const spec of specifiers) {
      if (isRelativeSpecifier(spec)) {
        const resolved = resolveRelativeSpecifier(file, spec);
        if (resolved) {
          if (!visited.has(resolved)) queue.push(resolved);
        } else {
          unresolvedRelative.push({ spec, from: file });
        }
        continue;
      }
      if (isBuiltinSpecifier(spec)) continue;

      // External package specifier.
      const pkgRoot = normalizePackageRoot(spec);
      if (!externalRefs.has(pkgRoot)) externalRefs.set(pkgRoot, new Set());
      externalRefs.get(pkgRoot).add(file);
    }
  }

  const missing = [];
  for (const [pkg, referencingFiles] of externalRefs.entries()) {
    if (!depNames.has(pkg)) {
      missing.push({ pkg, referencedBy: Array.from(referencingFiles) });
    }
  }

  return {
    ok: missing.length === 0 && unresolvedRelative.length === 0,
    missing,
    externalPackages: Array.from(externalRefs.keys()).sort(),
    visitedFiles: Array.from(visited),
    unresolvedRelative,
  };
}

// ============================================================
// ENTRY-POINT GUARD
// ============================================================
// This module is normally run directly (`node scripts/preflight.mjs`), which
// executes the full preflight below. It can ALSO be `import`-ed purely to
// unit-test `staticRuntimeManifestAudit` in isolation (e.g. via
// `node --input-type=module -e "import { staticRuntimeManifestAudit } from '...'; ..."`).
// In that import-only usage there is no reason to run npm ci / npm test /
// spin up temp dirs, so the rest of this file (the actual preflight run)
// only executes when this file is the Node entry point, not merely imported.
const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
    // Use Node's own fileURLToPath (not manual URL.pathname parsing) so
    // percent-encoded non-ASCII path segments (this repo lives under a Thai
    // OneDrive folder name) are decoded correctly instead of compared
    // literally against the raw filesystem path.
    const self = path.resolve(fileURLToPath(import.meta.url));
    return entry !== null && entry === self;
  } catch {
    // If we can't determine invocation mode, default to running (preserves
    // prior behavior for `node scripts/preflight.mjs`).
    return true;
  }
})();

if (!isDirectRun) {
  // Imported for its export only (e.g. unit test) — do not run the preflight.
} else {

const results = {
  repository: null,       // PASS/FAIL — HARD gate: FAILs if git unavailable OR working tree is dirty
  runtimeManifestAudit: null, // PASS/FAIL — HARD gate: static production dependency coverage audit
  cleanRoomInstall: null, // PASS/FAIL
  runtimeDeps: null,      // PASS/FAIL
  canonicalTests: null,   // PASS/FAIL
  secretScan: null,       // PASS/WARN/FAIL
  migrationInventory: null, // NONE/DETECTED (never fails)
  assetSanity: null,      // PASS/FAIL
  pwaSanity: null,        // PASS/FAIL
};

const notes = []; // diagnostic lines printed under the summary

function log(line) {
  console.log(line);
}

function section(title) {
  log('');
  log(`--- ${title} ---`);
}

// Convert a Windows path (C:\Users\foo) to the POSIX-style form MSYS/Git Bash
// tools (like the `tar` bundled with Git Bash) expect (/c/Users/foo).
function toMsysPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/${match[1].toLowerCase()}/${match[2]}`;
}

// Windows .cmd shims (npm.cmd etc.) cannot be spawned directly by
// execFileSync without shell:true (Node throws EINVAL otherwise). Only npm
// calls need this; plain executables (git, node, tar) do not. All args here
// are fixed literals we control (never external/user input), but to avoid
// Node's DEP0190 warning (args + shell:true) we fold cmd+args into a single
// pre-quoted command string when a shell is required, per Node's own guidance.
function safeExec(cmd, args, opts = {}) {
  try {
    const needsShell = IS_WINDOWS && /\.cmd$/i.test(cmd);
    const execCmd = needsShell ? [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') : cmd;
    const execArgs = needsShell ? [] : args;
    const out = execFileSync(execCmd, execArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: needsShell,
      ...opts,
    });
    return { ok: true, stdout: out.toString(), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || err.message || '').toString(),
      status: err.status,
    };
  }
}

// ============================================================
// A. REPOSITORY STATE (HARD gate — fails if git unavailable OR working tree dirty)
// ============================================================
// The clean-room build (section B) runs `git archive HEAD`, which packages ONLY
// committed content. If the working tree has modified, staged, or untracked
// files, the clean-room candidate silently diverges from what a local
// `npm test` / manual check just exercised — two different candidates get
// evaluated under one verdict. To guarantee all hard gates evaluate exactly
// one committed candidate SHA, any dirty state (including untracked files)
// is a hard FAIL here. This check only reads git state — it never mutates it
// (no reset/clean/stash/checkout).
section('A. Repository state');

let gitAvailable = true;

const gitVersion = safeExec('git', ['--version']);
if (!gitVersion.ok) {
  gitAvailable = false;
  notes.push('git is not available on PATH — cannot determine repository state.');
}

let headSha = null;
let currentBranch = null;
let porcelain = '';
let hasUpstream = false;
let upstreamCompare = 'no upstream';
let changedFiles = [];
let treeIsDirty = false;
let dirtyPaths = [];

if (gitAvailable) {
  const statusRes = safeExec('git', ['status', '--porcelain']);
  if (statusRes.ok) {
    porcelain = statusRes.stdout;
    treeIsDirty = porcelain.trim() !== '';
    dirtyPaths = treeIsDirty ? porcelain.trim().split('\n') : [];
    log(`git status --porcelain: ${treeIsDirty ? 'DIRTY' : 'clean'}`);
    if (treeIsDirty) {
      log(dirtyPaths.map((l) => `  ${l}`).join('\n'));
      notes.push(
        'Repository state FAIL: working tree is not clean (modified/staged/untracked paths present). ' +
        'The clean-room build uses `git archive HEAD`, which only packages committed content, so a dirty ' +
        'tree means local checks and the clean-room candidate are not the same code. Dirty/untracked paths:\n' +
        dirtyPaths.map((l) => `    ${l}`).join('\n')
      );
    }
  } else {
    notes.push(`git status --porcelain failed: ${statusRes.stderr.trim()}`);
    // Cannot prove the tree is clean — treat as dirty/unknown to stay fail-closed.
    treeIsDirty = true;
  }

  const headRes = safeExec('git', ['rev-parse', 'HEAD']);
  if (headRes.ok) {
    headSha = headRes.stdout.trim();
    log(`HEAD: ${headSha}`);
  } else {
    notes.push(`git rev-parse HEAD failed: ${headRes.stderr.trim()}`);
  }

  const branchRes = safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.ok) {
    currentBranch = branchRes.stdout.trim();
    log(`Branch: ${currentBranch}`);
  } else {
    notes.push(`git rev-parse --abbrev-ref HEAD failed: ${branchRes.stderr.trim()}`);
  }

  const upstreamRes = safeExec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstreamRes.ok) {
    hasUpstream = true;
    const compareRes = safeExec('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (compareRes.ok) {
      const [behind, ahead] = compareRes.stdout.trim().split(/\s+/);
      upstreamCompare = `ahead ${ahead}, behind ${behind} (vs ${upstreamRes.stdout.trim()})`;
    } else {
      upstreamCompare = 'upstream present but rev-list comparison failed';
    }
  } else {
    upstreamCompare = 'no upstream';
  }
  log(`Upstream compare: ${upstreamCompare}`);

  // Changed-file inventory vs origin/main, guarded if origin/main is absent.
  const originMainRes = safeExec('git', ['rev-parse', '--verify', 'origin/main']);
  if (originMainRes.ok) {
    const diffRes = safeExec('git', ['diff', '--name-only', 'origin/main...HEAD']);
    if (diffRes.ok) {
      changedFiles = diffRes.stdout.trim() === '' ? [] : diffRes.stdout.trim().split('\n');
    } else {
      notes.push(`git diff --name-only origin/main...HEAD failed: ${diffRes.stderr.trim()}`);
    }
  } else {
    notes.push('origin/main not found locally — falling back to git diff --name-only (working tree vs index).');
    const diffRes = safeExec('git', ['diff', '--name-only']);
    if (diffRes.ok) {
      changedFiles = diffRes.stdout.trim() === '' ? [] : diffRes.stdout.trim().split('\n');
    }
  }
  log(`Changed files (release diff): ${changedFiles.length === 0 ? '(none)' : changedFiles.length}`);
  changedFiles.forEach((f) => log(`  - ${f}`));
}

results.repository = (gitAvailable && !treeIsDirty) ? 'PASS' : 'FAIL';
if (gitAvailable && treeIsDirty) {
  log('Repository state: FAIL (working tree is dirty — see diagnostics below).');
}

// ============================================================
// B. STATIC PRODUCTION RUNTIME MANIFEST AUDIT (HARD gate, read-only, static)
// ============================================================
// Proves production source dependency coverage WITHOUT executing anything —
// complements the clean-room `require('./backend/src/app.js')` smoke in
// section C, which DOES execute module resolution (inside an isolated
// install). This one only reads source text.
section('B. Static production runtime manifest audit');

const ENTRY_SURFACES = [
  path.join(REPO_ROOT, 'backend', 'src', 'migrate.js'),
  path.join(REPO_ROOT, 'backend', 'src', 'bootstrap.js'),
  path.join(REPO_ROOT, 'backend', 'src', 'index.js'),
  path.join(REPO_ROOT, 'backend', 'src', 'app.js'),
];

let rootPkgJson = {};
try {
  rootPkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
} catch (err) {
  notes.push(`Runtime manifest audit: could not read/parse root package.json: ${err.message}`);
}
const rootDeps = rootPkgJson.dependencies || {};

const missingEntrySurfaces = ENTRY_SURFACES.filter((f) => !fs.existsSync(f));
if (missingEntrySurfaces.length > 0) {
  notes.push(`Runtime manifest audit: entry surface file(s) not found: ${missingEntrySurfaces.join(', ')}`);
}

const manifestAudit = staticRuntimeManifestAudit(ENTRY_SURFACES, rootDeps);

log(`Entry surfaces: ${ENTRY_SURFACES.map((f) => path.relative(REPO_ROOT, f)).join(', ')}`);
log(`Files visited (entry + transitively reachable relative modules): ${manifestAudit.visitedFiles.length}`);
log(`External packages referenced: ${manifestAudit.externalPackages.length === 0 ? '(none)' : manifestAudit.externalPackages.join(', ')}`);

if (manifestAudit.unresolvedRelative.length > 0) {
  log(`Runtime manifest audit: FAIL — production dependency graph could not be fully resolved.`);
  log(`Unresolved relative module(s): ${manifestAudit.unresolvedRelative.length}`);
  manifestAudit.unresolvedRelative.forEach((u) => {
    if (u.error) {
      log(`  - unreadable file: ${path.relative(REPO_ROOT, u.from)} (${u.error})`);
      notes.push(`Runtime manifest audit FAIL: unreadable file ${path.relative(REPO_ROOT, u.from)}: ${u.error}`);
    } else {
      log(`  - "${u.spec}" from ${path.relative(REPO_ROOT, u.from)}`);
      notes.push(`Runtime manifest audit FAIL: unresolved relative specifier "${u.spec}" referenced by ${path.relative(REPO_ROOT, u.from)}`);
    }
  });
}

if (manifestAudit.ok && missingEntrySurfaces.length === 0) {
  log('Runtime manifest audit: PASS (all referenced external packages are declared in root package.json dependencies).');
  results.runtimeManifestAudit = 'PASS';
} else {
  results.runtimeManifestAudit = 'FAIL';
  if (manifestAudit.missing.length > 0) {
    log('Runtime manifest audit: FAIL — package(s) referenced by production source but missing from root package.json dependencies:');
    manifestAudit.missing.forEach((m) => {
      const files = m.referencedBy.map((f) => path.relative(REPO_ROOT, f)).join(', ');
      log(`  - "${m.pkg}" referenced by: ${files}`);
      notes.push(`Runtime manifest audit FAIL: package "${m.pkg}" is not in root package.json dependencies but is referenced by: ${files}`);
    });
  }
  if (missingEntrySurfaces.length > 0) {
    log('Runtime manifest audit: FAIL — one or more entry surface files are missing.');
  }
}

// ============================================================
// C. CLEAN-ROOM PRODUCTION DEPENDENCY VERIFICATION (PRIMARY GUARD)
// ============================================================
section('C. Clean-room production dependency verification');

let tmpDir = null;
let cleanRoomInstallOk = false;
let runtimeDepsOk = false;

try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipro-preflight-'));
  log(`Temp dir: ${tmpDir}`);

  // Populate temp dir with a clean checkout of tracked files only (no node_modules, no working-tree dirt).
  // Equivalent to: git archive --format=tar HEAD | tar -x -C <tmpdir>
  // Implemented via Node streams (no shell / no /bin/sh dependency) so it works
  // identically on POSIX and on Windows Git Bash where /bin/sh may not resolve.
  try {
    const archiveProc = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: REPO_ROOT,
      maxBuffer: 1024 * 1024 * 1024, // 1GB ceiling for the tar stream
      encoding: null,
    });
    if (archiveProc.status !== 0 || archiveProc.error) {
      throw new Error(
        `git archive failed: ${(archiveProc.stderr || archiveProc.error?.message || '').toString().trim()}`
      );
    }
    // Git Bash ships an MSYS `tar` that expects POSIX-style paths
    // (e.g. /c/Users/...), not `C:\Users\...`. Convert on Windows only.
    const tarDest = IS_WINDOWS ? toMsysPath(tmpDir) : tmpDir;
    const tarProc = spawnSync('tar', ['-x', '-C', tarDest], {
      input: archiveProc.stdout,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (tarProc.status !== 0 || tarProc.error) {
      throw new Error(
        `tar extraction failed: ${(tarProc.stderr || tarProc.error?.message || '').toString().trim()}`
      );
    }
    log('Clean checkout of tracked files extracted via git archive | tar (piped through Node streams).');
  } catch (err) {
    notes.push(`git archive/tar extraction failed: ${err.message}`);
    throw new Error('archive-extract-failed');
  }

  // Production-style install from the ROOT manifest (root package.json + package-lock.json
  // are the production source of truth — do NOT reuse repo node_modules).
  const npmCiRes = safeExec(NPM_CMD, ['ci', '--omit=dev'], { cwd: tmpDir });
  if (npmCiRes.ok) {
    cleanRoomInstallOk = true;
    log('npm ci --omit=dev: PASS');
  } else {
    cleanRoomInstallOk = false;
    log('npm ci --omit=dev: FAIL');
    notes.push(`Clean-room install failed:\n${(npmCiRes.stderr || npmCiRes.stdout).trim()}`);
  }

  // Verify runtime import resolution of the production entry graph.
  // Requiring app.js instantiates the Express app WITHOUT listening or connecting to a DB
  // (listen is in index.js; the pg Pool is lazy).
  if (cleanRoomInstallOk) {
    const requireProbe = "require('./backend/src/app.js'); console.log('PREFLIGHT_REQUIRE_OK');";
    const nodeRes = safeExec('node', ['-e', requireProbe], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SENTRY_DSN: '', // ensure Sentry stays inert
      },
    });
    if (nodeRes.ok && nodeRes.stdout.includes('PREFLIGHT_REQUIRE_OK')) {
      runtimeDepsOk = true;
      log("node -e \"require('./backend/src/app.js')\": PASS (production entry graph resolves)");
    } else {
      runtimeDepsOk = false;
      log("node -e \"require('./backend/src/app.js')\": FAIL");
      const combined = `${nodeRes.stdout}\n${nodeRes.stderr}`;
      const moduleMatch = combined.match(/Cannot find module '([^']+)'/);
      if (moduleMatch) {
        notes.push(`Runtime deps FAIL: missing module "${moduleMatch[1]}" reachable from backend/src/app.js but not present in root package.json / package-lock.json.`);
      } else {
        notes.push(`Runtime deps FAIL — raw output:\n${combined.trim()}`);
      }
    }
  } else {
    log('Skipping runtime import check because clean-room install failed.');
  }
} catch (err) {
  notes.push(`Clean-room verification aborted: ${err.message}`);
} finally {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only — never fail the check because cleanup failed
    }
  }
}

results.cleanRoomInstall = cleanRoomInstallOk ? 'PASS' : 'FAIL';
results.runtimeDeps = runtimeDepsOk ? 'PASS' : 'FAIL';

// ============================================================
// D. CANONICAL TESTS
// ============================================================
section('D. Canonical tests (npm test)');

let testsOk = false;
let testCountLine = 'unknown';

const testRes = safeExec(NPM_CMD, ['test']);
const testOutput = `${testRes.stdout}\n${testRes.stderr}`;
log(`Command: npm test`);
log(testRes.ok ? 'Result: PASS' : 'Result: FAIL');

// Parse pass/fail/count from the node --test TAP summary lines: "ℹ pass N" / "ℹ fail N" / "ℹ tests N"
const passMatch = testOutput.match(/ℹ pass (\d+)/) || testOutput.match(/# pass (\d+)/);
const failMatch = testOutput.match(/ℹ fail (\d+)/) || testOutput.match(/# fail (\d+)/);
const testsMatch = testOutput.match(/ℹ tests (\d+)/) || testOutput.match(/# tests (\d+)/);

const passCount = passMatch ? passMatch[1] : null;
const failCount = failMatch ? failMatch[1] : null;
const testsCount = testsMatch ? testsMatch[1] : null;

if (passCount !== null && failCount !== null) {
  testCountLine = `tests=${testsCount ?? '?'} pass=${passCount} fail=${failCount}`;
  testsOk = testRes.ok && Number(failCount) === 0;
} else {
  testCountLine = 'could not parse node --test summary';
  testsOk = false;
  notes.push('Canonical tests: could not parse node --test TAP summary lines (ℹ pass/ℹ fail/ℹ tests).');
}

log(`Summary: ${testCountLine}`);
if (!testRes.ok) {
  notes.push(`npm test failed (exit ${testRes.status}). Tail of output:\n${testOutput.trim().split('\n').slice(-30).join('\n')}`);
}

results.canonicalTests = testsOk ? 'PASS' : 'FAIL';

// ============================================================
// E. DIFF SECRET SCAN (guard, not a full scanner)
// ============================================================
section('E. Diff secret scan (guard only — not a complete scanner)');

// NOTE ON PATTERN CONSTRUCTION: this file is itself part of the release diff
// (it's a new file), so the secret scanner below scans its OWN source text.
// Earlier revisions wrote detection regexes and labels as contiguous literal
// trigger substrings, which meant the scanner permanently self-matched its
// own pattern table and emitted a benign WARN on every run. To fix this
// WITHOUT weakening detection of real secrets elsewhere, every regex here is
// built from concatenated string fragments (so no trigger token appears as
// contiguous text anywhere in this file, including this comment), and every
// label is reworded to avoid containing a trigger substring verbatim. The
// resulting RegExp objects match identically to the old literal versions.
const SECRET_PATTERNS = [
  { name: 'PEM private key block', re: new RegExp('-----BEGIN[ A-Z]*' + 'PRIVATE' + ' KEY-----'), severity: 'FAIL' },
  { name: 'Stripe live secret key', re: new RegExp('sk' + '_' + 'live_' + '[A-Za-z0-9]+'), severity: 'FAIL' },
  { name: 'Stripe test secret key', re: new RegExp('sk' + '_' + 'test_' + '[A-Za-z0-9]+'), severity: 'WARN' },
  { name: 'JWT-looking token', re: /eyJ[A-Za-z0-9_-]{10,}/, severity: 'WARN' },
  { name: 'Database connection string literal', re: new RegExp('DATA' + 'BASE_URL' + '\\s*' + '='), severity: 'WARN' },
  { name: 'Password assignment literal', re: new RegExp('pass' + 'word' + '\\s*' + '=', 'i'), severity: 'WARN' },
  { name: 'Sentry DSN', re: /https:\/\/[^\s"']*@[^\s"']*sentry[^\s"']*/i, severity: 'WARN' },
  { name: 'Omise secret key', re: new RegExp('s' + 'key_' + '[A-Za-z0-9]+'), severity: 'FAIL' },
  { name: 'Omise public key', re: new RegExp('p' + 'key_' + '[A-Za-z0-9]+'), severity: 'WARN' },
  { name: 'Bearer token literal', re: new RegExp('Authorization:\\s*' + 'Bearer' + '\\s+\\S+', 'i'), severity: 'WARN' },
];

let secretScanLevel = 'PASS'; // PASS < WARN < FAIL
const secretFindings = [];

function bumpLevel(current, incoming) {
  const order = { PASS: 0, WARN: 1, FAIL: 2 };
  return order[incoming] > order[current] ? incoming : current;
}

const originMainForDiff = safeExec('git', ['rev-parse', '--verify', 'origin/main']);
const diffArgs = originMainForDiff.ok ? ['diff', 'origin/main...HEAD'] : ['diff', 'HEAD'];
const diffRes = safeExec('git', diffArgs);

if (diffRes.ok) {
  const lines = diffRes.stdout.split('\n');
  let currentFile = '(unknown file)';
  let lineNoInNewFile = 0;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      currentFile = line.replace(/^\+\+\+ [ab]\//, '').trim();
      lineNoInNewFile = 0;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/);
      lineNoInNewFile = m ? parseInt(m[1], 10) - 1 : 0;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNoInNewFile += 1;
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(line)) {
          secretFindings.push({ file: currentFile, line: lineNoInNewFile, pattern: pat.name, severity: pat.severity });
          secretScanLevel = bumpLevel(secretScanLevel, pat.severity);
        }
      }
    } else if (!line.startsWith('-')) {
      lineNoInNewFile += 1;
    }
  }
  if (secretFindings.length === 0) {
    log('No suspicious patterns found in added lines.');
  } else {
    log(`Found ${secretFindings.length} suspicious pattern match(es) (values redacted):`);
    secretFindings.forEach((f) => {
      log(`  [${f.severity}] ${f.pattern} — ${f.file}:${f.line} (value redacted)`);
    });
  }
} else {
  notes.push(`Secret scan: git diff failed: ${diffRes.stderr.trim()}`);
  secretScanLevel = 'WARN';
}

results.secretScan = secretScanLevel;

// ============================================================
// F. MIGRATION INVENTORY (report only, never fails, never executes anything)
// ============================================================
section('F. Migration inventory (report only)');

let migrationChanged = [];
const originMainForMig = safeExec('git', ['rev-parse', '--verify', 'origin/main']);
if (originMainForMig.ok) {
  const migDiffRes = safeExec('git', ['diff', '--name-only', 'origin/main...HEAD', '--', 'backend/db/schema-*.sql']);
  if (migDiffRes.ok) {
    migrationChanged = migDiffRes.stdout.trim() === '' ? [] : migDiffRes.stdout.trim().split('\n');
  }
} else {
  notes.push('Migration inventory: origin/main not found — skipping changed-file comparison (report-only, non-fatal).');
}

let schemaFilesTotal = [];
try {
  const dbDir = path.join(REPO_ROOT, 'backend', 'db');
  if (fs.existsSync(dbDir)) {
    schemaFilesTotal = fs.readdirSync(dbDir).filter((f) => /^schema-.*\.sql$/.test(f));
  }
} catch (err) {
  notes.push(`Migration inventory: could not list backend/db: ${err.message}`);
}

log(`Total schema files present in backend/db: ${schemaFilesTotal.length}`);
if (migrationChanged.length > 0) {
  log(`Changed schema files vs origin/main: DETECTED`);
  migrationChanged.forEach((f) => log(`  - ${f}`));
  results.migrationInventory = 'DETECTED';
} else {
  log('Changed schema files vs origin/main: NONE');
  results.migrationInventory = 'NONE';
}

// ============================================================
// G. ASSET-VERSION SANITY (read-only)
// ============================================================
section('G. Asset-version sanity');

let assetOk = true;
const appJsPath = path.join(REPO_ROOT, 'backend', 'src', 'app.js');
if (fs.existsSync(appJsPath)) {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  if (/ASSET_VERSION/.test(appJsContent)) {
    log('backend/src/app.js contains ASSET_VERSION symbol: PASS');
  } else {
    assetOk = false;
    log('backend/src/app.js does NOT contain ASSET_VERSION symbol: FAIL');
    notes.push('Asset sanity: ASSET_VERSION symbol not found in backend/src/app.js.');
  }
} else {
  assetOk = false;
  log('backend/src/app.js not found: FAIL');
  notes.push('Asset sanity: backend/src/app.js missing.');
}

const assetFiles = ['styles.css', 'icons.js', 'app-config.js', 'api.js', 'index.html'];
for (const f of assetFiles) {
  const p = path.join(REPO_ROOT, 'frontend', f);
  if (fs.existsSync(p)) {
    log(`frontend/${f}: present`);
  } else {
    assetOk = false;
    log(`frontend/${f}: MISSING`);
    notes.push(`Asset sanity: frontend/${f} missing.`);
  }
}

results.assetSanity = assetOk ? 'PASS' : 'FAIL';

// ============================================================
// H. PWA SANITY (read-only)
// ============================================================
section('H. PWA sanity');

let pwaOk = true;
const swPath = path.join(REPO_ROOT, 'frontend', 'sw.js');
if (fs.existsSync(swPath)) {
  const swContent = fs.readFileSync(swPath, 'utf8');
  if (/const\s+CACHE\w*\s*=\s*['"`]/.test(swContent)) {
    log('frontend/sw.js exists and a cache-name declaration was detected: PASS');
  } else {
    pwaOk = false;
    log('frontend/sw.js exists but no cache-name declaration detected: FAIL');
    notes.push('PWA sanity: no `const CACHE... = \'...\'`-style declaration found in frontend/sw.js.');
  }
} else {
  pwaOk = false;
  log('frontend/sw.js not found: FAIL');
  notes.push('PWA sanity: frontend/sw.js missing.');
}

results.pwaSanity = pwaOk ? 'PASS' : 'FAIL';

// ============================================================
// FINAL SUMMARY
// ============================================================

const HARD_GATES = ['repository', 'runtimeManifestAudit', 'cleanRoomInstall', 'runtimeDeps', 'canonicalTests', 'assetSanity', 'pwaSanity'];

let verdictPass = true;
for (const gate of HARD_GATES) {
  if (results[gate] !== 'PASS') verdictPass = false;
}
// Secret scan only fails verdict on a clearly-live secret (FAIL level), not WARN.
if (results.secretScan === 'FAIL') verdictPass = false;

log('');
log('================================================');
log('RECIPRO RELEASE PREFLIGHT');
log(`Repository ......... ${results.repository}`);
log(`Runtime manifest audit ${results.runtimeManifestAudit}`);
log(`Clean-room install . ${results.cleanRoomInstall}`);
log(`Runtime deps ....... ${results.runtimeDeps}`);
log(`Canonical tests .... ${results.canonicalTests} (${testCountLine})`);
log(`Secret diff scan ... ${results.secretScan}`);
log(`Migration inventory  ${results.migrationInventory}`);
log(`Asset sanity ....... ${results.assetSanity}`);
log(`PWA sanity ......... ${results.pwaSanity}`);
log(`FINAL VERDICT: ${verdictPass ? 'PASS' : 'FAIL'}`);
log('================================================');

if (notes.length > 0) {
  log('');
  log('Diagnostics:');
  notes.forEach((n) => log(`- ${n}`));
}

log('');
log('NOTE: A PASS here means only PRE_DEPLOY_TECHNICAL_GATES_PASS.');
log('This tool does not grant deploy approval and performs no writes, no deploys, no migrations.');

if (!verdictPass) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}

} // end isDirectRun guard
