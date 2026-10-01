// GET /api/admin?token=YOUR_ADMIN_TOKEN            → simple tracking page
// GET /api/admin?token=YOUR_ADMIN_TOKEN&format=csv → download all claims as CSV
// Read-only. Disabled unless ADMIN_TOKEN is set.
import { safeEqual } from '../lib/server.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function select(path) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DB read failed (${res.status})`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');

  const expected = process.env.ADMIN_TOKEN;
  const given = req.query?.token || req.headers['x-admin-token'] || '';
  if (!expected || expected.length < 12 || !safeEqual(given, expected)) {
    return res.status(404).send('Not found');
  }

  try {
    const [stats] = await select('giveaway_stats?select=*');
    const claims = await select('giveaway_claims?select=*&order=claimed_at.desc');

    if (req.query?.format === 'csv') {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['email,redemption_url,claimed_at,email_sent,email_sent_at,email_error'];
      for (const c of claims) {
        lines.push([c.email, c.redemption_url, c.claimed_at, c.email_sent, c.email_sent_at, c.email_error].map(q).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="book-claims.csv"');
      return res.status(200).send(lines.join('\n'));
    }

    const fmt = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: process.env.ADMIN_TIMEZONE || 'UTC' }) : '—');
    const rows = claims
      .map(
        (c) => `<tr>
          <td>${esc(c.email)}</td>
          <td>${esc(fmt(c.claimed_at))}</td>
          <td>${c.email_sent ? '<span class="ok">Sent</span>' : `<span class="bad" title="${esc(c.email_error)}">Not sent</span>`}</td>
          <td class="url">${esc(c.redemption_url)}</td>
        </tr>`
      )
      .join('');

    const tokenParam = encodeURIComponent(given);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Giveaway tracking</title>
<style>
  body{margin:0;background:#080810;color:#f0eeff;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px 16px}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:22px;margin:0 0 16px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
  .stat{background:#0e0e1a;border:1px solid rgba(124,58,237,.25);border-radius:12px;padding:14px}
  .n{font-size:28px;font-weight:800}.l{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b87a8}
  .bar{display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  a{color:#c084fc}
  .tw{overflow-x:auto;border:1px solid rgba(124,58,237,.25);border-radius:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(124,58,237,.12);white-space:nowrap}
  th{background:#13131f;color:#8b87a8;font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
  .url{font-family:ui-monospace,monospace;font-size:12px;color:#8b87a8}
  .ok{color:#22c55e}.bad{color:#ef4444}
</style></head><body><div class="wrap">
<h1>Book giveaway — tracking</h1>
<div class="stats">
  <div class="stat"><div class="n">${stats.claimed}</div><div class="l">Claimed</div></div>
  <div class="stat"><div class="n">${stats.remaining}</div><div class="l">Remaining</div></div>
  <div class="stat"><div class="n">${stats.total_books}</div><div class="l">Total links</div></div>
  <div class="stat"><div class="n">${stats.emails_sent}</div><div class="l">Emails sent</div></div>
  <div class="stat"><div class="n">${stats.emails_not_sent}</div><div class="l">Emails not sent</div></div>
</div>
<div class="bar"><a href="?token=${tokenParam}">Refresh</a> · <a href="?token=${tokenParam}&format=csv">Download CSV</a></div>
<div class="tw"><table><thead><tr><th>Email</th><th>Claimed at</th><th>Email</th><th>Redemption link</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No claims yet.</td></tr>'}</tbody></table></div>
</div></body></html>`);
  } catch (err) {
    console.error('Admin page failed:', err.message);
    return res.status(500).send('Could not load data. Check the server logs.');
  }
}
