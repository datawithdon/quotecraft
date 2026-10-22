// QuoteCraft pricing engine — pure functions, no DOM access.
// Everything here is deterministic and unit-tested (see tests/engine.test.js).

export const MODES = ["AIR", "LCL", "FCL"];
export const CATEGORIES = ["ORIGIN", "FREIGHT", "INSURANCE", "DEST", "IMPORT_CLEARANCE", "DELIVERY", "DUTY"];
export const BASES = ["KG", "WM", "CBM", "CONTAINER", "SHIPMENT", "PCT_FRT"];

export const CATEGORY_LABELS = {
  ORIGIN: "Origin charges",
  FREIGHT: "Main freight",
  INSURANCE: "Cargo insurance",
  DEST: "Destination charges",
  IMPORT_CLEARANCE: "Import clearance",
  DELIVERY: "Delivery",
  DUTY: "Duties & taxes",
};

// Usable capacity is lower than the nominal internal volume: cargo rarely
// stacks perfectly, so ~85% is a common planning figure.
export const CONTAINERS = {
  "20GP": { label: "20' Standard", cbm: 33.2, usableCbm: 28, maxKg: 25000 },
  "40GP": { label: "40' Standard", cbm: 67.7, usableCbm: 58, maxKg: 26500 },
  "40HC": { label: "40' High Cube", cbm: 76.3, usableCbm: 68, maxKg: 26500 },
};

// Incoterms 2020 — which cost categories the SELLER pays. Everything else is
// paid by the buyer. This is a simplified commercial model: individual sales
// contracts and local port practice (e.g. destination THC under CFR/CIF) vary.
export const INCOTERMS = {
  EXW: { name: "Ex Works", seller: [] },
  FCA: { name: "Free Carrier", seller: ["ORIGIN"] },
  FAS: { name: "Free Alongside Ship", seller: ["ORIGIN"] },
  FOB: { name: "Free On Board", seller: ["ORIGIN"] },
  CPT: { name: "Carriage Paid To", seller: ["ORIGIN", "FREIGHT"] },
  CFR: { name: "Cost and Freight", seller: ["ORIGIN", "FREIGHT"] },
  CIP: { name: "Carriage and Insurance Paid To", seller: ["ORIGIN", "FREIGHT", "INSURANCE"] },
  CIF: { name: "Cost, Insurance and Freight", seller: ["ORIGIN", "FREIGHT", "INSURANCE"] },
  DAP: { name: "Delivered At Place", seller: ["ORIGIN", "FREIGHT", "INSURANCE", "DEST", "DELIVERY"] },
  DPU: { name: "Delivered at Place Unloaded", seller: ["ORIGIN", "FREIGHT", "INSURANCE", "DEST", "DELIVERY"] },
  DDP: { name: "Delivered Duty Paid", seller: [...CATEGORIES] },
};
// Sea-only terms; the UI warns when they are used with air freight.
export const SEA_ONLY_INCOTERMS = ["FAS", "FOB", "CFR", "CIF"];

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ceilTo = (n, step) => Math.ceil(n / step - 1e-9) * step;

// ---------------------------------------------------------------- cargo math

export function cargoTotals(pieces) {
  let count = 0, grossKg = 0, cbm = 0;
  for (const p of pieces) {
    const qty = Number(p.qty) || 0;
    count += qty;
    grossKg += qty * (Number(p.weightKg) || 0);
    cbm += (qty * (Number(p.lengthCm) || 0) * (Number(p.widthCm) || 0) * (Number(p.heightCm) || 0)) / 1e6;
  }
  return { count, grossKg: round2(grossKg), cbm: Math.round(cbm * 1000) / 1000 };
}

// IATA: volumetric kg = cm³ / divisor (6000 standard, 5000 for express/courier).
// Chargeable weight is the greater of actual and volumetric, rounded up to 0.5 kg.
export function airChargeableKg(grossKg, cbm, divisor = 6000) {
  const volumetricKg = (cbm * 1e6) / divisor;
  return {
    volumetricKg: round2(volumetricKg),
    chargeableKg: ceilTo(Math.max(grossKg, volumetricKg), 0.5),
  };
}

