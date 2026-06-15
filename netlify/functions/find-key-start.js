const { createReturnToken } = require("./lib/access-key");
const {
  getStripe,
  getSiteUrl,
  jsonResponse,
  subscriptionAllowsAccess,
  getCustomerByEmail
} = require("./lib/stripe-helpers");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const { email } = JSON.parse(event.body || "{}");
    const stripe = getStripe();
    const customer = await getCustomerByEmail(stripe, email);

    if (!customer) {
      return jsonResponse(404, {
        ok: false,
        error: "No Nettly account found for that email. Use the same email you entered at checkout."
      });
    }

    const access = await subscriptionAllowsAccess(stripe, customer.id);
    if (!access.ok) {
      return jsonResponse(403, {
        ok: false,
        error: "That email does not have an active trial or subscription."
      });
    }

    const token = createReturnToken(customer.id);
    const returnUrl = `${getSiteUrl()}/find-key.html?verified=${encodeURIComponent(token)}`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl
    });

    return jsonResponse(200, { ok: true, url: portalSession.url });
  } catch (err) {
    console.error("find-key-start error:", err);
    return jsonResponse(500, { ok: false, error: "Could not start key recovery." });
  }
};
