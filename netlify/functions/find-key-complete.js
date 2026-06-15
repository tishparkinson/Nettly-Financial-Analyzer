const { parseReturnToken } = require("./lib/access-key");
const {
  getStripe,
  jsonResponse,
  subscriptionAllowsAccess,
  ensureCustomerAccessKey
} = require("./lib/stripe-helpers");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const { token } = JSON.parse(event.body || "{}");
    const customerId = parseReturnToken(token);
    if (!customerId) {
      return jsonResponse(401, { ok: false, error: "This recovery link expired. Please try again." });
    }

    const stripe = getStripe();
    const access = await subscriptionAllowsAccess(stripe, customerId);
    if (!access.ok) {
      return jsonResponse(403, {
        ok: false,
        error: "Your trial or subscription is not active."
      });
    }

    const accessKey = await ensureCustomerAccessKey(stripe, customerId);
    const customer = await stripe.customers.retrieve(customerId);

    return jsonResponse(200, {
      ok: true,
      accessKey,
      email: customer.email || "",
      status: access.status
    });
  } catch (err) {
    console.error("find-key-complete error:", err);
    return jsonResponse(500, { ok: false, error: "Could not retrieve your access key." });
  }
};