// LCL "weight or measure": 1 revenue ton = 1 CBM or 1,000 kg, whichever is greater.
export function revenueTons(grossKg, cbm) {
  return ceilTo(Math.max(cbm, grossKg / 1000), 0.01);
}

export function containerFit(type, grossKg, cbm) {
  const spec = CONTAINERS[type];
  if (!spec) return null;
  const count = Math.max(1, Math.ceil(cbm / spec.usableCbm - 1e-9), Math.ceil(grossKg / spec.maxKg - 1e-9));
  return {
    type,
    count,
    volumeUtil: cbm / (spec.usableCbm * count),
    weightUtil: grossKg / (spec.maxKg * count),
  };
}

// ------------------------------------------------------------------ dates

export const isoDate = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}
export function daysBetween(fromIso, toIso) {
  const [a, b] = [fromIso, toIso].map((s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86400000);
}

export function rateStatus(row, today, soonDays = 14) {
  if (row.validFrom && row.validFrom > today) return "FUTURE";
  if (row.validTo && row.validTo < today) return "EXPIRED";
  if (row.validTo && daysBetween(today, row.validTo) <= soonDays) return "EXPIRING";
  return "VALID";
}

// -------------------------------------------------------------------- FX

// fx maps currency code -> units per 1 USD (USD = 1).
export function convert(amount, from, to, fx) {
  if (from === to) return amount;
  const f = fx[from], t = fx[to];
  if (!f || !t) throw new Error(`No FX rate for ${!f ? from : to}`);
  return (amount / f) * t;
}

// ----------------------------------------------------------- rate matching

const matchLoc = (rowVal, want) => rowVal === "*" || rowVal === want;

// Higher = more specific; a carrier/lane-specific row overrides a wildcard row
// with the same charge code.
const specificity = (r) => (r.origin !== "*" ? 4 : 0) + (r.destination !== "*" ? 2 : 0) + (r.carrier !== "*" ? 1 : 0);

function basisQty(basis, m) {
  switch (basis) {
    case "KG": return m.mode === "AIR" ? m.chargeableKg : m.grossKg;
    case "WM": return m.revenueTons;
    case "CBM": return m.cbm;
    case "CONTAINER": return m.containerCount;
    case "SHIPMENT": return 1;
    default: return 0;
  }
}

// Among rows for one charge code, choose the weight break: the highest
// break_min not exceeding the quantity. Below the lowest break, the lowest
// break row applies (its min_charge then usually dominates).
function pickBreak(rows, qty) {
  const sorted = [...rows].sort((a, b) => a.breakMin - b.breakMin);
  let chosen = sorted[0];
  for (const r of sorted) if (r.breakMin <= qty) chosen = r;
  return chosen;
}

/**
 * Build every priced routing option (one per mode/carrier/container type)
 * available for a shipment on a given date.
 *
 * shipment: { origin, destination, pieces, goodsValue, insure, dutyPct, vatPct, valuationBasis }
 * settings: { currency, fx, airDivisor, insurancePct, insuranceMin }
 */
export function buildOptions(rates, shipment, settings, today) {
  const totals = cargoTotals(shipment.pieces);
  const air = airChargeableKg(totals.grossKg, totals.cbm, settings.airDivisor || 6000);
  const rt = revenueTons(totals.grossKg, totals.cbm);

  const lane = rates.filter(
    (r) => matchLoc(r.origin, shipment.origin) && matchLoc(r.destination, shipment.destination) && rateStatus(r, today) !== "EXPIRED" && rateStatus(r, today) !== "FUTURE",
  );

  const seeds = new Map();
  for (const r of lane) {
    if (r.chargeCode !== "FRT" || r.carrier === "*") continue;
    const key = `${r.mode}|${r.carrier}|${r.mode === "FCL" ? r.container : ""}`;
    if (!seeds.has(key)) seeds.set(key, { mode: r.mode, carrier: r.carrier, container: r.mode === "FCL" ? r.container : "" });
  }

  const options = [];
  for (const seed of seeds.values()) {
    if (seed.mode === "FCL" && !CONTAINERS[seed.container]) continue;
    const fit = seed.mode === "FCL" ? containerFit(seed.container, totals.grossKg, totals.cbm) : null;
    const metrics = {
      mode: seed.mode,
      grossKg: totals.grossKg,
      cbm: totals.cbm,
      chargeableKg: air.chargeableKg,
      revenueTons: rt,
      containerCount: fit ? fit.count : 0,
    };

    const applicable = lane.filter(
      (r) =>
        r.mode === seed.mode &&
        (r.carrier === "*" || r.carrier === seed.carrier) &&
        (seed.mode === "FCL" ? !r.container || r.container === seed.container : !r.container),
    );

    // Group by charge code and keep only the most specific rows for each.
    const byCode = new Map();
    for (const r of applicable) {
      const list = byCode.get(r.chargeCode) || [];
      list.push(r);
      byCode.set(r.chargeCode, list);
    }

    const warnings = [];
    const lines = [];
    let transitDays = null;
    let rateExpiry = null;
    const pending = [];
    for (const [code, rows] of byCode) {
      const top = Math.max(...rows.map(specificity));
      const best = rows.filter((r) => specificity(r) === top);
      const qty = basisQty(best[0].basis, metrics);
      const row = pickBreak(best, qty);
      if (code === "FRT" && row.transitDays != null) transitDays = row.transitDays;
      if (row.validTo && (!rateExpiry || row.validTo < rateExpiry)) rateExpiry = row.validTo;
      if (row.basis === "PCT_FRT") { pending.push(row); continue; }
      let amount;
      try {
        amount = convert(Math.max(row.rate * qty, row.minCharge || 0), row.currency, settings.currency, settings.fx);
      } catch (e) {
        warnings.push(`${row.chargeName}: ${e.message}`);
        continue;
      }
      lines.push(makeLine(row, qty, amount, settings.currency, null, (row.minCharge || 0) > row.rate * qty));
    }
    const frt = lines.find((l) => l.code === "FRT");
    if (!frt) continue; // FRT couldn't be priced (e.g. missing FX) — option unusable
    for (const row of pending) {
      const pctAmount = (row.rate / 100) * frt.amount;
      const min = convertSafe(row.minCharge || 0, row.currency, settings);
      lines.push(makeLine(row, row.rate, Math.max(pctAmount, min), settings.currency, "% of freight", min > pctAmount));
    }

    if (shipment.insure) lines.push(insuranceLine(shipment.goodsValue, lines, settings));
    if (fit && fit.weightUtil > 0.95) warnings.push("Near container weight limit — check road weight restrictions.");
    if (rateExpiry && rateStatus({ validTo: rateExpiry }, today) === "EXPIRING") warnings.push(`Rates expire ${rateExpiry}.`);

    options.push({
      id: `${seed.mode}|${seed.carrier}|${seed.container}`,
      mode: seed.mode,
      carrier: seed.carrier,
      container: seed.container,
      fit,
      metrics,
      transitDays,
      rateExpiry,
      warnings,
      lines: sortLines(lines),
    });
  }

  for (const o of options) {
    o.logisticsBuy = round2(o.lines.reduce((s, l) => s + l.amount, 0));
    o.duty = dutyAndTax(shipment, o.lines);
    o.costPerKg = totals.grossKg > 0 ? o.logisticsBuy / totals.grossKg : 0;
  }
  options.sort((a, b) => a.logisticsBuy - b.logisticsBuy);
  return { totals, air, revenueTons: rt, options };
}

function convertSafe(amount, from, settings) {
  try { return convert(amount, from, settings.currency, settings.fx); } catch { return 0; }
}

function makeLine(row, qty, amount, currency, unitLabel, minApplied = false) {
  return {
    id: `${row.category}:${row.chargeCode}`,
    code: row.chargeCode,
    name: row.chargeName,
    category: row.category,
    basis: row.basis,
    qty: round2(qty),
    rate: row.rate,
    rateCurrency: row.currency,
    unitLabel: unitLabel || row.basis,
    container: row.container,
    minApplied,
    amount: round2(amount),
    currency,
  };
}

// Insured value follows the market convention of CIF + 10%.
export function insuranceLine(goodsValue, lines, settings) {
  const cf = lines.filter((l) => l.category === "ORIGIN" || l.category === "FREIGHT").reduce((s, l) => s + l.amount, 0);
  const insured = (Number(goodsValue) + cf) * 1.1;
  const amount = Math.max((insured * (settings.insurancePct || 0)) / 100, settings.insuranceMin || 0);
  return {
    id: "INSURANCE:INS",
    code: "INS",
    name: `Cargo insurance (${settings.insurancePct}% of CIF + 10%)`,
    category: "INSURANCE",
    basis: "PCT",
    qty: round2(insured),
    rate: settings.insurancePct,
    rateCurrency: settings.currency,
    unitLabel: "% insured value",
    minApplied: (insured * (settings.insurancePct || 0)) / 100 < (settings.insuranceMin || 0),
    amount: round2(amount),
    currency: settings.currency,
  };
}

const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));
const sortLines = (lines) => lines.sort((a, b) => CAT_ORDER[a.category] - CAT_ORDER[b.category] || (a.code === "FRT" ? -1 : b.code === "FRT" ? 1 : 0));

