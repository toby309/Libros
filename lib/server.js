// Shared server-side helpers. Nothing in this folder is ever sent to the browser.
import { createHash, timingSafeEqual } from 'node:crypto';

export const BOOK_TITLE = process.env.BOOK_TITLE || 'De-Risking Startups';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

// ---------- Database (Supabase REST, service role — server only) ----------
export async function rpc(fn, args = {}) {
  const base = requireEnv('SUPABASE_URL').replace(/\/+$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${fn} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Email (Resend) ----------
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildEmail(url) {
  const title = escapeHtml(BOOK_TITLE);
  const safeUrl = escapeHtml(url);
  const subject = `Your copy of ${BOOK_TITLE}`;
  const text =
    `Thanks for claiming your complimentary copy of ${BOOK_TITLE}.\n\n` +
    `You can redeem your Kindle copy here:\n${url}\n\n` +
    `Enjoy the read!`;
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f2fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1730;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#e040fb);background-color:#7c3aed;"></td></tr>
        <tr><td style="padding:36px 32px 32px;">
          <p style="margin:0 0 20px;font-size:17px;line-height:1.6;">Thanks for claiming your complimentary copy of <strong>${title}</strong>.</p>
          <p style="margin:0 0 24px;font-size:17px;line-height:1.6;">You can redeem your Kindle copy here:</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#7c3aed;">
            <a href="${safeUrl}" style="display:inline-block;padding:16px 32px;font-size:17px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">Get the Book</a>
          </td></tr></table>
          <p style="margin:28px 0 0;font-size:17px;line-height:1.6;">Enjoy the read!</p>
          <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#8b87a8;">If the button doesn't work, copy this link into your browser:<br><a href="${safeUrl}" style="color:#7c3aed;word-break:break-all;">${safeUrl}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}

export async function sendBookEmail(to, url) {
  const apiKey = requireEnv('RESEND_API_KEY');
  const from = requireEnv('EMAIL_FROM');
  const { subject, text, html } = buildEmail(url);
  const body = { from, to: [to], subject, html, text };
  if (process.env.EMAIL_REPLY_TO) body.reply_to = process.env.EMAIL_REPLY_TO;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Email provider error ${res.status}: ${detail.slice(0, 300)}`);
  }
}

// ---------- Misc ----------
export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function clientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  const salt = process.env.RATE_LIMIT_SALT || 'book-giveaway';
  return 'ip:' + createHash('sha256').update(salt + ip).digest('hex').slice(0, 32);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function intEnv(name, fallback) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
