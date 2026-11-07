// DSH Anywhere shared protocol helpers. Zero third-party deps.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const VERSION = '1.0.0';
export const PROTOCOL = 'dsh-anywhere/1';

export function defaultHome() {
  return process.env.DSH_ANYWHERE_HOME || path.join(os.homedir(), '.dsh-anywhere');
}
export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}
export function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}
export function writeText(p, s) {
  try { ensureDir(path.dirname(p)); fs.writeFileSync(p, String(s)); } catch (e) {}
}
export function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}
export function randomId(prefix) {
  return (prefix || 'id-') + crypto.randomBytes(5).toString('hex');
}
export function pairCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal JSON HTTP request. Adds Bearer token and ?token= (for EventSource-style GETs).
export function request(base, pathname, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const token = opts.token || '';
  const timeout = opts.timeout || 10000;
  const u = new URL(pathname, base);
  if (token && !u.searchParams.has('token')) u.searchParams.set('token', token);
  const body = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body));
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = mod.request(u, { method: method, headers: headers }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, text: buf, json: json });
        });
      });
    } catch (e) { return reject(e); }
    req.setTimeout(timeout, () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
