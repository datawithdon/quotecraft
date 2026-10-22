import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cargoTotals, airChargeableKg, revenueTons, containerFit, payerFor, priceLines, buildOptions,
  dutyAndTax, dutyLines, landedCost, historyStats, nextQuoteNumber, rateStatus, convert, addDays, effectiveStatus,
} from "../js/engine.js";
import { parseCsv, normalizeRates, ratesToCsv, csvCell, parseFx } from "../js/rates.js";

const SETTINGS = { currency: "USD", fx: { USD: 1, EUR: 0.86 }, airDivisor: 6000, insurancePct: 0.35, insuranceMin: 35 };
const TODAY = "2026-10-22";
const sample = normalizeRates(parseCsv(readFileSync(new URL("../data/sample-rates.csv", import.meta.url), "utf8")));

const shipment = (over = {}) => ({
  origin: "CNSHA", destination: "DEHAM", goodsValue: 20000, insure: false, dutyPct: 0, vatPct: 0, valuationBasis: "CIF",
  pieces: [{ qty: 5, lengthCm: 120, widthCm: 100, heightCm: 150, weightKg: 240 }],
  ...over,
});

test("cargo totals", () => {
  assert.deepEqual(cargoTotals([{ qty: 5, lengthCm: 120, widthCm: 100, heightCm: 150, weightKg: 240 }]), { count: 5, grossKg: 1200, cbm: 9 });
  assert.deepEqual(cargoTotals([]), { count: 0, grossKg: 0, cbm: 0 });
});

test("air chargeable weight uses greater of actual/volumetric, rounded up to 0.5", () => {
  assert.equal(airChargeableKg(1200, 9).chargeableKg, 1500); // 9 cbm / 6000 = 1500 kg volumetric
  assert.equal(airChargeableKg(2000, 9).chargeableKg, 2000);
  assert.equal(airChargeableKg(10.1, 0.01).chargeableKg, 10.5);
  assert.equal(airChargeableKg(0, 0.06, 5000).chargeableKg, 12);
});

test("LCL revenue tons", () => {
  assert.equal(revenueTons(1200, 9), 9);
  assert.equal(revenueTons(3500, 2), 3.5);
  assert.equal(revenueTons(100, 0.5), 0.5);
});

test("container fit by volume and weight", () => {
  assert.equal(containerFit("20GP", 5000, 27).count, 1);
  assert.equal(containerFit("20GP", 5000, 29).count, 2);
  assert.equal(containerFit("20GP", 30000, 10).count, 2);
  assert.equal(containerFit("40HC", 0, 0).count, 1);
});

test("incoterm payer split", () => {
  assert.equal(payerFor("ORIGIN", "EXW"), "BUYER");
  assert.equal(payerFor("ORIGIN", "FOB"), "SELLER");
  assert.equal(payerFor("FREIGHT", "FOB"), "BUYER");
  assert.equal(payerFor("FREIGHT", "CFR"), "SELLER");
  assert.equal(payerFor("INSURANCE", "CIF"), "SELLER");
  assert.equal(payerFor("DELIVERY", "DAP"), "SELLER");
  assert.equal(payerFor("IMPORT_CLEARANCE", "DAP"), "BUYER");
  assert.equal(payerFor("DUTY", "DDP"), "SELLER");
  assert.throws(() => payerFor("ORIGIN", "XYZ"));
});

test("sample rate sheet parses cleanly", () => {
  assert.deepEqual(sample.errors, []);
  assert.ok(sample.rows.length > 100);
});

test("buildOptions yields air, LCL and FCL options with correct breaks", () => {
  const { options, air } = buildOptions(sample.rows, shipment(), SETTINGS, TODAY);
  assert.equal(air.chargeableKg, 1500);
  const modes = new Set(options.map((o) => o.mode));
  assert.deepEqual([...modes].sort(), ["AIR", "FCL", "LCL"]);

  const airAlpha = options.find((o) => o.mode === "AIR" && o.carrier === "AIR-ALPHA");
  const frt = airAlpha.lines.find((l) => l.code === "FRT");
  assert.equal(frt.rate, 4.3); // +1000 kg break
  assert.equal(frt.amount, 6450);
  assert.equal(airAlpha.transitDays, 2);

  const lclAlpha = options.find((o) => o.mode === "LCL" && o.carrier === "CONSOL-ALPHA");
  assert.equal(lclAlpha.lines.find((l) => l.code === "FRT").amount, 9 * 48);
  // EUR destination charge converted at 0.86 EUR/USD: 9 WM * 29 EUR = 261 EUR
  assert.equal(lclAlpha.lines.find((l) => l.code === "DCFS").amount, 303.49);

  const fcl20 = options.find((o) => o.mode === "FCL" && o.carrier === "SEA-ALPHA" && o.container === "20GP");
  assert.equal(fcl20.fit.count, 1);
  assert.equal(fcl20.lines.find((l) => l.code === "BAF").amount, 310);
  assert.ok(fcl20.lines.find((l) => l.code === "ISPS"), "wildcard row applies");

  const bravo = options.find((o) => o.mode === "FCL" && o.carrier === "SEA-BRAVO" && o.container === "20GP");
  assert.equal(bravo.lines.find((l) => l.code === "CAF").amount, 45.6); // 3% of 1520

  // sorted by cost ascending
  for (let i = 1; i < options.length; i++) assert.ok(options[i - 1].logisticsBuy <= options[i].logisticsBuy);
});