// ------------------------------------------------------------ duty & tax

/**
 * Simplified customs valuation.
 *  CIF basis (EU, UK, most of the world): goods + origin + freight + insurance.
 *  FOB basis (US, Canada, Australia):     goods + origin charges.
 * VAT/GST is levied on customs value + duty.
 */
export function dutyAndTax(shipment, lines) {
  const sum = (cats) => lines.filter((l) => cats.includes(l.category)).reduce((s, l) => s + l.amount, 0);
  const goods = Number(shipment.goodsValue) || 0;
  const customsValue = round2(goods + (shipment.valuationBasis === "FOB" ? sum(["ORIGIN"]) : sum(["ORIGIN", "FREIGHT", "INSURANCE"])));
  const duty = round2((customsValue * (Number(shipment.dutyPct) || 0)) / 100);
  const vat = round2(((customsValue + duty) * (Number(shipment.vatPct) || 0)) / 100);
  return { customsValue, duty, vat };
}

export function dutyLines(duty, currency) {
  const out = [];
  if (duty.duty > 0) out.push({ id: "DUTY:DUTY", code: "DUTY", name: "Import duty (estimate)", category: "DUTY", basis: "PCT", qty: duty.customsValue, rate: null, unitLabel: "customs value", amount: duty.duty, currency, passThrough: true });
  if (duty.vat > 0) out.push({ id: "DUTY:VAT", code: "VAT", name: "Import VAT / GST (estimate)", category: "DUTY", basis: "PCT", qty: round2(duty.customsValue + duty.duty), rate: null, unitLabel: "value + duty", amount: duty.vat, currency, passThrough: true });
  return out;
}

