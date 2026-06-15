# Quick Exhale — Launch checklist

Use this as your master setup list. Check boxes as you go.

## Repository and “current build”

- **There is no single installer file.** The site is static files + Netlify functions.
- **To get the project:** clone from GitHub, or **GitHub → Code → Download ZIP** (entire folder is the build).
- **After deploy:** your live site at `https://quickexhale.com` *is* the current production build.

---

## Domain and Netlify

- [ ] Connect **quickexhale.com** (and optional **www**) in Netlify.
- [ ] Pick **one** canonical host; redirect the other (e.g. apex → www or vice versa).
- [ ] Enable HTTPS (Netlify default).
- [ ] **Publish directory:** `.` · **Functions:** `netlify/functions`

---

## Environment variables (Netlify)

- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `STRIPE_SECRET_KEY`
- [ ] `STRIPE_PRICE_ID_MONTHLY`
- [ ] `STRIPE_WEBHOOK_SECRET`

---

## Supabase

- [ ] Create project; run **`supabase.sql`** in SQL editor.
- [ ] Enable **Email** magic-link auth.
- [ ] Set **Site URL** to production origin (e.g. `https://quickexhale.com`).
- [ ] Add redirect URLs if Supabase requires them for magic links.

---

## Frontend `config.js` (commit safe keys only)

- [ ] `ENV_SUPABASE_URL`
- [ ] `ENV_SUPABASE_ANON_KEY`
- [ ] `ENV_SITE_URL` matches canonical domain.

---

## Stripe (“paywall” / Pro)

- [ ] Product **Quick Exhale Pro**, **monthly** recurring price.
- [ ] **Checkout** tested (Subscribe → return URL → plan shows Pro).
- [ ] **Customer Billing Portal** enabled (cancel, update card, invoices).
- [ ] Webhook URL: `https://quickexhale.com/.netlify/functions/stripe-webhook`
- [ ] Webhook events: `checkout.session.completed`, subscription created/updated/deleted, `invoice.payment_failed`.

---

## Google

- [ ] **Search Console:** add property `https://quickexhale.com`, verify (meta tag in `index.html` head).
- [ ] Submit **`sitemap.xml`** (`https://quickexhale.com/sitemap.xml`).
- [ ] **Analytics GA4:** uncomment/add gtag in `index.html`; update **privacy policy** “when enabled” → live wording.
- [ ] Optional: **AdSense** only after privacy/cookies updated.

---

## SEO polish

- [ ] Add **`og:image`** when you have a 1200×630 asset (see comment in `index.html`).
- [ ] Optional: `favicon.ico` and `apple-touch-icon` in site root + `<link>` tags.

---

## Smoke tests before announcing

- [ ] Anonymous: full free flow (unload → 3 → UI).
- [ ] Sign in → Upgrade → **Manage subscription** opens Stripe portal.
- [ ] Pro: calendar export + cloud backup/restore.
- [ ] `robots.txt` and `sitemap.xml` load over HTTPS.

---

## Honest note on “AI will recommend this”

Structured data and clear copy help **Google** understand the tool. **AI assistants** do not guarantee inclusion; quality, reputation, backlinks, and policies of each platform matter. Schema is still worth doing for search and rich results where eligible.
