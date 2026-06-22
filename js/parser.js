const DATE_PATTERNS = [
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, parse: (m) => parseMDY(m[1], m[2], m[3]) },
  { re: /^(\d{4})-(\d{2})-(\d{2})\b/, parse: (m) => new Date(+m[1], +m[2] - 1, +m[3]) },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{2,4})\b/, parse: (m) => parseMDY(m[1], m[2], m[3]) },
  // Month-name formats: "Jan 2", "January 2", "Jan 2 2025", "January 02, 2025"
  { re: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:[,\s]+(\d{4}))?\b/i,
    parse: (m) => {
      const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
      const mo = months[m[1].slice(0,3).toLowerCase()];
      const yr = m[3] ? +m[3] : new Date().getFullYear();
      return new Date(yr, mo, +m[2]);
    }
  }
];

function parseMDY(m, d, y) {
  let year = +y;
  if (year < 100) year += year > 50 ? 1900 : 2000;
  return new Date(year, +m - 1, +d);
}

function parseAmount(raw) {
  if (raw == null || raw === "") return null;
  let s = String(raw).trim().replace(/,/g, "");
  const paren = /^\((.+)\)$/.exec(s);
  if (paren) s = "-" + paren[1];
  s = s.replace(/[^\d.-]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function extractDateFromLine(line) {
  for (const { re, parse } of DATE_PATTERNS) {
    const m = line.match(re);
    if (m) {
      const d = parse(m);
      if (!Number.isNaN(d.getTime())) {
        return { date: d, rest: line.slice(m[0].length).trim() };
      }
    }
  }
  return { date: null, rest: line };
}

function extractAmountFromLine(line) {
  const amounts = [...line.matchAll(/-?\$?\s*[\d,]+\.\d{2}\b/g)].map((x) => parseAmount(x[0]));
  if (!amounts.length) {
    const ints = [...line.matchAll(/-?\$?\s*[\d,]+\.\d{2}|-?\$?\s*[\d,]+/g)].map((x) => parseAmount(x[0]));
    if (ints.length) return ints[ints.length - 1];
    return null;
  }
  return amounts[amounts.length - 1];
}

function isHeaderLine(line) {
  return /^(date|posted|transaction|description|amount|debit|credit|balance)\b/i.test(line);
}

/**
 * Parse pasted bank/credit card text into transactions.
 */
export function parseTransactions(text, accountNickname, accountType) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isHeaderLine(l));

  const results = [];

  // ── Multi-line block detection ────────────────────────────────────────────
  // Handles formats where each transaction spans multiple lines, e.g.:
  //   MERCHANT DESCRIPTION       ← line 0: description (no date, no leading $)
  //   Jan 2                      ← line 1: standalone date
  //   $11.32                     ← line 2: amount (leading $)
  //   $58.08                     ← line 3: running balance (skip)
  //
  // Detection: if >50% of lines are standalone dates or standalone $ amounts,
  // treat the whole paste as multi-line blocks rather than single-line rows.
  const isStandaloneDate = (l) => extractDateFromLine(l).date !== null && l.length < 30;
  const isStandaloneDollar = (l) => /^\$[\d,]+\.\d{2}$/.test(l);
  const isDescriptionLine = (l) => !isStandaloneDate(l) && !isStandaloneDollar(l) && !/^\d+\.\d{2}$/.test(l);

  const standaloneDateCount = lines.filter(isStandaloneDate).length;
  const standaloneDollarCount = lines.filter(isStandaloneDollar).length;

  if (standaloneDateCount >= 2 && standaloneDollarCount >= 2 &&
      (standaloneDateCount + standaloneDollarCount) / lines.length > 0.35) {
    // Parse as multi-line blocks: group lines into [description, date, amount, balance?]
    let i = 0;
    while (i < lines.length) {
      // Find a description line (no date, no leading $)
      if (!isDescriptionLine(lines[i])) { i++; continue; }
      const description = lines[i];
      let date = null;
      let amount = null;
      let j = i + 1;

      // Consume following lines that belong to this block
      // A new block starts when we see another description line after we have date+amount
      while (j < lines.length) {
        const l = lines[j];
        if (!date && isStandaloneDate(l)) {
          date = extractDateFromLine(l).date;
          j++; continue;
        }
        if (date && amount == null && (isStandaloneDollar(l) || /^\d+\.\d{2}$/.test(l))) {
          amount = parseAmount(l);
          j++; continue;
        }
        // Second dollar line = running balance, skip it
        if (date && amount != null && (isStandaloneDollar(l) || /^\d+\.\d{2}$/.test(l))) {
          j++; break;
        }
        // Hit something that looks like a new description — stop
        if (isDescriptionLine(l) && date && amount != null) break;
        if (isDescriptionLine(l) && !date && !amount) { j++; continue; }
        j++;
      }

      if (date && amount != null && description.length > 1) {
        results.push(makeTx(date, description, -Math.abs(amount), accountNickname, accountType));
      }
      i = j;
    }
    return results;
  }
  // ── End multi-line block detection ───────────────────────────────────────

  for (const line of lines) {
    if (line.includes("\t")) {
      const cols = line.split("\t").map((c) => c.trim());
      const parsed = parseColumns(cols, accountNickname, accountType);
      if (parsed) results.push(parsed);
      continue;
    }
    if (line.includes("|")) {
      const cols = line.split("|").map((c) => c.trim());
      const parsed = parseColumns(cols, accountNickname, accountType);
      if (parsed) results.push(parsed);
      continue;
    }
    if (/,\s*[^,]+,\s*-?\$?[\d,]+\.\d{2}\s*$/.test(line) || line.split(",").length >= 3) {
      const cols = splitCsv(line);
      const parsed = parseColumns(cols, accountNickname, accountType);
      if (parsed) results.push(parsed);
      continue;
    }

    const { date, rest } = extractDateFromLine(line);
    const amount = extractAmountFromLine(rest || line);
    let description = rest || line;
    if (amount != null) {
      description = description.replace(/-?\$?\s*[\d,]+\.\d{2}\s*$/, "").trim();
    }
    if (date && amount != null && description.length > 1) {
      results.push(makeTx(date, description, amount, accountNickname, accountType));
    }
  }

  return results;
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseColumns(cols, accountNickname, accountType) {
  if (cols.length < 2) return null;
  let date = null;
  let description = "";
  let amount = null;

  for (const col of cols) {
    const dTry = extractDateFromLine(col);
    if (!date && dTry.date) date = dTry.date;
    const amt = parseAmount(col);
    if (amt != null && /[\d.]/.test(col)) {
      if (amount == null || Math.abs(amt) >= Math.abs(amount)) amount = amt;
    }
  }

  const descCol = cols.find((c) => !extractDateFromLine(c).date && parseAmount(c) == null && c.length > 2);
  description = descCol || cols[1] || cols[0];

  if (!date) {
    const first = extractDateFromLine(cols[0]);
    date = first.date;
    if (!description && first.rest) description = first.rest;
  }
  if (amount == null) amount = parseAmount(cols[cols.length - 1]);
  if (!date || amount == null) return null;
  return makeTx(date, description, amount, accountNickname, accountType);
}

function makeTx(date, description, amount, accountNickname, accountType) {
  const type = amount >= 0 ? "credit" : "debit";
  return {
    id: "",
    date: date.toISOString().slice(0, 10),
    description: description.trim(),
    amount,
    account: accountNickname,
    accountType,
    type
  };
}

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "tx-" + Math.random().toString(36).slice(2, 11);
}

export function txFingerprint(tx) {
  const desc = (tx.description || "").toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  return `${tx.date}|${Math.abs(tx.amount).toFixed(2)}|${desc}`;
}

export function dedupeTransactions(existing, incoming) {
  const seen = new Set(existing.map(txFingerprint));
  const added = [];
  let dupes = 0;
  for (const tx of incoming) {
    const fp = txFingerprint(tx);
    if (seen.has(fp)) { dupes++; continue; }
    seen.add(fp);
    added.push({ ...tx, id: uid() });
  }
  return { added, dupes, overlapDetected: dupes > 0 };
}
