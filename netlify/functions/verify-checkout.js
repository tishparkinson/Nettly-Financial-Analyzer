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
    const { sessionId } = JSON.parse(event.body || "{}");
    if (!sessionId) {
      return jsonResponse(400, { ok: false, error: "Missing sessionId" });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"]
    });

    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return jsonResponse(400, { ok: false, error: "Checkout is not complete yet." });
    }

    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!customerId) {
      return jsonResponse(400, { ok: false, error: "No customer found for this checkout." });
    }

    const access = await subscriptionAllowsAccess(stripe, customerId);
    if (!access.ok) {
      return jsonResponse(403, { ok: false, error: "No active trial or subscription found." });
    }

    const accessKey = await ensureCustomerAccessKey(stripe, customerId);
    const customer = typeof session.customer === "object" ? session.customer : await stripe.customers.retrieve(customerId);

    return jsonResponse(200, {
      ok: true,
      accessKey,
      email: customer.email || session.customer_details?.email || "",
      status: access.status
    });
  } catch (err) {
    console.error("verify-checkout error:", err);
    return jsonResponse(500, { ok: false, error: "Could not verify checkout." });
  }
};
