# Quick Exhale (MVP + Pro)

**Quick Exhale** (quickexhale.com) — a calm web tool: unload thoughts, pick **three** priorities, timebox them.

This repo includes:

- Guided unload session with rotating prompts  
- Text box or pen-and-paper flow  
- Organized list, repeat session (append vs new list)  
- Supabase magic-link sign-in  
- Stripe **monthly** Pro subscription  
- **Stripe Customer Billing Portal** (“Manage subscription” in the app — hosted by Stripe, opened via `create-billing-portal-session`)  
- Cloud backup/restore (Pro)  
- Calendar export (Pro): Google + `.ics`  
- Legal pages: `privacy.html`, `terms.html` (Verdant Web Solutions, LLC)  
- JSON-LD on `index.html` and `about.html`  
- `robots.txt` and `sitemap.xml` for crawlers  
- Step-by-step checklist: **`LAUNCH-TODO.md`**  

## Branding and naming

- **Product / tool name (customer-facing):** **Quick Exhale** — use this in the UI, schema `name`, emails, and Stripe product names (e.g. “Quick Exhale Pro”).
- **Domain:** **quickexhale.com** (and optionally **www.quickexhale.com** with a single canonical primary; point the other with a redirect in Netlify).
- **Legal entity:** **Verdant Web Solutions, LLC** — operator named in Privacy and Terms.

## Privacy and security

- Local-first by default; optional Pro cloud backup.  
- Secrets only in Netlify env vars; service role only in functions.  
- Public values only in `config.js` (Supabase URL + anon key + `ENV_SITE_URL`).

## Local preview

```bash
python -m http.server 5173
```

Open [http://localhost:5173](http://localhost:5173).  
API routes (`/api/*`) need Netlify or `netlify dev` to work locally.

## Deploy (Netlify + Supabase + Stripe)

### 1) Supabase

1. Create a project.  
2. Run `supabase.sql` in the SQL editor.  
3. Enable **Email** auth (magic link).  
4. Copy **Project URL**, **anon** key, **service_role** key.

### 2) Stripe

1. Create product **Quick Exhale Pro**, **monthly** price (e.g. $9).  
2. Copy **`price_...` id** into `STRIPE_PRICE_ID_MONTHLY`.  
3. **Customer portal:** Stripe Dashboard → **Settings → Billing → Customer portal** — enable it and allow customers to **cancel subscriptions** (and update payment method / view invoices).  
4. Copy **Secret key** `sk_...`.

### 3) Netlify

1. Connect this Git repo.  
2. **Publish directory:** `.`  
3. **Functions:** `netlify/functions`  
4. Add env vars:

   - `SUPABASE_URL`  
   - `SUPABASE_ANON_KEY`  
   - `SUPABASE_SERVICE_ROLE_KEY`  
   - `STRIPE_SECRET_KEY`  
   - `STRIPE_PRICE_ID_MONTHLY`  
   - `STRIPE_WEBHOOK_SECRET` (after creating the webhook)

### 4) Frontend `config.js`

Set:

- `window.ENV_SUPABASE_URL`  
- `window.ENV_SUPABASE_ANON_KEY`  
- `window.ENV_SITE_URL = "https://quickexhale.com"` (or your final URL)

Never put the service role or Stripe secret in `config.js`.

### 5) Stripe webhook

- Endpoint: `https://YOUR_SITE/.netlify/functions/stripe-webhook`  
- Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`  
- Set `STRIPE_WEBHOOK_SECRET` in Netlify and redeploy.

### 6) Custom domain

In Netlify: add **quickexhale.com**, set DNS, enable HTTPS.  
Stripe **Customer portal return URL** will use your production origin (the app passes `returnUrl` from the browser).

## Netlify and subscription management

**Netlify does not run your subscription or payment UI.** It hosts the site and runs small **serverless functions** that call **Stripe**. The page where users cancel or update cards is **Stripe’s Customer Billing Portal** (stripe.com domain). That is the correct, standard setup — same idea as your prior project if it used Stripe checkout + portal.

## After deploy

- Add **Google Analytics** / **Search Console** per `index.html` comments and keep `privacy.html` in sync.  
- If you enable **AdSense**, update privacy for ads/cookies before going live.