// --------------------------------------------------------- incoterms & sell

export function payerFor(category, incoterm) {
  const term = INCOTERMS[incoterm];
  if (!term) throw new Error(`Unknown Incoterm ${incoterm}`);
  return term.seller.includes(category) ? "SELLER" : "BUYER";
}

/**
 * Apply markup and Incoterm split. Duties/taxes are pass-through (no markup).
 * overrides: { [lineId]: sellAmount } — manual sell prices from the UI.
 */
export function priceLines(lines, { markupPct = 0, incoterm = "FOB", overrides = {} } = {}) {
  const priced = lines.map((l) => {
    const auto = l.passThrough ? l.amount : round2(l.amount * (1 + markupPct / 100));
    const sell = Object.hasOwn(overrides, l.id) && Number.isFinite(overrides[l.id]) ? round2(overrides[l.id]) : auto;
    return { ...l, sell, profit: round2(sell - l.amount), payer: payerFor(l.category, incoterm) };
  });
  return { lines: priced, ...summarize(priced) };
}

export function summarize(lines) {
  const buy = round2(lines.reduce((s, l) => s + l.amount, 0));
  const sell = round2(lines.reduce((s, l) => s + l.sell, 0));
  const profit = round2(sell - buy);
  const bySide = (side) => round2(lines.filter((l) => l.payer === side).reduce((s, l) => s + l.sell, 0));
  return { buy, sell, profit, marginPct: sell > 0 ? round2((profit / sell) * 100) : 0, sellerTotal: bySide("SELLER"), buyerTotal: bySide("BUYER") };
}

