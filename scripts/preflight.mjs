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

const REPO_ROOT = process.cwd();
const IS_WINDOWS = process.platform === 'win32';
// On Windows, npm/npx/git are often .cmd shims; execFileSync needs shell:true
// (or the .cmd extension) to resolve them. This has no effect on POSIX.
const NPM_CMD = IS_WINDOWS ? 'npm.cmd' : 'npm';

const results = {
  repository: null,       // PASS/FAIL (informational, only FAILs if git unavailable)
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
// A. REPOSITORY STATE (informational — never fails unless git is unavailable)
// ============================================================
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

if (gitAvailable) {
  const statusRes = safeExec('git', ['status', '--porcelain']);
  if (statusRes.ok) {
    porcelain = statusRes.stdout;
    log(`git status --porcelain: ${porcelain.trim() === '' ? 'clean' : 'dirty'}`);
    if (porcelain.trim() !== '') {
      log(porcelain.trim().split('\n').map((l) => `  ${l}`).join('\n'));
    }
  } else {
    notes.push(`git status --porcelain failed: ${statusRes.stderr.trim()}`);
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

results.repository = gitAvailable ? 'PASS' : 'FAIL';

// ============================================================
// B. CLEAN-ROOM PRODUCTION DEPENDENCY VERIFICATION (PRIMARY GUARD)
// ============================================================
section('B. Clean-room production dependency verification');

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
// C. CANONICAL TESTS
// ============================================================
section('C. Canonical tests (npm test)');

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
// D. DIFF SECRET SCAN (guard, not a full scanner)
// ============================================================
section('D. Diff secret scan (guard only — not a complete scanner)');

const SECRET_PATTERNS = [
  { name: 'PRIVATE KEY block', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/, severity: 'FAIL' },
  { name: 'Stripe/live-style secret key (sk_live_)', re: /sk_live_[A-Za-z0-9]+/, severity: 'FAIL' },
  { name: 'Stripe/test-style secret key (sk_test_)', re: /sk_test_[A-Za-z0-9]+/, severity: 'WARN' },
  { name: 'JWT-looking token', re: /eyJ[A-Za-z0-9_-]{10,}/, severity: 'WARN' },
  { name: 'DATABASE_URL literal', re: /DATABASE_URL\s*=/, severity: 'WARN' },
  { name: 'password= literal', re: /password\s*=/i, severity: 'WARN' },
  { name: 'Sentry DSN', re: /https:\/\/[^\s"']*@[^\s"']*sentry[^\s"']*/i, severity: 'WARN' },
  { name: 'Omise secret key (skey_)', re: /skey_[A-Za-z0-9]+/, severity: 'FAIL' },
  { name: 'Omise public key (pkey_)', re: /pkey_[A-Za-z0-9]+/, severity: 'WARN' },
  { name: 'Bearer token literal', re: /Authorization:\s*Bearer\s+\S+/i, severity: 'WARN' },
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
// E. MIGRATION INVENTORY (report only, never fails, never executes anything)
// ============================================================
section('E. Migration inventory (report only)');

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
// F. ASSET-VERSION SANITY (read-only)
// ============================================================
section('F. Asset-version sanity');

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
// G. PWA SANITY (read-only)
// ============================================================
section('G. PWA sanity');

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

const HARD_GATES = ['cleanRoomInstall', 'runtimeDeps', 'canonicalTests', 'assetSanity', 'pwaSanity'];

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
