export const CATEGORIES = [
  "Income",
  "Housing",
  "Utilities",
  "Insurance",
  "Transportation",
  "Transportation Maintenance",
  "Groceries",
  "Dining Out",
  "Fast Food",
  "Coffee & Convenience",
  "Healthcare",
  "Personal Care",
  "Education",
  "Childcare",
  "Pet Care",
  "Subscriptions",
  "Household",
  "Gifts",
  "Travel",
  "Business Expenses",
  "Family Support",
  "Taxes",
  "Savings",
  "Safety Net Contribution",
  "One-Time Income",
  "Interest Income",
  "Transfer from Savings",
  "ATM & Bank Fees",
  "Religious Contribution",
  "Charity & Donations",
  "Miscellaneous",
  "Unknown"
];

/** Default Needs classification for Months Covered (needs only). */
export const NEEDS_CATEGORIES = new Set([
  "Housing",
  "Utilities",
  "Insurance",
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

/** Keyword → category, confidence 0–1 */
export const MERCHANT_RULES = [
  { re: /netflix|spotify|hulu|disney\+|apple\.com\/bill|youtube premium|amazon prime/i, cat: "Subscriptions", conf: 0.98 },
  { re: /walmart|costco|kroger|safeway|trader joe|whole foods|aldi|grocery|food lion|publix/i, cat: "Groceries", conf: 0.96 },
  { re: /mcdonald|burger king|wendy|taco bell|chipotle|subway|fast food/i, cat: "Fast Food", conf: 0.95 },
  { re: /starbucks|dunkin|coffee|7-eleven|circle k|wawa|sheetz/i, cat: "Coffee & Convenience", conf: 0.92 },
  { re: /restaurant|grill|bistro|cafe|dining|doordash|uber eats|grubhub/i, cat: "Dining Out", conf: 0.88 },
  { re: /shell|chevron|exxon|bp |mobil|gas station|fuel|ev charge|chargepoint/i, cat: "Transportation", conf: 0.94 },
  { re: /auto zone|oreilly|jiffy lube|oil change|tire|meineke|car wash/i, cat: "Transportation Maintenance", conf: 0.9 },
  { re: /geico|state farm|progressive|allstate|insurance/i, cat: "Insurance", conf: 0.93 },
  { re: /at&t|verizon|t-mobile|comcast|xfinity|spectrum|internet|fybercom|centurylink/i, cat: "Utilities", conf: 0.9 },
  { re: /rent|mortgage|landlord|property mgmt|hoa/i, cat: "Housing", conf: 0.92 },
  { re: /electric|power|water|sewer|utility|pg&e|duke energy/i, cat: "Utilities", conf: 0.91 },
  { re: /cvs|walgreens|pharmacy|medical|hospital|clinic|dental|doctor/i, cat: "Healthcare", conf: 0.88 },
  { re: /amazon(?! prime)|target|home depot|lowe'?s|ikea|household/i, cat: "Household", conf: 0.75 },
  { re: /uber(?!\s*eats)|lyft|parking|toll|transit|metro|bus pass|ferry/i, cat: "Transportation", conf: 0.85 },
  { re: /payroll|direct dep|salary|employer|ach credit|deposit/i, cat: "Income", conf: 0.85 },
  { re: /interest paid|interest earned|dividend|interest credit|savings interest|apy|annual percentage yield/i, cat: "Interest Income", conf: 0.95 },
  { re: /venmo|zelle|cash app|reimburs|repayment|paid you/i, cat: "Income", conf: 0.7, reimbursement: true },
  { re: /transfer to savings|safety net|emergency fund/i, cat: "Safety Net Contribution", conf: 0.8 },
  { re: /transfer from savings|savings transfer|xfer from sav|from savings/i, cat: "Transfer from Savings", conf: 0.95 },
  { re: /atm fee|non-network atm|out-of-network atm|foreign atm|atm surcharge|cash machine fee|atm withdrawal fee|bank fee|monthly fee|service fee|maintenance fee|overdraft fee|nsf fee|insufficient fund/i, cat: "ATM & Bank Fees", conf: 0.95 },
  { re: /tithe|tithing|church|diocese|parish|synagogue|mosque|temple|lds|latter.day|ward donation|fast offering|missionary fund/i, cat: "Religious Contribution", conf: 0.93 },
  { re: /donation|donate|charity|charitable|goodwill|salvation army|red cross|habitat for humanity|united way|gofundme|npo|nonprofit|non-profit/i, cat: "Charity & Donations", conf: 0.9 },
  { re: /capital one|credit one|payment thank you|card payment/i, cat: "Miscellaneous", conf: 0.6 }
];

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