test("minimum charge applies on small air shipments", () => {
  const { options } = buildOptions(sample.rows, shipment({ pieces: [{ qty: 1, lengthCm: 30, widthCm: 30, heightCm: 30, weightKg: 10 }] }), SETTINGS, TODAY);
  const frt = options.find((o) => o.carrier === "AIR-ALPHA").lines.find((l) => l.code === "FRT");
  assert.equal(frt.amount, 150);
});

test("specific rows override wildcard rows of the same code", () => {
  const rows = normalizeRates(parseCsv(
    "origin,destination,mode,carrier,charge_code,charge_name,category,basis,container,break_min,rate,min_charge,currency,transit_days,valid_from,valid_to\n" +
    "A,B,LCL,X,FRT,Freight,FREIGHT,WM,,,10,,USD,5,,\n" +
    "*,*,LCL,*,DOC,Doc,ORIGIN,SHIPMENT,,,50,,USD,,,\n" +
    "A,*,LCL,*,DOC,Doc,ORIGIN,SHIPMENT,,,30,,USD,,,\n",
  )).rows;
  const { options } = buildOptions(rows, shipment({ origin: "A", destination: "B" }), SETTINGS, TODAY);
  assert.equal(options[0].lines.find((l) => l.code === "DOC").amount, 30);
});

test("expired and future rates are excluded", () => {
  const rows = normalizeRates(parseCsv(
    "origin,destination,mode,carrier,charge_code,charge_name,category,basis,container,break_min,rate,min_charge,currency,transit_days,valid_from,valid_to\n" +
    "A,B,LCL,OLD,FRT,Freight,FREIGHT,WM,,,10,,USD,5,2026-01-01,2026-06-30\n" +
    "A,B,LCL,NEW,FRT,Freight,FREIGHT,WM,,,10,,USD,5,2027-01-01,\n" +
    "A,B,LCL,NOW,FRT,Freight,FREIGHT,WM,,,10,,USD,5,2026-10-01,2026-10-30\n",
  )).rows;
  const { options } = buildOptions(rows, shipment({ origin: "A", destination: "B" }), SETTINGS, TODAY);
  assert.deepEqual(options.map((o) => o.carrier), ["NOW"]);
  assert.ok(options[0].warnings.some((w) => w.includes("expire")));
  assert.equal(rateStatus({ validTo: "2026-10-21" }, TODAY), "EXPIRED");
  assert.equal(rateStatus({ validTo: "2026-12-31" }, TODAY), "VALID");
});

test("insurance uses CIF + 10% with minimum", () => {
  const { options } = buildOptions(sample.rows, shipment({ insure: true }), SETTINGS, TODAY);
  const o = options.find((x) => x.carrier === "CONSOL-ALPHA");
  const ins = o.lines.find((l) => l.code === "INS");
  const cf = o.lines.filter((l) => ["ORIGIN", "FREIGHT"].includes(l.category)).reduce((s, l) => s + l.amount, 0);
  assert.equal(ins.amount, Math.round((20000 + cf) * 1.1 * 0.35) / 100);
});

test("duty & VAT on CIF vs FOB basis", () => {
  const lines = [
    { category: "ORIGIN", amount: 100 }, { category: "FREIGHT", amount: 1000 },
    { category: "INSURANCE", amount: 50 }, { category: "DEST", amount: 300 },
  ];
  const cif = dutyAndTax({ goodsValue: 10000, dutyPct: 5, vatPct: 20, valuationBasis: "CIF" }, lines);
  assert.deepEqual(cif, { customsValue: 11150, duty: 557.5, vat: 2341.5 });
  const fob = dutyAndTax({ goodsValue: 10000, dutyPct: 5, vatPct: 0, valuationBasis: "FOB" }, lines);
  assert.deepEqual(fob, { customsValue: 10100, duty: 505, vat: 0 });
  assert.equal(dutyLines(fob, "USD").length, 1);
});

