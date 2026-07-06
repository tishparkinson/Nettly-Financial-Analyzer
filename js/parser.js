const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function parseMonthNameMatch(m) {
  const monthIdx = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
  if (monthIdx == null) return new Date(NaN);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  return new Date(year, monthIdx, parseInt(m[2], 10));
}

const DATE_PATTERNS = [
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, parse: (m) => parseMDY(m[1], m[2], m[3]) },
  { re: /^(\d{4})-(\d{2})-(\d{2})\b/, parse: (m) => new Date(+m[1], +m[2] - 1, +m[3]) },
  { re: /^(\d{1,2})-(\d{1,2})-(\d{2,4})\b/, parse: (m) => parseMDY(m[1], m[2], m[3]) },
  { re: /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/, parse: parseMonthNameMatch }
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

// Matches a standalone line like "Jul 3", "Jun 30", "Sep 5, 2025", "Dec 31, 2025"
const MONTH_NAME_LINE_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/;
// Matches a standalone amount/balance line like "$100.00", "+$0.05", "-$63.05"
const AMOUNT_LINE_RE = /^([+-]?)\$?([\d,]+\.\d{2})$/;
// Common status markers that sometimes appear as their own line between a description and its date
const STATUS_LINE_RE = /^(pending|posted|completed|cleared)$/i;

/**
 * Handles "app/online statement" export styles where a transaction is spread
 * across several lines instead of one. Covers, in order of how much shares a
 * line with the date:
 *   A) Description / [status] / Mon D[, YYYY] / Amount / [Balance]   (3-5 lines)
 *   B) Description / [status] / "Mon D Amount" combined / [Balance]  (2-3 lines)
 *   C) "Mon D Description" combined / Amount / [Balance]             (2-3 lines)
 * Returns parsed transactions plus which line indices it consumed, so the
 * remaining lines can still fall through to the other parsing strategies.
 */
function parseStatementBlocks(lines, accountNickname, accountType) {
  const consumed = new Array(lines.length).fill(false);
  const results = [];

  const pushResult = (date, description, amtMatch) => {
    if (!description || isHeaderLine(description)) return false;
    const amountAbs = parseFloat(amtMatch[2].replace(/,/g, ""));
    if (!Number.isFinite(amountAbs)) return false;
    if (amountAbs !== 0) {
      const signedAmount = amtMatch[1] === "+" ? amountAbs : -amountAbs;
      results.push(makeTx(date, description, signedAmount, accountNickname, accountType));
    }
    return true; // still "handled" even if $0.00 (e.g. rate-change noise) so it gets consumed
  };

  for (let i = 0; i < lines.length; i++) {
    if (consumed[i]) continue;
    const line = lines[i].trim();
    const dateMatch = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/.exec(line);
    if (!dateMatch) continue;
    const date = parseMonthNameMatch(dateMatch);
    if (Number.isNaN(date.getTime())) continue;
    const rest = line.slice(dateMatch[0].length).trim();

    // Case A: whole line was just the date -> description is the previous line, amount is the next
    if (!rest) {
      const amtMatch = lines[i + 1] ? AMOUNT_LINE_RE.exec(lines[i + 1].trim()) : null;
      if (!amtMatch) continue;

      let descIdx = i - 1;
      if (descIdx >= 0 && STATUS_LINE_RE.test(lines[descIdx].trim())) {
        consumed[descIdx] = true;
        descIdx -= 1;
      }
      if (descIdx < 0 || consumed[descIdx]) continue;
      const description = lines[descIdx].trim();

      if (!pushResult(date, description, amtMatch)) continue;
      consumed[descIdx] = true;
      consumed[i] = true;
      consumed[i + 1] = true;
      if (lines[i + 2] && AMOUNT_LINE_RE.test(lines[i + 2].trim())) consumed[i + 2] = true;
      continue;
    }

    // Case B: date + amount combined on one line ("Jul 3 $4.50") -> description is the previous line
    const restAmtMatch = AMOUNT_LINE_RE.exec(rest);
    if (restAmtMatch) {
      let descIdx = i - 1;
      if (descIdx >= 0 && STATUS_LINE_RE.test(lines[descIdx].trim())) {
        consumed[descIdx] = true;
        descIdx -= 1;
      }
      if (descIdx < 0 || consumed[descIdx]) continue;
      const description = lines[descIdx].trim();

      if (!pushResult(date, description, restAmtMatch)) continue;
      consumed[descIdx] = true;
      consumed[i] = true;
      if (lines[i + 1] && AMOUNT_LINE_RE.test(lines[i + 1].trim())) consumed[i + 1] = true;
      continue;
    }

    // Case C: date + description combined on one line ("Jul 3 STARBUCKS") -> amount is the next line
    if (!/\$/.test(rest) && lines[i + 1] && AMOUNT_LINE_RE.test(lines[i + 1].trim())) {
      const amtMatch = AMOUNT_LINE_RE.exec(lines[i + 1].trim());
      if (!pushResult(date, rest, amtMatch)) continue;
      consumed[i] = true;
      consumed[i + 1] = true;
      if (lines[i + 2] && AMOUNT_LINE_RE.test(lines[i + 2].trim())) consumed[i + 2] = true;
      continue;
    }
  }

  return { results, consumed };
}

/**
 * Parse pasted bank/credit card text into transactions.
 */
export function parseTransactions(text, accountNickname, accountType) {
  const allLines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isHeaderLine(l));

  const { results: blockResults, consumed } = parseStatementBlocks(allLines, accountNickname, accountType);
  const lines = allLines.filter((_, idx) => !consumed[idx]);

  const results = [...blockResults];

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
