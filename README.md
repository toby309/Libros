# De-Risking Startups — Kindle Giveaway

QR → landing page → email → one unique Amazon Kindle link per person.

**Stack (all free tiers):**
- **Vercel** — hosts the page (`public/index.html`) and 3 tiny API functions (`api/`)
- **Supabase** (Postgres) — stores the links and does the atomic assignment
- **Resend** — sends the confirmation email

No frameworks, no `npm install`, no build step.

```
public/index.html        Landing page (form → success → sold out)
api/claim.js             POST: validate email, assign/reuse link, send email
api/status.js            GET: { available: true/false } — no links, no counts
api/admin.js             Read-only tracking page (token protected)
lib/server.js            DB + email helpers (server only)
supabase/schema.sql      Tables, claim function, tracking views
scripts/import-links.mjs CSV importer (optional — see step 2)
private/                 YOUR LINKS. Never commit, never upload to Vercel.
```

---

## How the safety works

All assignment happens inside one Postgres function, `claim_book(email)`, in a single transaction:

1. The email is trimmed and lower-cased (`John@Gmail.com ` = `john@gmail.com`).
2. A lock on that email serializes double-taps / two tabs.
3. If the email already has a link → return that same link. Nothing new is consumed.
4. Otherwise, lock the next free row with `FOR UPDATE SKIP LOCKED` (two simultaneous people always lock *different* rows) and mark it claimed.
5. Database constraints are the final guarantee: `redemption_url` is UNIQUE, `claimed_by_email` is UNIQUE.

- If anything fails mid-way, the transaction rolls back — no link is lost or half-claimed.
- The email is sent **after** the link is saved. If the email fails, the claim stays; the person still sees the link on screen, and the failure is logged in `email_error`. If they submit again later, the email is retried (never more than once every 2 minutes).
- The browser only ever receives the one link for the email it submitted. The links table is locked down (RLS + revoked grants); only the server, using the secret key, can read it.
- Rate limit: 60 attempts per IP per 5 minutes (configurable), plus a hidden honeypot field for bots.

Tested on Postgres 16: 700 simultaneous requests (350 people × 2 submissions with mixed case) against 300 links → 300 assigned, 300 correct repeats, 100 sold-out, **0 duplicates**.

---

## Setup (about 20 minutes)

### 1. Supabase (database)
1. Create a free project at https://supabase.com.
2. Go to **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY` (never put this in the page or share it)

### 2. Import the links
**Easiest:** open `private/import-links.sql` (already generated from your CSV, 300 links), paste it into the SQL Editor, **Run**. It finishes by showing `total_books = 300`.

**Or, from a CSV** (e.g. if you get more links later):
```bash
cp .env.example .env          # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
node scripts/import-links.mjs private/ebook_links.csv
```
The importer finds any column called `url` or containing `link` (your file's `Redemption link` works). Re-running is safe: existing links are skipped, claimed links are never touched.

### 3. Resend (email)
1. Create an account at https://resend.com.
2. **Domains → Add domain** (e.g. `rocketbeet.com`) and add the DNS records it shows. Wait until it says *Verified*. Without this, emails will only reach your own address.
3. **API Keys → Create** → `RESEND_API_KEY`.
4. `EMAIL_FROM` = e.g. `Rocketbeet <books@rocketbeet.com>` (must use the verified domain).

### 4. Deploy to Vercel
1. Put this folder in a GitHub repo (the `.gitignore` already excludes `private/`, `.env` and CSVs), then **Vercel → Add New → Project → Import**. Framework preset: **Other**. No build command.
   *Or* without GitHub: `npm i -g vercel` then `vercel --prod` from this folder (`.vercelignore` keeps `private/` out).
2. **Settings → Environment Variables** — add everything from `.env.example`:

| Variable | Required | Example |
|---|---|---|
| `SUPABASE_URL` | yes | `https://abcd.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | (secret) |
| `RESEND_API_KEY` | yes | `re_...` |
| `EMAIL_FROM` | yes | `Rocketbeet <books@rocketbeet.com>` |
| `ADMIN_TOKEN` | for admin page | a long random string (12+ chars) |
| `BOOK_TITLE` | no | `De-Risking Startups` |
| `EMAIL_REPLY_TO` | no | `juan@rocketbeet.com` |
| `ADMIN_TIMEZONE` | no | `America/Argentina/Buenos_Aires` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | no | `60` / `300` |
| `RATE_LIMIT_SALT` | no | any random string |

3. **Redeploy** after adding variables (Deployments → ⋯ → Redeploy).
4. Optional: add a custom domain (e.g. `book.rocketbeet.com`) under **Settings → Domains**, and point the QR there.

### 5. Test before the event
1. Open the site on your phone, claim with your own email → you should see the link and get the email.
2. Submit the same email again with capitals → same link, no new one used.
3. Open `/api/admin?token=YOUR_ADMIN_TOKEN` → you should see 1 claimed, 299 remaining.
4. **Release your test claim** so all 300 are available again (SQL Editor):
   ```sql
   update books set claimed=false, claimed_by_email=null, claimed_at=null,
     email_sent=false, email_sent_at=null, email_error=null, email_last_attempt_at=null
   where claimed_by_email = 'you@yourmail.com';
   ```
   Only do this for test claims whose link you never opened/redeemed.

---

## Tracking during / after the event

- **Admin page:** `https://YOUR-SITE/api/admin?token=YOUR_ADMIN_TOKEN` — claimed, remaining, emails sent/failed, and every email → link → time. Has a **Download CSV** button. Bookmark it on your phone.
- **Supabase:** SQL Editor → `select * from giveaway_stats;` or `select * from giveaway_claims;` — or browse the `books` table in the Table Editor.
- **Failed emails:** rows with `email_sent = false` show the reason in `email_error`. The person already saw their link on screen; if they submit again, the email is retried.

## Common edits
- **Page text** → `public/index.html` (title, subtitle, button labels are plain HTML near the bottom).
- **Email text** → `buildEmail()` in `lib/server.js`.
- **Auto-open delay** → `REDIRECT_SECONDS` in `public/index.html` (set to a huge number to disable).
- **Adding more links later** → run the importer or a new `insert ... on conflict do nothing`.

## Known trade-offs (by design, to keep it simple)
- There's no email verification: whoever types an email gets that email's link. Typing *someone else's* email returns *their* link (it doesn't consume a new one). Fine for an in-person giveaway; adding a verification code would add friction at the event.
- Venue Wi-Fi often shares one IP across hundreds of phones, so the rate limit is deliberately generous. If you see abuse, lower `RATE_LIMIT_MAX`.
- After sold out, the page shows the sold-out screen on load, so people who already claimed should use the link in their email.