test("pricing: markup, pass-through duty, overrides, incoterm totals", () => {
  const lines = [
    { id: "ORIGIN:X", category: "ORIGIN", amount: 100 },
    { id: "FREIGHT:FRT", category: "FREIGHT", amount: 1000 },
    { id: "DUTY:DUTY", category: "DUTY", amount: 200, passThrough: true },
  ];
  const p = priceLines(lines, { markupPct: 10, incoterm: "FOB", overrides: { "ORIGIN:X": 150 } });
  assert.deepEqual(p.lines.map((l) => l.sell), [150, 1100, 200]);
  assert.equal(p.buy, 1300);
  assert.equal(p.sell, 1450);
  assert.equal(p.profit, 150);
  assert.equal(p.sellerTotal, 150);
  assert.equal(p.buyerTotal, 1300);
});

test("landed cost", () => {
  const lc = landedCost(10000, [
    { category: "FREIGHT", code: "FRT", sell: 1000 },
    { category: "DUTY", code: "DUTY", sell: 500 },
    { category: "DUTY", code: "VAT", sell: 2300 },
  ], 100);
  assert.deepEqual(lc, { goods: 10000, logistics: 1000, duty: 500, vat: 2300, total: 13800, exVat: 11500, perUnit: 138, perUnitExVat: 115, logisticsPctOfGoods: 10 });
});

test("history stats and quote numbers", () => {
  const q = (status, lane, mode, sell, profit, validUntil = "2026-12-31") => ({
    status, validUntil, shipment: { origin: lane[0], destination: lane[1] }, option: { mode }, totals: { sell, profit },
  });
  const quotes = [
    q("WON", ["A", "B"], "AIR", 1000, 100),
    q("LOST", ["A", "B"], "AIR", 900, 90),
    q("WON", ["C", "D"], "FCL", 3000, 400),
    q("QUOTED", ["C", "D"], "FCL", 3000, 400),
    q("QUOTED", ["C", "D"], "FCL", 3000, 400, "2026-10-01"),
  ];
  const s = historyStats(quotes, TODAY);
  assert.equal(s.overall.quoted, 5);
  assert.equal(s.overall.won, 2);
  assert.equal(s.overall.expired, 1);
  assert.equal(s.overall.open, 1);
  assert.equal(s.overall.winRate, 2 / 3);
  assert.equal(s.overall.wonProfit, 500);
  assert.equal(s.byLane.find((r) => r.key === "A → B").winRate, 0.5);
  assert.equal(effectiveStatus(quotes[4], TODAY), "EXPIRED");
  assert.equal(nextQuoteNumber(TODAY, []), "QC-261022-001");
  assert.equal(nextQuoteNumber(TODAY, ["QC-261022-001", "QC-261022-007", "QC-261021-099"]), "QC-261022-008");
});

test("CSV parsing edge cases", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""q"""\r\n1,2,3\n\n'), [["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv('x,"multi\nline"'), [["x", "multi\nline"]]);
});

test("rate validation reports bad rows", () => {
  const { rows, errors } = normalizeRates(parseCsv(
    "origin,destination,mode,carrier,charge_code,charge_name,category,basis,container,break_min,rate,min_charge,currency,transit_days,valid_from,valid_to\n" +
    "A,B,SHIP,X,FRT,Freight,FREIGHT,WM,,,abc,,USD,5,,\n" +
    "A,B,FCL,X,FRT,Freight,FREIGHT,CONTAINER,,,10,,USD,5,,\n",
  ));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /mode/);
  assert.match(errors[0], /rate/);
  assert.match(errors[1], /container type/);
  assert.match(normalizeRates(parseCsv("origin,destination\nA,B")).errors[0], /Missing column/);
});

test("rates round-trip through CSV", () => {
  const again = normalizeRates(parseCsv(ratesToCsv(sample.rows)));
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.rows, sample.rows);
});

test("CSV cell escaping neutralises formulas", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-12.5"), "-12.5");
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
});

test("FX parsing and conversion", () => {
  const { fx, errors } = parseFx("EUR=0.86, gbp: 0.75\nbad");
  assert.deepEqual(fx, { USD: 1, EUR: 0.86, GBP: 0.75 });
  assert.equal(errors.length, 1);
  assert.equal(Math.round(convert(86, "EUR", "USD", fx) * 100) / 100, 100);
  assert.throws(() => convert(1, "JPY", "USD", fx));
  assert.equal(addDays("2026-12-25", 14), "2027-01-08");
});
