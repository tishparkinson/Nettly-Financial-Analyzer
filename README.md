# Nettly

**Build More Peace of Mind** — privacy-first Safety Net tracker with Stripe-gated access.

## Features

- 7-day free trial, then $6.99/mo (via Stripe)
- Access key for multi-device use (stored in Stripe customer metadata)
- Paste transactions, Safety Net, Months Covered, tags, couples mode
- `.ntly` snapshot files — no transaction data on servers

## Deploy to Netlify

1. Push the `nettly/` folder to GitHub.
2. In Netlify: **Add new site → Import from Git** → select repo.
3. Build settings (should auto-detect from `netlify.toml`):
   - Build command: `npm install`
   - Publish directory: `.`
4. **Site settings → Environment variables:**

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → Secret key (`sk_live_...` or `sk_test_...`) |
| `JWT_SECRET` | Long random string (e.g. 32+ chars from a password generator) |
| `SITE_URL` | `https://getnettly.com` |

5. **Domain:** Netlify → Domain management → add `getnettly.com` and follow DNS instructions.

6. Redeploy after adding env vars.

**Resend is not required.** Key recovery uses Stripe Customer Portal to verify email.

## Stripe checklist

- [ ] Payment Link: 7-day trial, $6.99/mo, card required
- [ ] Success URL: `https://getnettly.com/subscribed?session_id={CHECKOUT_SESSION_ID}`
- [ ] Customer Portal enabled (cancel, update payment method)
- [ ] Test mode first with test card `4242 4242 4242 4242`

## Local development

Functions only work with Netlify CLI:

```bash
cd nettly
npm install
npx netlify dev
```

Visit http://localhost:8888 (not plain `python -m http.server` — functions won't run).

## User flows

1. **New subscriber:** Start trial → `/subscribed` shows access key → start fresh or upload snapshot
2. **Same device:** Key in browser storage, re-validated daily against Stripe
3. **New device:** Enter access key, or **Find my access key** → Stripe verifies email → key shown

## Privacy

Transactions stay in browser localStorage and `.ntly` files. Servers store nothing except what Stripe holds for billing. Access keys are saved in Stripe customer metadata for recovery.
