#!/usr/bin/env node
// DSH Anywhere - zero-restart deployment of the local injection bridge.
//
// All synchronous, all best-effort, NEVER throws (so the host adapter still
// starts even when DSH is not installed / a profile is read-only):
//   1. Copy dsh-anywhere-inject/{package.json,cordis.patch.yml,index.js}
//      to <dshHome>/dsh-anywhere-inject/ as a stable copy.
//   2. Create a junction (Windows) / symlink (Linux) at
//      <profileDir>/node_modules/@local/dsh-anywhere-inject -> that copy.
//   3. Idempotently edit <profileDir>/package.json:
//        dependencies["@local/dsh-anywhere-inject"] = "link:<copy>"
//        dsh.profile.bundles += "@local/dsh-anywhere-inject"
//        dshAnywhereInject = <content hash>   (bookkeeping marker)
//   4. Adding the bundle to dsh.profile.bundles triggers DSH HMR ->
//      reconcileProfile -> hot-loads the plugin (initial deployment only).
//      Later runs just re-copy changed plugin files; new code activates on
//      the next DSH restart. No token / pairing change, no relay interruption.
//
// The plugin itself writes <dshHome>/agents-anywhere/bridge/endpoint.json
// once it is listening; the live host adapter re-discovers it every ~12s.
//
// Standalone:  node install/deploy-inject.mjs [--quiet] [--strict] [--help]
// In-process:  import { deployInject } from './install/deploy-inject.mjs'

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SELF_DIR = path.dirname(SELF);
const ROOT = path.resolve(SELF_DIR, '..');
const NAME = '@local/dsh-anywhere-inject';
const FILES = ['package.json', 'cordis.patch.yml', 'index.js'];
const OPTIONAL = ['README.md'];
const BACK = String.fromCharCode(92); // backslash, kept as a char code so no escaping is needed

function pluginSrc() {
  return process.env.DSH_ANYWHERE_INJECT_SRC
    ? path.resolve(process.env.DSH_ANYWHERE_INJECT_SRC)
    : path.join(ROOT, 'dsh-anywhere-inject');
}

function slash(p) { return String(p).split(BACK).join('/'); }

function trimSep(s) {
  s = String(s);
  while (s.length > 1) {
    const c = s.charCodeAt(s.length - 1);
    if (c === 47 || c === 92) s = s.slice(0, -1); else break;
  }
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function realOrRaw(p) {
  try { return trimSep(fs.realpathSync(p)); } catch { return trimSep(p); }
}

function log(msg) {
  try { process.stderr.write('[inject] ' + msg + '\n'); } catch {}
}

function sourceHash(src) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    const b = fs.readFileSync(path.join(src, f));
    h.update(f).update(String(b.length)).update(b);
  }
  return h.digest('hex').slice(0, 12);
}

