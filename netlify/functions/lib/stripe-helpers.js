const Stripe = require("stripe");
const { createAccessKey, parseAccessKey } = require("./access-key");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function subscriptionAllowsAccess(stripe, customerId) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10
  });

  for (const sub of subs.data) {
    if (sub.status === "trialing" || sub.status === "active") {
      return { ok: true, status: sub.status };
    }
  }

  return { ok: false, status: "none" };
}

async function getCustomerByEmail(stripe, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const list = await stripe.customers.list({ email: normalized, limit: 1 });
  return list.data[0] || null;
}

async function ensureCustomerAccessKey(stripe, customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const existing = customer.metadata?.nettly_access_key;

  if (existing) {
    const parsedCustomerId = parseAccessKey(existing);
    if (parsedCustomerId === customerId) {
      return existing;
    }
  }

  const accessKey = createAccessKey(customerId);
  await stripe.customers.update(customerId, {
    metadata: { ...customer.metadata, nettly_access_key: accessKey }
  });
  return accessKey;
}

module.exports = {
  getStripe,
  getSiteUrl,
  jsonResponse,
  subscriptionAllowsAccess,
  getCustomerByEmail,
  ensureCustomerAccessKey
};
