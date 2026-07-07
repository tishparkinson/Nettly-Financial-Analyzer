export const CATEGORIES = [
  "Income",
  "Interest Income",
  "One-Time Income",
  "Housing",
  "Utilities",
  "Insurance",
  "Phone",
  "Phone & Internet Bundle",
  "Cable & TV Bundle",
  "Cable & Home Security Bundle",
  "Home Security",
  "Transportation",
  "Transportation Maintenance",
  "Groceries",
  "Dining Out",
  "Fast Food",
  "Coffee & Convenience",
  "Healthcare",
  "Personal Care",
  "Clothing, Shoes & Apparel",
  "Education",
  "Childcare",
  "Pet Care",
  "Subscriptions",
  "Household",
  "Gifts",
  "Travel",
  "Business Expenses",
  "Family Support",
  "Charity & Donations",
  "Religious Contribution",
  "Taxes",
  "Savings",
  "Safety Net Contribution",
  "Transfer",
  "Transfer from Savings",
  "Transfer from Checking",
  "ATM Withdrawal / Cash",
  "ATM & Bank Fees",
  "Miscellaneous",
  "Unknown"
];

/** Default Needs classification for Months Covered (needs only). */
export const NEEDS_CATEGORIES = new Set([
  "Housing",
  "Utilities",
  "Insurance",
  "Phone",
  "Phone & Internet Bundle",
  "Transportation",
  "Transportation Maintenance",
  "Groceries",
  "Healthcare",
  "Education",
  "Childcare",
  "Taxes",
  "Household"
]);

export const DEFAULT_TAGS = [
  "Travel",
  "Vacation",
  "Business Trip",
  "Home Repair",
  "Moving",
  "Christmas",
  "Holiday",
  "Birthday",
  "Wedding",
  "New Baby",
  "Medical Event",
  "Vehicle Purchase",
  "Family Event",
  "School / Education",
  "Pet Related",
  "Side Business",
  "Emergency",
  "Gift Giving"
];

/** Tag presets shown for "Clothing, Shoes & Apparel" transactions. */
export const CLOTHING_TAGS = [
  "Kids",
  "Adults",
  "Work Clothes",
  "Shoes",
  "Outerwear",
  "Seasonal / Back-to-School"
];

/** Tag presets shown for Transportation / Transportation Maintenance transactions. */
export const TRANSPORTATION_TAGS = [
  "Gas",
  "Maintenance",
  "Repairs",
  "Parking / Tolls",
  "Registration",
  "Car Payment"
];

/** Tag presets shown for ATM Withdrawal / Cash transactions. */
export const ATM_CASH_TAGS = [
  "Groceries",
  "Dining",
  "Gifts",
  "Kids",
  "Personal",
  "Miscellaneous"
];