function candidateHomes() {
  const out = [];
  if (process.env.DSH_HOME) out.push(path.resolve(process.env.DSH_HOME));
  // Isolated tests (and exotic setups) can opt out of the implicit ~/.dsh.
  if (process.env.DSH_ANYWHERE_INJECT_SKIP_DEFAULT_HOME !== '1') {
    out.push(path.join(os.homedir(), '.dsh'));
  }
  if (process.env.DSH_ANYWHERE_INJECT_DSH_HOME) out.push(path.resolve(process.env.DSH_ANYWHERE_INJECT_DSH_HOME));
  const seen = new Set();
  return out.filter((p) => {
    const k = trimSep(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function findProfiles(home) {
  const base = path.join(home, 'profiles');
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(base, n);
    const pkg = path.join(dir, 'package.json');
    try {
      const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (json && json.dsh && json.dsh.profile && Array.isArray(json.dsh.profile.bundles)) {
        out.push({ dir, pkg, json });
      }
    } catch { /* not a DSH profile manifest */ }
  }
  return out;
}

function syncCopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let wrote = 0;
  for (const list of [FILES, OPTIONAL]) {
    for (const f of list) {
      const from = path.join(src, f);
      const to = path.join(dst, f);
      let data;
      try { data = fs.readFileSync(from); } catch { continue; } // optional file absent
      let same = false;
      try { same = fs.readFileSync(to).equals(data); } catch {}
      if (!same) {
        try { fs.writeFileSync(to, data); wrote++; } catch (e) {
          if (list === FILES) throw e;
        }
      }
    }
  }
  return wrote;
}

function isLink(p) {
  try { fs.readlinkSync(p); return true; } catch { return false; }
}

function removeLink(p) {
  try { fs.unlinkSync(p); return true; } catch {}
  try { fs.rmdirSync(p); return true; } catch {}
  return false;
}

function ensureLink(linkPath, target) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (isLink(linkPath)) {
    if (realOrRaw(linkPath) === realOrRaw(target)) return 'unchanged';
    if (!removeLink(linkPath)) return 'could-not-remove-old-link';
  } else {
    let st = null;
    try { st = fs.lstatSync(linkPath); } catch {}
    if (st) {
      // Never clobber a real directory that is not ours.
      if (st.isDirectory()) {
        try {
          const o = JSON.parse(fs.readFileSync(path.join(linkPath, 'package.json'), 'utf8'));
          if (o && o.name === NAME) return 'already-real-dir';
        } catch {}
      }
      return 'path-occupied (not overwritten)';
    }
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try { fs.symlinkSync(target, linkPath, type); return 'created'; }
  catch (e) { return 'symlink-failed: ' + (e && e.code ? e.code : String(e)); }
}

function writeManifest(pkg, json) {
  const text = JSON.stringify(json, null, 2) + '\n';
  const bak = path.join(path.dirname(pkg), 'package.json.before-dsh-anywhere-inject.bak');
  try { if (!fs.existsSync(bak)) fs.copyFileSync(pkg, bak); } catch {}
  const tmp = pkg + '.dsh-anywhere-inject.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, pkg); }
  catch {
    fs.writeFileSync(pkg, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function deployProfile(home, profile, src, hash) {
  const copyDir = path.join(home, 'dsh-anywhere-inject');
  const wrote = syncCopy(src, copyDir);
  const linkPath = path.join(profile.dir, 'node_modules', '@local', 'dsh-anywhere-inject');
  const link = ensureLink(linkPath, copyDir);

  const json = profile.json;
  const linkValue = 'link:' + slash(copyDir);
  let changed = false;
  if (!json.dependencies || typeof json.dependencies !== 'object') json.dependencies = {};
  if (json.dependencies[NAME] !== linkValue) { json.dependencies[NAME] = linkValue; changed = true; }
  const bundles = json.dsh.profile.bundles;
  if (!bundles.includes(NAME)) { bundles.push(NAME); changed = true; }
  // Bookkeeping marker (NOT an HMR trigger: refresh(manifestOnly) ignores
  // non-bundles keys). It records which plugin build has been deployed.
  if (json.dshAnywhereInject !== hash) { json.dshAnywhereInject = hash; changed = true; }
  if (changed) writeManifest(profile.pkg, json);

  return {
    profile: profile.dir, link: link, filesWritten: wrote,
    manifestChanged: changed, hash: hash, copyDir: copyDir, linkPath: linkPath,
  };
}

export function deployInject(opts) {
  const o = opts || {};
  const quiet = !!o.quiet;
  const say = (m) => { if (!quiet) log(m); };
  const src = pluginSrc();
  const result = { ok: false, pluginSrc: src, hash: '', homes: [], profiles: [], skipped: [], error: null };
  try {
    for (const f of FILES) {
      const p = path.join(src, f);
      if (!fs.existsSync(p)) throw new Error('plugin source missing: ' + p);
    }
    result.hash = sourceHash(src);
    for (const home of candidateHomes()) {
      const profiles = findProfiles(home);
      if (!profiles.length) {
        result.skipped.push(home + ' (no DSH profile with dsh.profile.bundles)');
        continue;
      }
      result.homes.push(home);
      for (const p of profiles) {
        try {
          const r = deployProfile(home, p, src, result.hash);
          result.profiles.push(r);
          say('deployed ' + r.profile + ' link=' + r.link + ' manifest=' + (r.manifestChanged ? 'updated' : 'unchanged'));
        } catch (e) {
          const m = p.dir + ': ' + (e && e.message ? e.message : String(e));
          result.skipped.push(m);
          say('skip ' + m);
        }
      }
    }
    result.ok = result.profiles.length > 0;
    say(result.ok
      ? 'injection bridge deployed (' + result.profiles.length + ' profile(s), hash=' + result.hash + ')'
      : 'no DSH profile found; injection bridge deployment skipped (harmless)');
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    say('deployment skipped: ' + result.error);
  }
  return result;
}

// Standalone entry point. When imported by host/cli.mjs, argv[1] is that file.
let invoked = false;
try { invoked = process.argv[1] ? realOrRaw(process.argv[1]) === realOrRaw(SELF) : false; } catch {}
if (invoked) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node install/deploy-inject.mjs [--quiet] [--strict] [--help]');
    console.log('');
    console.log('Deploys @local/dsh-anywhere-inject into every DSH profile under');
    console.log('$DSH_HOME (or ~/.dsh). Idempotent; never throws. DSH hot-loads the');
    console.log('plugin via HMR, so no restart / token / pairing change is needed.');
    console.log('Env: DSH_HOME, DSH_ANYWHERE_INJECT_SRC, DSH_ANYWHERE_INJECT_DSH_HOME.');
  } else {
    const r = deployInject({ quiet: process.argv.includes('--quiet') });
    console.log(JSON.stringify(r, null, 2));
    if (process.argv.includes('--strict') && !r.ok) process.exitCode = 1;
  }
}
