#!/usr/bin/env node
// Import Amazon redemption links from a CSV into the database.
//
//   node scripts/import-links.mjs path/to/links.csv
//
// - Picks the column whose header contains "url" or "link" (e.g. "url" or "Redemption link").
// - Ignores blank rows and anything that isn't an http(s) link.
// - Safe to run more than once: links already in the database are skipped, never duplicated,
//   and claimed links are never touched.
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or from a local .env file.

import { readFileSync, existsSync } from 'node:fs';

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function extractLinks(csvText) {
  const rows = parseCsv(csvText.replace(/^﻿/, ''));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => h === 'url' || h === 'redemption_url');
  if (col === -1) col = header.findIndex((h) => h.includes('url') || h.includes('link'));
  const hasHeader = col !== -1;
  if (!hasHeader) col = 0;
  const seen = new Set();
  const links = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const v = (r[col] || '').trim();
    if (/^https?:\/\//i.test(v) && !seen.has(v)) { seen.add(v); links.push(v); }
  }
  return links;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/import-links.mjs path/to/links.csv'); process.exit(1); }
  loadDotEnv();
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env or the environment).'); process.exit(1); }

  const links = extractLinks(readFileSync(file, 'utf8'));
  if (!links.length) { console.error('No links found. Make sure the CSV has a "url" or "link" column.'); process.exit(1); }
  console.log(`Found ${links.length} unique links in ${file}`);

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (let i = 0; i < links.length; i += 100) {
    const batch = links.slice(i, i + 100).map((redemption_url) => ({ redemption_url }));
    const res = await fetch(`${base}/rest/v1/books?on_conflict=redemption_url`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) { console.error(`Import failed (${res.status}): ${await res.text()}`); process.exit(1); }
  }

  const s = await fetch(`${base}/rest/v1/giveaway_stats?select=*`, { headers }).then((r) => r.json());
  const st = Array.isArray(s) ? s[0] : s;
  console.log(`Done. Database now has ${st.total_books} links — ${st.claimed} claimed, ${st.remaining} available.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