// Total cost for the importer to get the goods to their door.
export function landedCost(goodsValue, pricedLines, units) {
  const logistics = round2(pricedLines.filter((l) => l.category !== "DUTY").reduce((s, l) => s + l.sell, 0));
  const duty = round2(pricedLines.filter((l) => l.code === "DUTY").reduce((s, l) => s + l.sell, 0));
  const vat = round2(pricedLines.filter((l) => l.code === "VAT").reduce((s, l) => s + l.sell, 0));
  const goods = Number(goodsValue) || 0;
  const total = round2(goods + logistics + duty + vat);
  const exVat = round2(total - vat);
  const n = Number(units) || 0;
  return {
    goods, logistics, duty, vat, total, exVat,
    perUnit: n > 0 ? round2(total / n) : null,
    perUnitExVat: n > 0 ? round2(exVat / n) : null,
    logisticsPctOfGoods: goods > 0 ? round2((logistics / goods) * 100) : null,
  };
}

// --------------------------------------------------------------- history

export function effectiveStatus(q, today) {
  return q.status === "QUOTED" && q.validUntil && q.validUntil < today ? "EXPIRED" : q.status;
}

export function historyStats(quotes, today) {
  const blank = () => ({ quoted: 0, won: 0, lost: 0, open: 0, expired: 0, wonSell: 0, wonProfit: 0 });
  const add = (acc, q) => {
    const s = effectiveStatus(q, today);
    acc.quoted++;
    if (s === "WON") { acc.won++; acc.wonSell += q.totals.sell; acc.wonProfit += q.totals.profit; }
    else if (s === "LOST") acc.lost++;
    else if (s === "EXPIRED") acc.expired++;
    else acc.open++;
  };
  const finish = (acc) => ({ ...acc, wonSell: round2(acc.wonSell), wonProfit: round2(acc.wonProfit), winRate: acc.won + acc.lost > 0 ? acc.won / (acc.won + acc.lost) : null });

  const overall = blank();
  const lanes = new Map();
  const modes = new Map();
  for (const q of quotes) {
    add(overall, q);
    const lk = `${q.shipment.origin} → ${q.shipment.destination}`;
    if (!lanes.has(lk)) lanes.set(lk, blank());
    add(lanes.get(lk), q);
    if (!modes.has(q.option.mode)) modes.set(q.option.mode, blank());
    add(modes.get(q.option.mode), q);
  }
  const toRows = (m) => [...m].map(([key, v]) => ({ key, ...finish(v) })).sort((a, b) => b.quoted - a.quoted);
  return { overall: finish(overall), byLane: toRows(lanes), byMode: toRows(modes) };
}

export function nextQuoteNumber(today, existing) {
  const prefix = `QC-${today.replaceAll("-", "").slice(2)}-`;
  const used = existing.filter((n) => n.startsWith(prefix)).map((n) => parseInt(n.slice(prefix.length), 10) || 0);
  return prefix + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, "0");
}
