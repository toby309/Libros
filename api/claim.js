// POST /api/claim  { email }  →  assigns (or re-uses) one Kindle link for that email.
import { rpc, sendBookEmail, normalizeEmail, isValidEmail, clientKey, intEnv } from '../lib/server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot: real people never fill the hidden "website" field.
  if (body.website) {
    return res.status(400).json({ status: 'error', message: 'Please try again.' });
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ status: 'invalid', message: 'Please enter a valid email address.' });
  }

  try {
    // Basic abuse protection (per IP). Generous on purpose: at a venue many
    // phones share the same Wi-Fi IP. Tune with env vars.
    const allowed = await rpc('hit_rate_limit', {
      p_key: clientKey(req),
      p_limit: intEnv('RATE_LIMIT_MAX', 60),
      p_window_seconds: intEnv('RATE_LIMIT_WINDOW_SECONDS', 300),
    });
    if (allowed === false) {
      return res.status(429).json({ status: 'rate_limited', message: 'Too many attempts. Please wait a minute and try again.' });
    }

    // Atomic claim — all the safety lives in the database function.
    const rows = await rpc('claim_book', { p_email: email });
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (!result) throw new Error('Empty result from claim_book');

    if (result.status === 'sold_out') {
      return res.status(200).json({ status: 'sold_out' });
    }
    if (result.status === 'invalid') {
      return res.status(400).json({ status: 'invalid', message: 'Please enter a valid email address.' });
    }

    // The link is now permanently stored for this email.
    // Email failure below can never cost a second link.
    let emailSent = Boolean(result.email_sent);
    if (result.should_send) {
      try {
        await sendBookEmail(email, result.url);
        emailSent = true;
        await rpc('record_email_result', { p_email: email, p_sent: true, p_error: null }).catch((e) =>
          console.error('record_email_result (sent) failed:', e.message)
        );
      } catch (err) {
        emailSent = false;
        console.error('Email send failed for claim:', err.message);
        await rpc('record_email_result', { p_email: email, p_sent: false, p_error: err.message }).catch((e) =>
          console.error('record_email_result (failed) failed:', e.message)
        );
      }
    }

    return res.status(200).json({
      status: result.status, // 'new' | 'existing'
      url: result.url,
      emailSent,
    });
  } catch (err) {
    // Any DB error rolls back the transaction: no link is consumed or lost.
    console.error('Claim failed:', err.message);
    return res.status(503).json({ status: 'error', message: 'Something went wrong. Please try again.' });
  }
}