/** Keyword → category, confidence 0–1. Order matters: more specific rules first. */
export const MERCHANT_RULES = [
  { re: /netflix|spotify|hulu|disney\+|apple\.com\/bill|youtube premium|amazon prime/i, cat: "Subscriptions", conf: 0.98 },
  { re: /walmart|costco|kroger|safeway|trader joe|whole foods|aldi|grocery|food lion|publix|broulim|maverik|family dollar/i, cat: "Groceries", conf: 0.9 },
  { re: /mcdonald|burger king|wendy|taco bell|chipotle|subway|fast food|raising canes|firehouse subs|costa vida/i, cat: "Fast Food", conf: 0.95 },
  { re: /starbucks|dunkin|dutch bros|coffee|7-eleven|circle k|wawa|sheetz/i, cat: "Coffee & Convenience", conf: 0.92 },
  { re: /restaurant|grill|bistro|cafe|dining|doordash|uber eats|grubhub|applebee|jamba juice|cold stone|pretzelmaker/i, cat: "Dining Out", conf: 0.85 },
  { re: /shell|chevron|exxon|bp |mobil|phillips 66|gas station|fuel|ev charge|chargepoint/i, cat: "Transportation", conf: 0.9 },
  { re: /auto zone|oreilly|jiffy lube|oil change|tire|meineke|car wash|fixxology/i, cat: "Transportation Maintenance", conf: 0.88 },
  { re: /geico|state farm|progressive|allstate|insurance/i, cat: "Insurance", conf: 0.9 },
  { re: /at&t|verizon|t-mobile|t mobile|cricket wireless|metro pcs|boost mobile|mint mobile|us cellular|straight talk/i, cat: "Phone", conf: 0.9 },
  { re: /comcast|xfinity|spectrum|internet|fybercom|centurylink/i, cat: "Utilities", conf: 0.88 },
  { re: /adt|vivint|simplisafe|frontpoint|ring alarm|alarm\.com|home security/i, cat: "Home Security", conf: 0.9 },
  { re: /rent|mortgage|landlord|property mgmt|hoa/i, cat: "Housing", conf: 0.9 },
  { re: /electric|power|water|sewer|utility|pg&e|duke energy/i, cat: "Utilities", conf: 0.88 },
  { re: /cvs|walgreens|pharmacy|medical|hospital|clinic|dental|doctor|evans hair/i, cat: "Healthcare", conf: 0.8 },
  { re: /ulta|gnc|tarte cosmetics|bohme|maurices|buckle|ae retail|love olive/i, cat: "Personal Care", conf: 0.75 },
  { re: /clothing|apparel|shoes|footwear|nike|adidas/i, cat: "Clothing, Shoes & Apparel", conf: 0.8 },
  { re: /amazon(?! prime)|target|home depot|lowe'?s|ikea|household/i, cat: "Household", conf: 0.7 },
  { re: /uber(?!\s*eats)|lyft|parking|toll|transit|metro|bus pass|ferry/i, cat: "Transportation", conf: 0.85 },

  // Non-spending / bank-generated noise
  { re: /added to account|account bonus/i, cat: "Income", conf: 0.9 },
  { re: /interest deposit|interest paid|dividend/i, cat: "Interest Income", conf: 0.9 },
  { re: /interest rate change|rate change notice|apy change/i, cat: "Miscellaneous", conf: 0.9 },
  { re: /acctverify|account verification|verify.*deposit|micro.?deposit/i, cat: "Miscellaneous", conf: 0.9 },
  { re: /overdraft fee|nsf fee|insufficient funds|monthly service fee|maintenance fee|atm fee/i, cat: "ATM & Bank Fees", conf: 0.9 },
  { re: /atm w\/d|atm withdrawal/i, cat: "ATM Withdrawal / Cash", conf: 0.9 },

  // Donations / tithing
  { re: /jesuschrist donation|tithing|ward donation|church donation/i, cat: "Religious Contribution", conf: 0.92 },
  { re: /donation|charity|nonprofit|red cross|goodwill/i, cat: "Charity & Donations", conf: 0.8 },

  // Internal transfers — specific purpose keywords first, generic catch-all last
  { re: /transfer.*\b(ins|insurance|acadia)\b/i, cat: "Insurance", conf: 0.75 },
  { re: /transfer.*\bphone\b/i, cat: "Phone", conf: 0.75 },
  { re: /transfer to savings|safety net|emergency fund/i, cat: "Safety Net Contribution", conf: 0.8 },
  { re: /transfer from x?\d+.*to.*savings/i, cat: "Transfer from Savings", conf: 0.7 },
  { re: /transfer from x?\d+.*to.*checking/i, cat: "Transfer from Checking", conf: 0.7 },
  { re: /^transfer (from|to) x?\d+/i, cat: "Transfer", conf: 0.7 },

  { re: /payroll|direct dep|salary|employer|ach credit|paycheck/i, cat: "Income", conf: 0.85 },
  { re: /venmo|zelle|cash app|reimburs|repayment|paid you/i, cat: "Income", conf: 0.7, reimbursement: true },
  { re: /capital one|credit one|payment thank you|card payment/i, cat: "Miscellaneous", conf: 0.6 }
];

/**
 * Budget guidelines: % of monthly take-home income considered reasonable for
 * each category. `aim` is the existing "Standard" ceiling (unchanged from
 * before). Careful/Generous bands are derived from it (half and 1.5x) rather
 * than hand-picked per category — that keeps the three tiers internally
 * consistent instead of guessing three new numbers for every category.
 * Above the Generous ceiling is flagged as worth a look, not "bad."
 */
export const BUDGET_GUIDELINES = {
  "Overall Wants": { aim: 30, note: "A common rule of thumb (the \"50/30/20\" guideline) targets about 30% of take-home for wants overall." },
  "Housing": { aim: 30, note: "Aim to keep housing under 30% of take-home." },
  "Transportation": { aim: 15, note: "Most budgets target transportation under 15% of take-home." },
  "Groceries": { aim: 12, note: "A common grocery target is under 12% of take-home." },
  "Dining Out": { aim: 8, note: "Dining out tends to add up — many households aim for under 8%." },
  "Fast Food": { aim: 5, note: "Fast food under 5% of take-home keeps it manageable." },
  "Coffee & Convenience": { aim: 4, note: "Coffee and convenience stops can sneak up — under 4% is a common target." },
  "Utilities": { aim: 8, note: "Utilities typically run 5–8% of take-home." },
  "Insurance": { aim: 20, note: "Insurance (all types) often lands between 10–20% of take-home." },
  "Healthcare": { aim: 8, note: "Healthcare costs vary widely — many budgets target under 8%." },
  "Subscriptions": { aim: 5, note: "Subscriptions are easy to accumulate — under 5% is a reasonable cap." },
  "Personal Care": { aim: 5, note: "Personal care typically runs 3–5% of take-home." },
  "Charity & Donations": { aim: 10, note: "Many aim to give 5–10% — whatever fits your values and situation." },
  "Religious Contribution": { aim: 10, note: "Tithing and religious giving are deeply personal — this is just for awareness." },
  "ATM & Bank Fees": { aim: 1, note: "Bank fees ideally stay under 1% of take-home — most can be avoided entirely." },
  "Gifts": { aim: 5, note: "Gift spending often spikes seasonally — under 5% annually is a common guideline." }
};

export const SPENDING_TIERS = ["Careful", "Standard", "Generous"];

/**
 * Given a % of income spent in a category (or overall), returns which of the
 * three non-judgmental tiers it falls in, plus whether it's beyond the
 * "Generous" ceiling entirely (i.e. worth a second look).
 */
export function getSpendingTier(pctOfIncome, guideline) {
  if (!guideline || pctOfIncome == null) return { tier: null, overGuideline: false };
  const careful = guideline.aim * 0.5;
  const standard = guideline.aim;
  const generous = guideline.aim * 1.5;
  if (pctOfIncome <= careful) return { tier: "Careful", overGuideline: false, careful, standard, generous };
  if (pctOfIncome <= standard) return { tier: "Standard", overGuideline: false, careful, standard, generous };
  if (pctOfIncome <= generous) return { tier: "Generous", overGuideline: false, careful, standard, generous };
  return { tier: "Generous", overGuideline: true, careful, standard, generous };
}


export function isNeedCategory(category, overrides = {}) {
  if (overrides[category] === "need") return true;
  if (overrides[category] === "want") return false;
  return NEEDS_CATEGORIES.has(category);
}

export function categorizeMerchant(description, merchantMemory = {}) {
  const key = normalizeMerchant(description);
  if (merchantMemory[key]) {
    return { category: merchantMemory[key], confidence: 1, merchant: key };
  }
  for (const rule of MERCHANT_RULES) {
    if (rule.re.test(description)) {
      return {
        category: rule.cat,
        confidence: rule.conf,
        merchant: key,
        reimbursement: Boolean(rule.reimbursement)
      };
    }
  }
  return { category: "Unknown", confidence: 0.4, merchant: key };
}

export function normalizeMerchant(description) {
  return (description || "")
    .replace(/\d{2}\/\d{2}(\/\d{2,4})?/g, "")
    .replace(/\$[\d,]+\.?\d*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .toUpperCase() || "UNKNOWN";
}
