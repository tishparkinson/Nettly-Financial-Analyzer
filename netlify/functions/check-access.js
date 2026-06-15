const { parseAccessKey } = require("./lib/access-key");
const { getStripe, jsonResponse, subscriptionAllowsAccess } = require("./lib/stripe-helpers");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const { accessKey } = JSON.parse(event.body || "{}");
    const customerId = parseAccessKey(accessKey);
    if (!customerId) {
      return jsonResponse(401, { ok: false, error: "Invalid access key." });
    }

    const stripe = getStripe();
    const access = await subscriptionAllowsAccess(stripe, customerId);
    if (!access.ok) {
      return jsonResponse(403, {
        ok: false,
        error: "Your trial or subscription is not active. Start a new trial or update billing."
      });
    }

    const customer = await stripe.customers.retrieve(customerId);
    return jsonResponse(200, {
      ok: true,
      status: access.status,
      email: customer.email || ""
    });
  } catch (err) {
    console.error("check-access error:", err);
    return jsonResponse(500, { ok: false, error: "Could not verify access." });
  }
};
