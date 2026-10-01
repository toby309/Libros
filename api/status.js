// GET /api/status  →  { available: true|false }
// Lets the page show the sold-out screen before anyone types an email.
// Exposes no links and no counts.
import { rpc } from '../lib/server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const remaining = await rpc('books_remaining');
    return res.status(200).json({ available: Number(remaining) > 0 });
  } catch (err) {
    console.error('Status check failed:', err.message);
    // Fail open: show the form; /api/claim will answer sold_out if needed.
    return res.status(200).json({ available: true });
  }
}
