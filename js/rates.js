// Rate-sheet parsing and validation. Pure functions — no DOM access.
import { MODES, CATEGORIES, BASES, CONTAINERS } from "./engine.js";

export const RATE_COLUMNS = [
  "origin", "destination", "mode", "carrier", "charge_code", "charge_name", "category",
  "basis", "container", "break_min", "rate", "min_charge", "currency", "transit_days", "valid_from", "valid_to",
];

// RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, embedded newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Turn a 2-D array (header row first) into validated rate rows.
export function normalizeRates(table) {
  const errors = [];
  if (!table.length) return { rows: [], errors: ["The file is empty."] };
  const header = table[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, "_"));
  const missing = RATE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(", ")}`] };
  const idx = Object.fromEntries(RATE_COLUMNS.map((c) => [c, header.indexOf(c)]));

  const rows = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (c) => String(cells[idx[c]] ?? "").trim();
    const num = (c, fallback = null) => {
      const v = get(c);
      if (v === "") return fallback;
      const n = Number(v.replace(/,/g, ""));
      return Number.isFinite(n) ? n : NaN;
    };
    const r = {
      origin: get("origin").toUpperCase(),
      destination: get("destination").toUpperCase(),
      mode: get("mode").toUpperCase(),
      carrier: get("carrier"),
      chargeCode: get("charge_code").toUpperCase(),
      chargeName: get("charge_name") || get("charge_code").toUpperCase(),
      category: get("category").toUpperCase(),
      basis: get("basis").toUpperCase(),
      container: get("container").toUpperCase(),
      breakMin: num("break_min", 0),
      rate: num("rate"),
      minCharge: num("min_charge", 0),
      currency: (get("currency") || "USD").toUpperCase(),
      transitDays: num("transit_days", null),
      validFrom: get("valid_from"),
      validTo: get("valid_to"),
    };
    const problems = [];
    if (!r.origin) problems.push("origin is required (use * for any)");
    if (!r.destination) problems.push("destination is required (use * for any)");
    if (!MODES.includes(r.mode)) problems.push(`mode must be one of ${MODES.join("/")}`);
    if (!r.carrier) problems.push("carrier is required (use * for any)");
    if (!r.chargeCode) problems.push("charge_code is required");
    if (!CATEGORIES.includes(r.category) || r.category === "INSURANCE" || r.category === "DUTY") problems.push("category must be ORIGIN/FREIGHT/DEST/IMPORT_CLEARANCE/DELIVERY");
    if (!BASES.includes(r.basis)) problems.push(`basis must be one of ${BASES.join("/")}`);
    if (r.container && !CONTAINERS[r.container]) problems.push(`container must be blank or ${Object.keys(CONTAINERS).join("/")}`);
    if (r.mode !== "FCL" && r.container) problems.push("container only applies to FCL rows");
    if (r.basis === "CONTAINER" && r.mode !== "FCL") problems.push("basis CONTAINER only applies to FCL");
    if (r.chargeCode === "FRT" && r.mode === "FCL" && !r.container) problems.push("FCL FRT rows need a container type");
    if (r.chargeCode === "FRT" && r.carrier === "*") problems.push("FRT rows need a specific carrier");
    if (r.chargeCode === "FRT" && r.category !== "FREIGHT") problems.push("FRT rows must be category FREIGHT");
    if (!Number.isFinite(r.rate) || r.rate < 0) problems.push("rate must be a non-negative number");
    if (!Number.isFinite(r.breakMin)) problems.push("break_min must be a number");
    if (!Number.isFinite(r.minCharge)) problems.push("min_charge must be a number");
    if (r.transitDays !== null && !Number.isFinite(r.transitDays)) problems.push("transit_days must be a number");
    if (!/^[A-Z]{3}$/.test(r.currency)) problems.push("currency must be a 3-letter code");
    if (r.validFrom && !DATE_RE.test(r.validFrom)) problems.push("valid_from must be YYYY-MM-DD");
    if (r.validTo && !DATE_RE.test(r.validTo)) problems.push("valid_to must be YYYY-MM-DD");
    if (problems.length) errors.push(`Row ${line}: ${problems.join("; ")}`);
    else rows.push(r);
  });
  return { rows, errors };
}

export function ratesToCsv(rows) {
  const out = [RATE_COLUMNS.join(",")];
  for (const r of rows) {
    out.push([
      r.origin, r.destination, r.mode, r.carrier, r.chargeCode, r.chargeName, r.category, r.basis,
      r.container, r.breakMin || "", r.rate, r.minCharge || "", r.currency, r.transitDays ?? "", r.validFrom, r.validTo,
    ].map(csvCell).join(","));
  }
  return out.join("\n") + "\n";
}

// Quote fields that need it, and neutralise spreadsheet formula injection.
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "EUR=0.92, GBP=0.79" -> { USD: 1, EUR: 0.92, GBP: 0.79 }
export function parseFx(text) {
  const fx = { USD: 1 };
  const errors = [];
  for (const part of String(text).split(/[,\n;]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([A-Za-z]{3})\s*[=:]\s*([\d.]+)$/);
    if (!m || !(Number(m[2]) > 0)) { errors.push(`Couldn't read "${p}"`); continue; }
    fx[m[1].toUpperCase()] = Number(m[2]);
  }
  return { fx, errors };
}
