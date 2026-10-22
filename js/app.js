import {
  INCOTERMS, SEA_ONLY_INCOTERMS, CATEGORIES, CATEGORY_LABELS, CONTAINERS, buildOptions, cargoTotals, airChargeableKg,
  revenueTons, dutyLines, priceLines, summarize, landedCost, historyStats, effectiveStatus, nextQuoteNumber, rateStatus,
  isoDate, addDays, round2,
} from "./engine.js";
import { parseCsv, normalizeRates, ratesToCsv, csvCell, parseFx, RATE_COLUMNS } from "./rates.js";
import { $, $$, h, mount, money, num, pct, toast, download, debounce } from "./dom.js";
import * as store from "./store.js";
import { searchHs } from "./hs.js";

// ------------------------------------------------------------------ state

const LOCATION_NAMES = {
  CNSHA: "Shanghai, CN",
  DEHAM: "Hamburg, DE",
  USLAX: "Los Angeles, US",
  VNSGN: "Ho Chi Minh City, VN",
};

const DEFAULT_SETTINGS = {
  company: "Your Forwarding Co.",
  address: "123 Example Street\nPort City, Country",
  phone: "+00 000 000 000",
  email: "quotes@example.com",
  website: "",
  logo: null,
  currency: "USD",
  fxText: "EUR=0.86\nGBP=0.75\nCNY=7.10\nVND=26000",
  markupPct: 12,
  insurancePct: 0.35,
  insuranceMin: 35,
  validityDays: 14,
  airDivisor: 6000,
  terms:
    "Rates are subject to space and equipment availability at the time of booking.\n" +
    "Duties and taxes are estimates only and are invoiced at cost as assessed by customs.\n" +
    "Excludes inspection, storage, demurrage, detention and any charges not listed above.\n" +
    "All business is undertaken subject to our standard trading conditions.",
};

const blankPiece = () => ({ qty: 1, lengthCm: "", widthCm: "", heightCm: "", weightKg: "" });

function blankDraft(settings) {
  return {
    quoteNo: null, customer: "", role: "CONSIGNEE", incoterm: "FOB", origin: "", destination: "",
    goodsValue: "", units: "", commodity: "", pieces: [blankPiece()], hsCode: "", hsDesc: "",
    dutyPct: "", vatPct: "", valuationBasis: "CIF", insure: false, selectedId: null,
    markupPct: settings.markupPct, overrides: {}, show: "CUSTOMER", notes: "",
  };
}

function exampleDraft(settings) {
  return {
    ...blankDraft(settings),
    customer: "Example Imports Ltd", origin: "CNSHA", destination: "DEHAM", goodsValue: 20000, units: 4000,
    commodity: "Cotton T-shirts, knitted", pieces: [{ qty: 5, lengthCm: 120, widthCm: 100, heightCm: 150, weightKg: 240 }],
    hsCode: "6109.10", hsDesc: "T-shirts, singlets and other vests; of cotton, knitted or crocheted",
    dutyPct: 12, vatPct: 19, insure: true,
  };
}

const state = {
  settings: { ...DEFAULT_SETTINGS, ...store.load(store.KEYS.settings, {}) },
  rates: { rows: [], source: "sample", fileName: null, loadedAt: null, errors: [] },
  quotes: store.load(store.KEYS.quotes, []),
  draft: null,
  result: null,
};
state.draft = { ...blankDraft(state.settings), ...store.load(store.KEYS.draft, exampleDraft(state.settings)) };

const today = () => isoDate(new Date());
const cur = () => state.settings.currency;
const engineSettings = () => ({
  currency: state.settings.currency,
  fx: parseFx(state.settings.fxText).fx,
  airDivisor: Number(state.settings.airDivisor) || 6000,
  insurancePct: Number(state.settings.insurancePct) || 0,
  insuranceMin: Number(state.settings.insuranceMin) || 0,
});
const saveDraft = debounce(() => store.save(store.KEYS.draft, state.draft), 300);

// ------------------------------------------------------------------ rates

async function loadSampleRates() {
  const res = await fetch("data/sample-rates.csv");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { rows, errors } = normalizeRates(parseCsv(await res.text()));
  state.rates = { rows, source: "sample", fileName: "sample-rates.csv", loadedAt: null, errors };
}

async function initRates() {
  const saved = store.load(store.KEYS.rates, null);
  if (saved && Array.isArray(saved.rows) && saved.rows.length) {
    state.rates = saved;
    return;
  }
  try {
    await loadSampleRates();
  } catch (e) {
    state.rates.errors = [`Couldn't load the sample rate sheet (${e.message}). Serve this folder over HTTP — see README.`];
  }
}

let xlsxLoading = null;
function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((resolve, reject) => {
    const s = h("script", { src: "vendor/xlsx.mini.min.js" });
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error("Couldn't load the Excel reader")); };
    document.head.append(s);
  });
  return xlsxLoading;
}

async function readRateFile(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    const XLSX = await loadXlsxLib();
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const table = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    return table.map((row) => row.map((c) => (c instanceof Date ? isoDate(c) : String(c))));
  }
  return parseCsv(await file.text());
}

async function onRatesUpload(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast("File is larger than 5 MB.");
  try {
    const { rows, errors } = normalizeRates(await readRateFile(file));
    if (!rows.length) {
      state.rates.errors = errors.length ? errors : ["No usable rows found."];
      renderRates();
      return toast("No rates loaded — see the errors below.");
    }
    state.rates = { rows, source: "upload", fileName: file.name, loadedAt: new Date().toISOString(), errors: errors.slice(0, 200) };
    if (!store.save(store.KEYS.rates, state.rates)) toast("Loaded, but the browser couldn't save it — it will reset on reload.");
    else toast(`Loaded ${rows.length} rate rows${errors.length ? ` (${errors.length} skipped)` : ""}.`);
    refreshLocations();
    recompute();
    renderRates();
  } catch (err) {
    toast(`Couldn't read file: ${err.message}`);
  }
}

// ------------------------------------------------------------------ views

function showView(name) {
  for (const t of $$(".tab")) t.setAttribute("aria-selected", String(t.dataset.view === name));
  for (const v of $$(".view")) v.classList.toggle("hidden", v.id !== `view-${name}`);
  if (name === "history") renderHistory();
  if (name === "rates") renderRates();
  if (name === "settings") fillSettings();
  if (location.hash !== `#${name}`) history.replaceState(null, "", name === "quote" ? location.pathname : `#${name}`);
}

// ------------------------------------------------------- quote: form

const FIELD_MAP = {
  "f-customer": "customer", "f-role": "role", "f-incoterm": "incoterm", "f-origin": "origin", "f-destination": "destination",
  "f-value": "goodsValue", "f-units": "units", "f-commodity": "commodity", "f-hs": "hsCode", "f-duty": "dutyPct",
  "f-vat": "vatPct", "f-valuation": "valuationBasis", "f-markup": "markupPct", "f-show": "show",
};

function fillForm() {
  const d = state.draft;
  for (const [id, key] of Object.entries(FIELD_MAP)) $(`#${id}`).value = d[key] ?? "";
  $("#f-insure").checked = Boolean(d.insure);
  $("#hs-desc").textContent = d.hsDesc ? `${d.hsCode} — ${d.hsDesc}` : "";
  for (const el of $$(".cur")) el.textContent = cur();
  const badge = $("#editing-badge");
  badge.textContent = d.quoteNo ? `Editing ${d.quoteNo}` : "";
  badge.classList.toggle("hidden", !d.quoteNo);
  renderPieces();
}

function onFieldInput(e) {
  const key = FIELD_MAP[e.target.id];
  if (!key) return;
  let v = e.target.value;
  if (key === "origin" || key === "destination") {
    v = v.toUpperCase();
    if (e.target.value !== v) {
      const pos = e.target.selectionStart;
      e.target.value = v;
      e.target.setSelectionRange(pos, pos);
    }
  }
  if (key === "markupPct") v = v === "" ? 0 : Number(v);
  if (key === "hsCode") { state.draft.hsDesc = ""; $("#hs-desc").textContent = ""; }
  state.draft[key] = v;
  recompute();
}

function renderPieces() {
  const body = $("#pieces-body");
  const fields = ["qty", "lengthCm", "widthCm", "heightCm", "weightKg"];
  const labels = ["Quantity", "Length cm", "Width cm", "Height cm", "Weight kg per piece"];
  mount(body, state.draft.pieces.map((p, i) =>
    h("tr", {},
      fields.map((f, j) => h("td", {}, h("input", {
        type: "number", min: "0", step: f === "qty" ? "1" : "any", value: p[f], "aria-label": `Line ${i + 1} ${labels[j]}`,
        oninput: (e) => { state.draft.pieces[i][f] = e.target.value; recompute(); },
      }))),
      h("td", {}, h("button", {
        class: "icon-btn", title: "Remove line", "aria-label": `Remove line ${i + 1}`, disabled: state.draft.pieces.length === 1,
        onclick: () => { state.draft.pieces.splice(i, 1); renderPieces(); recompute(); },
      }, "×")),
    )));
}

function refreshLocations() {
  const set = new Set();
  for (const r of state.rates.rows) {
    if (r.origin !== "*") set.add(r.origin);
    if (r.destination !== "*") set.add(r.destination);
  }
  mount($("#locations"), [...set].sort().map((c) => h("option", { value: c, label: LOCATION_NAMES[c] ? `${c} — ${LOCATION_NAMES[c]}` : c })));
}

// ---------------------------------------------------- quote: compute

function draftShipment() {
  const d = state.draft;
  return {
    origin: d.origin.trim(), destination: d.destination.trim(),
    pieces: d.pieces.map((p) => ({ qty: +p.qty || 0, lengthCm: +p.lengthCm || 0, widthCm: +p.widthCm || 0, heightCm: +p.heightCm || 0, weightKg: +p.weightKg || 0 })),
    goodsValue: +d.goodsValue || 0, insure: d.insure, dutyPct: +d.dutyPct || 0, vatPct: +d.vatPct || 0, valuationBasis: d.valuationBasis,
  };
}

function recompute() {
  const shipment = draftShipment();
  const totals = cargoTotals(shipment.pieces);
  const ready = shipment.origin && shipment.destination && totals.grossKg > 0 && totals.cbm > 0;
  state.result = ready ? buildOptions(state.rates.rows, shipment, engineSettings(), today()) : null;
  const opts = state.result?.options || [];
  if (opts.length && !opts.some((o) => o.id === state.draft.selectedId)) {
    state.draft.selectedId = opts[0].id;
    state.draft.overrides = {};
  }
  renderCargoStats(totals);
  renderOptions(shipment, totals);
  renderBuilder();
  saveDraft();
}

function selectedOption() {
  return state.result?.options.find((o) => o.id === state.draft.selectedId) || null;
}

function pricedFor(option) {
  const lines = [...option.lines, ...dutyLines(option.duty, cur())];
  return priceLines(lines, { markupPct: Number(state.draft.markupPct) || 0, incoterm: state.draft.incoterm, overrides: state.draft.overrides });
}

const customerPayer = () => (state.draft.role === "SHIPPER" ? "SELLER" : "BUYER");
const payerLabel = (p) => (p === "SELLER" ? "Shipper" : "Consignee");

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), sub ? h("div", { class: "sub", text: sub }) : null);
}

function renderCargoStats(totals) {
  const air = airChargeableKg(totals.grossKg, totals.cbm, Number(state.settings.airDivisor) || 6000);
  mount($("#cargo-stats"),
    stat("Pieces", num(totals.count)),
    stat("Gross weight", `${num(totals.grossKg, 1)} kg`),
    stat("Volume", `${num(totals.cbm, 3)} cbm`),
    stat("Air chargeable", `${num(air.chargeableKg, 1)} kg`, `vol. ${num(air.volumetricKg, 1)} kg`),
    stat("LCL W/M", num(revenueTons(totals.grossKg, totals.cbm), 2)),
  );
}

function equipmentText(o) {
  if (o.mode === "AIR") return `${num(o.metrics.chargeableKg, 1)} kg chg.`;
  if (o.mode === "LCL") return `${num(o.metrics.revenueTons, 2)} W/M`;
  return `${o.fit.count} × ${o.container}`;
}

function renderOptions(shipment, totals) {
  const box = $("#options");
  const meta = $("#options-meta");
  meta.textContent = "";
  if (!shipment.origin || !shipment.destination) return mount(box, h("div", { class: "empty", text: "Enter an origin and destination to see options." }));
  if (!(totals.grossKg > 0 && totals.cbm > 0)) return mount(box, h("div", { class: "empty", text: "Add piece dimensions and weight to price the shipment." }));
  const opts = state.result.options;
  if (!opts.length) {
    const lanes = [...new Set(state.rates.rows.filter((r) => r.chargeCode === "FRT").map((r) => `${r.origin} → ${r.destination}`))].sort();
    return mount(box, h("div", { class: "empty" },
      h("p", { text: `No current rates for ${shipment.origin} → ${shipment.destination}.` }),
      lanes.length ? h("p", { class: "small", text: `Lanes in your rate sheet: ${lanes.join(", ")}` }) : null,
      h("button", { class: "btn sm", onclick: () => showView("rates"), text: "Manage rates" })));
  }
  meta.textContent = `${opts.length} option${opts.length === 1 ? "" : "s"} · ${shipment.origin} → ${shipment.destination}`;
  const cheapest = Math.min(...opts.map((o) => o.logisticsBuy));
  const fastest = Math.min(...opts.map((o) => o.transitDays ?? Infinity));
  const markup = 1 + (Number(state.draft.markupPct) || 0) / 100;

  mount(box, h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", { text: "Mode" }), h("th", { text: "Carrier" }), h("th", { text: "Equipment" }), h("th", { class: "num", text: "Transit" }),
      h("th", { class: "num", text: "Buy" }), h("th", { class: "num", text: "Sell" }), h("th", { class: "num", text: "Landed cost" }), h("th", {}))),
    h("tbody", {}, opts.map((o) => {
      const sell = o.logisticsBuy * markup;
      const landed = shipment.goodsValue + sell + o.duty.duty + o.duty.vat;
      const selected = o.id === state.draft.selectedId;
      const select = () => { if (!selected) { state.draft.selectedId = o.id; state.draft.overrides = {}; recompute(); } };
      return h("tr", { class: selected ? "selected" : "" },
        h("td", {}, h("span", { class: "mode", text: o.mode })),
        h("td", {}, o.carrier,
          o.logisticsBuy === cheapest ? [" ", h("span", { class: "badge good", text: "Cheapest" })] : null,
          o.transitDays === fastest && opts.length > 1 ? [" ", h("span", { class: "badge accent", text: "Fastest" })] : null,
          o.warnings.length ? [" ", h("span", { class: "badge warn", title: o.warnings.join("\n"), text: "!" })] : null),
        h("td", {}, equipmentText(o), o.fit ? h("div", { class: "bar", title: `Volume use ${pct(o.fit.volumeUtil)}` }, barFill(o.fit.volumeUtil)) : null),
        h("td", { class: "num", text: o.transitDays != null ? `${o.transitDays} d` : "—" }),
        h("td", { class: "num", text: money(o.logisticsBuy, cur()) }),
        h("td", { class: "num", text: money(sell, cur()) }),
        h("td", { class: "num", text: money(landed, cur()) }),
        h("td", {}, h("button", { class: `btn sm${selected ? " primary" : ""}`, onclick: select, "aria-pressed": String(selected), text: selected ? "Selected" : "Select" })),
      );
    })))));
}

function barFill(ratio) {
  const d = h("div");
  d.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  return d;
}

// ---------------------------------------------------- quote: builder

function basisText(l) {
  const r = (v) => num(v, v < 10 ? 2 : 0);
  switch (l.basis) {
    case "KG": return `${num(l.qty, 1)} kg × ${r(l.rate)} ${l.rateCurrency}`;
    case "WM": return `${num(l.qty, 2)} W/M × ${r(l.rate)} ${l.rateCurrency}`;
    case "CBM": return `${num(l.qty, 3)} cbm × ${r(l.rate)} ${l.rateCurrency}`;
    case "CONTAINER": return `${l.qty} × ${l.container || "cntr"} × ${r(l.rate)} ${l.rateCurrency}`;
    case "SHIPMENT": return `${r(l.rate)} ${l.rateCurrency} flat`;
    case "PCT_FRT": return `${l.rate}% of freight`;
    case "PCT": return l.code === "INS" ? `${l.rate}% × ${money(l.qty, l.currency)}` : `on ${money(l.qty, l.currency)}`;
    default: return "";
  }
}

function renderBuilder() {
  const box = $("#builder");
  const o = selectedOption();
  if (!o) return mount(box, h("div", { class: "empty", text: "Select an option to build the quote." }));
  const d = state.draft;
  const priced = pricedFor(o);
  const lc = landedCost(d.goodsValue, priced.lines, d.units);
  const custSide = customerPayer();
  const shown = d.show === "ALL" ? priced.lines : priced.lines.filter((l) => l.payer === custSide);
  const shownTotal = round2(shown.reduce((s, l) => s + l.sell, 0));

  const warnings = [...o.warnings];
  if (o.mode === "AIR" && SEA_ONLY_INCOTERMS.includes(d.incoterm)) warnings.push(`${d.incoterm} is a sea/inland-waterway term. For air freight use ${{ FOB: "FCA", FAS: "FCA", CFR: "CPT", CIF: "CIP" }[d.incoterm]}.`);
  if (["CIF", "CIP"].includes(d.incoterm) && !d.insure) warnings.push(`${d.incoterm} requires the seller to insure the cargo — tick "Add cargo insurance".`);
  if (!d.dutyPct && !d.vatPct) warnings.push("No duty or VAT rate entered — landed cost excludes import taxes.");
  if (!shown.length) warnings.push(`Under ${d.incoterm} the ${d.role.toLowerCase()} pays none of these charges. Switch to "All charges" or change the customer role.`);

  const rows = [];
  for (const cat of CATEGORIES) {
    const ls = priced.lines.filter((l) => l.category === cat);
    if (!ls.length) continue;
    rows.push(h("tr", { class: "cat-row" }, h("td", { colspan: "6", text: CATEGORY_LABELS[cat] })));
    for (const l of ls) {
      const overridden = Object.hasOwn(d.overrides, l.id);
      rows.push(h("tr", {},
        h("td", {}, l.name, " ", h("span", { class: "muted small mono", text: l.code })),
        h("td", { class: "muted small" }, basisText(l), l.minApplied ? h("span", { class: "badge", title: "Minimum charge applied", text: "min" }) : null),
        h("td", { class: "num", text: money(l.amount, cur()) }),
        h("td", { class: "num" }, h("input", {
          class: `sell${overridden ? " overridden" : ""}`, type: "number", step: "any", value: l.sell.toFixed(2),
          "aria-label": `Sell price for ${l.name}`, title: overridden ? "Manual price — clear the box to reset" : "Edit to override the sell price",
          onchange: (e) => {
            const v = e.target.value.trim();
            if (v === "" || !Number.isFinite(Number(v))) delete d.overrides[l.id];
            else d.overrides[l.id] = Number(v);
            renderBuilder();
            saveDraft();
          },
        })),
        h("td", { class: `num ${l.profit < 0 ? "bad" : ""}`, text: money(l.profit, cur()) }),
        h("td", {}, h("span", { class: `badge${l.payer === custSide ? " accent" : ""}`, text: payerLabel(l.payer) })),
      ));
    }
  }
  rows.push(h("tr", { class: "total-row" },
    h("td", { colspan: "2", text: "Total" }),
    h("td", { class: "num", text: money(priced.buy, cur()) }),
    h("td", { class: "num", text: money(priced.sell, cur()) }),
    h("td", { class: "num", text: money(priced.profit, cur()) }),
    h("td", {})));

  const validUntil = quoteValidUntil(o);
  mount(box,
    warnings.length ? h("div", { class: "notice warn mb-12" }, h("strong", { text: "Check: " }), h("ul", {}, warnings.map((w) => h("li", { text: w })))) : null,
    h("div", { class: "stats mb-12" },
      stat("Sell", money(priced.sell, cur())),
      stat("Profit", money(priced.profit, cur()), `${num(priced.marginPct, 1)}% margin`),
      stat("Shipper pays", money(priced.sellerTotal, cur()), INCOTERMS[d.incoterm].name),
      stat("Consignee pays", money(priced.buyerTotal, cur())),
    ),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Charge" }), h("th", { text: "Basis" }), h("th", { class: "num", text: "Buy" }), h("th", { class: "num", text: "Sell" }), h("th", { class: "num", text: "Profit" }), h("th", { text: "Paid by" }))),
      h("tbody", {}, rows))),
    h("h3", { class: "sub-h", text: "Estimated landed cost (consignee view)" }),
    h("div", { class: "stats" },
      stat("Goods", money(lc.goods, cur())),
      stat("Logistics", money(lc.logistics, cur()), lc.logisticsPctOfGoods != null ? `${num(lc.logisticsPctOfGoods, 1)}% of goods` : null),
      stat("Duty", money(lc.duty, cur()), `customs value ${money(o.duty.customsValue, cur())}`),
      stat("VAT / GST", money(lc.vat, cur()), "often recoverable"),
      stat("Landed total", money(lc.total, cur()), `${money(lc.exVat, cur())} ex VAT`),
      lc.perUnit != null ? stat("Per unit", money(lc.perUnitExVat, cur()), "ex VAT") : null,
    ),
    h("label", { class: "field mt-12" }, h("span", { text: "Notes on the quote" }),
      h("textarea", { rows: "2", value: d.notes, placeholder: "e.g. Cargo ready date, stackable, non-hazardous", oninput: (e) => { d.notes = e.target.value; saveDraft(); } })),
    h("p", { class: "muted small" },
      `Customer sees ${d.show === "ALL" ? "all charges" : `the ${d.role.toLowerCase()}'s share`}: `, h("strong", { text: money(shownTotal, cur()) }),
      ` · Valid until ${validUntil}${o.rateExpiry && o.rateExpiry === validUntil ? " (rate expiry)" : ""}`),
    h("div", { class: "row mt-8" },
      h("button", { class: "btn primary", onclick: saveQuote, text: d.quoteNo ? `Update ${d.quoteNo}` : "Save quote" }),
      h("button", { class: "btn", onclick: () => printQuote(makeRecord()), text: "Print / Save PDF" }),
      h("button", { class: "btn", onclick: () => copyEmail(makeRecord()), text: "Copy email" }),
      h("button", { class: "btn", onclick: () => openMail(makeRecord()), text: "Open in mail app" }),
    ),
  );
}

function quoteValidUntil(o) {
  const v = addDays(today(), Number(state.settings.validityDays) || 14);
  return o.rateExpiry && o.rateExpiry < v ? o.rateExpiry : v;
}

// ---------------------------------------------------- quote records

function makeRecord() {
  const d = state.draft;
  const o = selectedOption();
  const priced = pricedFor(o);
  const existing = d.quoteNo ? state.quotes.find((q) => q.quoteNo === d.quoteNo) : null;
  const totals = cargoTotals(draftShipment().pieces);
  return {
    quoteNo: d.quoteNo || "DRAFT",
    createdAt: existing?.createdAt || today(),
    updatedAt: today(),
    validUntil: quoteValidUntil(o),
    status: existing?.status || "QUOTED",
    currency: cur(),
    customer: d.customer.trim() || "Customer",
    role: d.role,
    incoterm: d.incoterm,
    show: d.show,
    notes: d.notes,
    markupPct: Number(d.markupPct) || 0,
    overrides: { ...d.overrides },
    shipment: {
      origin: d.origin.trim(), destination: d.destination.trim(), commodity: d.commodity, hsCode: d.hsCode, hsDesc: d.hsDesc,
      goodsValue: +d.goodsValue || 0, units: +d.units || 0, pieces: d.pieces.map((p) => ({ ...p })), dutyPct: d.dutyPct, vatPct: d.vatPct,
      valuationBasis: d.valuationBasis, insure: d.insure,
    },
    cargo: { ...totals, chargeableKg: o.metrics.chargeableKg, revenueTons: o.metrics.revenueTons },
    option: { id: o.id, mode: o.mode, carrier: o.carrier, container: o.container, containers: o.fit?.count || 0, transitDays: o.transitDays },
    lines: priced.lines,
    totals: summarize(priced.lines),
    landed: landedCost(d.goodsValue, priced.lines, d.units),
  };
}

function saveQuote() {
  if (!state.draft.customer.trim()) {
    $("#f-customer").focus();
    return toast("Enter a customer name first.");
  }
  if (!state.draft.quoteNo) state.draft.quoteNo = nextQuoteNumber(today(), state.quotes.map((q) => q.quoteNo));
  const rec = makeRecord();
  const i = state.quotes.findIndex((q) => q.quoteNo === rec.quoteNo);
  if (i >= 0) state.quotes[i] = rec; else state.quotes.unshift(rec);
  persistQuotes();
  fillForm();
  renderBuilder();
  saveDraft();
  toast(`Saved ${rec.quoteNo}`);
}

function persistQuotes() {
  if (!store.save(store.KEYS.quotes, state.quotes)) toast("Browser storage is full or blocked — quote history couldn't be saved.");
}

function openQuote(q) {
  state.draft = {
    ...blankDraft(state.settings),
    quoteNo: q.quoteNo, customer: q.customer, role: q.role, incoterm: q.incoterm, show: q.show, notes: q.notes,
    markupPct: q.markupPct, overrides: q.overrides || {}, selectedId: q.option.id,
    ...q.shipment, pieces: q.shipment.pieces.map((p) => ({ ...p })),
  };
  fillForm();
  recompute();
  showView("quote");
  const now = selectedOption();
  if (!now || now.id !== q.option.id) toast("The original rate is no longer available — re-priced with current rates.");
  else if (round2(pricedFor(now).sell) !== q.totals.sell) toast("Re-priced with current rates and settings.");
}

// ---------------------------------------------------- print & email

const lineVisible = (rec) => (l) => rec.show === "ALL" || l.payer === (rec.role === "SHIPPER" ? "SELLER" : "BUYER");

function optionLabel(rec) {
  const o = rec.option;
  const eq = o.mode === "FCL" ? `${o.containers} × ${CONTAINERS[o.container]?.label || o.container}` : o.mode === "AIR" ? `${num(rec.cargo.chargeableKg, 1)} kg chargeable` : `${num(rec.cargo.revenueTons, 2)} W/M`;
  return `${o.mode} · ${o.carrier} · ${eq}`;
}

const placeName = (c) => (LOCATION_NAMES[c] ? `${c} (${LOCATION_NAMES[c]})` : c);

function printQuote(rec) {
  const s = state.settings;
  const lines = rec.lines.filter(lineVisible(rec));
  const total = round2(lines.reduce((a, l) => a + l.sell, 0));
  const hidden = rec.lines.length - lines.length;
  const showPayer = rec.show === "ALL";
  const rows = [];
  for (const cat of CATEGORIES) {
    const ls = lines.filter((l) => l.category === cat);
    if (!ls.length) continue;
    rows.push(h("tr", { class: "cat-row" }, h("td", { colspan: showPayer ? "4" : "3", text: CATEGORY_LABELS[cat] })));
    for (const l of ls) rows.push(h("tr", {}, h("td", { text: l.name }), h("td", { text: basisText(l) }),
      showPayer ? h("td", { text: payerLabel(l.payer) }) : null, h("td", { class: "num", text: money(l.sell, rec.currency) })));
  }
  rows.push(h("tr", { class: "total-row" }, h("td", { colspan: showPayer ? "3" : "2", text: `Total (${rec.currency})` }), h("td", { class: "num", text: money(total, rec.currency) })));

  const contact = [s.address, [s.phone, s.email].filter(Boolean).join(" · "), s.website].filter(Boolean).join("\n");
  const meta = (label, value) => h("div", {}, h("span", { text: label }), value);
  mount($("#print-area"),
    h("div", { class: "pq-head" },
      h("div", {}, s.logo ? h("img", { src: s.logo, alt: "" }) : null, h("div", { class: "pq-company" }, h("strong", { text: s.company }), "\n", contact)),
      h("div", { class: "pq-title" }, h("h1", { text: "QUOTATION" }), h("div", { text: rec.quoteNo }), h("div", { text: `Date: ${rec.updatedAt}` }), h("div", { text: `Valid until: ${rec.validUntil}` }))),
    h("div", { class: "pq-meta" },
      meta("Customer", `${rec.customer} (${rec.role === "SHIPPER" ? "shipper" : "consignee"})`),
      meta("Incoterm", `${rec.incoterm} — ${INCOTERMS[rec.incoterm].name}`),
      meta("Origin", placeName(rec.shipment.origin)),
      meta("Destination", placeName(rec.shipment.destination)),
      meta("Service", optionLabel(rec)),
      meta("Transit time", rec.option.transitDays != null ? `approx. ${rec.option.transitDays} days` : "—"),
      meta("Cargo", `${rec.cargo.count} pcs · ${num(rec.cargo.grossKg, 1)} kg · ${num(rec.cargo.cbm, 3)} cbm`),
      meta("Commodity", [rec.shipment.commodity, rec.shipment.hsCode && `HS ${rec.shipment.hsCode}`].filter(Boolean).join(" · ") || "—"),
    ),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Charge" }), h("th", { text: "Basis" }), showPayer ? h("th", { text: "Paid by" }) : null, h("th", { class: "num", text: "Amount" }))),
      h("tbody", {}, rows)),
    h("div", { class: "pq-notes" },
      hidden > 0 && !showPayer ? h("p", { text: `Charges payable by the ${rec.role === "SHIPPER" ? "consignee" : "shipper"} under ${rec.incoterm} are not included.` }) : null,
      lines.some((l) => l.category === "DUTY") ? h("p", { text: "Duties and taxes are estimates based on the HS code and rates provided, and are invoiced at cost as assessed by customs." }) : null,
      rec.role === "CONSIGNEE" && rec.landed.goods > 0 ? h("p", { text: `Estimated landed cost: ${money(rec.landed.total, rec.currency)} (${money(rec.landed.exVat, rec.currency)} excluding VAT)${rec.landed.perUnitExVat != null ? `, ${money(rec.landed.perUnitExVat, rec.currency)} per unit ex VAT` : ""}.` }) : null,
      rec.notes ? [h("h3", { text: "Notes" }), h("div", { text: rec.notes })] : null,
      s.terms ? [h("h3", { text: "Terms & conditions" }), h("div", { text: s.terms })] : null,
    ),
  );
  const prevTitle = document.title;
  document.title = `${rec.quoteNo} ${rec.customer}`;
  window.addEventListener("afterprint", () => { document.title = prevTitle; }, { once: true });
  window.print();
}

function emailText(rec) {
  const s = state.settings;
  const lines = rec.lines.filter(lineVisible(rec));
  const total = round2(lines.reduce((a, l) => a + l.sell, 0));
  const pad = (str, n) => (str.length >= n ? str.slice(0, n - 1) + " " : str + " ".repeat(n - str.length));
  const body = [];
  body.push(`Dear ${rec.customer},`, "", "Thank you for your enquiry. Please find our quotation below.", "");
  body.push(`Quote:        ${rec.quoteNo}`);
  body.push(`Route:        ${placeName(rec.shipment.origin)} → ${placeName(rec.shipment.destination)}`);
  body.push(`Service:      ${optionLabel(rec)}`);
  body.push(`Incoterm:     ${rec.incoterm}`);
  body.push(`Cargo:        ${rec.cargo.count} pcs, ${num(rec.cargo.grossKg, 1)} kg, ${num(rec.cargo.cbm, 3)} cbm${rec.shipment.commodity ? ` — ${rec.shipment.commodity}` : ""}`);
  if (rec.option.transitDays != null) body.push(`Transit time: approx. ${rec.option.transitDays} days`);
  body.push("", `Charges (${rec.currency}):`);
  for (const cat of CATEGORIES) {
    const ls = lines.filter((l) => l.category === cat);
    if (!ls.length) continue;
    body.push(`  ${CATEGORY_LABELS[cat]}`);
    for (const l of ls) body.push(`    ${pad(l.name, 38)}${num(l.sell, 2).padStart(12)}`);
  }
  body.push(`  ${pad("TOTAL", 40)}${num(total, 2).padStart(12)}`, "");
  body.push(`Valid until ${rec.validUntil}. Subject to space and equipment availability.`);
  if (lines.some((l) => l.category === "DUTY")) body.push("Duties and taxes are estimates and are invoiced at cost.");
  if (rec.notes) body.push("", rec.notes);
  body.push("", "Kind regards,", s.company, [s.phone, s.email].filter(Boolean).join(" · "));
  return {
    subject: `Freight quote ${rec.quoteNo} — ${rec.shipment.origin} to ${rec.shipment.destination} (${rec.option.mode})`,
    body: body.join("\n"),
  };
}

async function copyEmail(rec) {
  const { subject, body } = emailText(rec);
  const text = `Subject: ${subject}\n\n${body}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Email copied to clipboard.");
  } catch {
    download(`${rec.quoteNo}-email.txt`, text);
    toast("Clipboard unavailable — downloaded as a text file.");
  }
}

function openMail(rec) {
  const { subject, body } = emailText(rec);
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ------------------------------------------------------------- HS search

function initHsSearch() {
  const input = $("#f-hs-search");
  const box = $("#hs-results");
  const close = () => box.classList.add("hidden");
  const run = debounce(async () => {
    const q = input.value;
    if (q.trim().length < 2) return close();
    try {
      const results = await searchHs(q);
      if (input.value !== q) return;
      box.classList.remove("hidden");
      if (!results.length) return mount(box, h("div", { class: "empty small", text: "No matches." }));
      mount(box, results.map((r) => h("button", {
        type: "button", role: "option",
        onclick: () => {
          Object.assign(state.draft, { hsCode: r.code, hsDesc: r.description });
          if (!state.draft.commodity) state.draft.commodity = r.description;
          input.value = "";
          close();
          fillForm();
          recompute();
          $("#f-duty").focus();
        },
      }, h("span", { class: "code", text: r.code }), r.description, h("div", { class: "muted small", text: r.heading }))));
    } catch (e) {
      box.classList.remove("hidden");
      mount(box, h("div", { class: "empty small", text: `Couldn't load HS data (${e.message}).` }));
    }
  }, 180);
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowDown") { e.preventDefault(); box.querySelector("button")?.focus(); }
  });
  box.addEventListener("keydown", (e) => {
    const items = $$("button", box);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (i <= 0 ? input : items[i - 1]).focus(); }
    if (e.key === "Escape") { close(); input.focus(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".hs-box")) close(); });
}

// --------------------------------------------------------------- history

function renderHistory() {
  const t = today();
  const filter = $("#f-hist-filter").value.trim().toLowerCase();
  const quotes = state.quotes.filter((q) => !filter ||
    [q.quoteNo, q.customer, q.shipment.origin, q.shipment.destination, q.option.mode, q.option.carrier].join(" ").toLowerCase().includes(filter));
  const s = historyStats(state.quotes, t);
  const o = s.overall;
  mount($("#hist-stats"),
    stat("Quotes", num(o.quoted), `${o.open} open · ${o.expired} expired`),
    stat("Won", num(o.won)),
    stat("Lost", num(o.lost)),
    stat("Win rate", pct(o.winRate), "won ÷ (won + lost)"),
    stat("Won revenue", money(o.wonSell, cur())),
    stat("Won profit", money(o.wonProfit, cur())),
  );

  if (!state.quotes.length) {
    mount($("#hist-table"), h("div", { class: "empty", text: "No saved quotes yet. Build one on the New quote tab and press Save quote." }));
  } else {
    const badgeClass = { WON: "good", LOST: "bad", EXPIRED: "warn", QUOTED: "accent" };
    mount($("#hist-table"), h("table", {},
      h("thead", {}, h("tr", {}, ["Quote", "Date", "Customer", "Lane", "Service", "Sell", "Profit", "Valid until", "Status", ""].map((x, i) =>
        h("th", { class: i === 5 || i === 6 ? "num" : "", text: x })))),
      h("tbody", {}, quotes.map((q) => {
        const eff = effectiveStatus(q, t);
        return h("tr", {},
          h("td", { class: "mono", text: q.quoteNo }),
          h("td", { text: q.createdAt }),
          h("td", { text: q.customer }),
          h("td", { text: `${q.shipment.origin} → ${q.shipment.destination}` }),
          h("td", {}, h("span", { class: "mode", text: q.option.mode }), ` ${q.option.carrier}${q.option.container ? ` ${q.option.containers}×${q.option.container}` : ""}`),
          h("td", { class: "num", text: money(q.totals.sell, q.currency) }),
          h("td", { class: "num", text: money(q.totals.profit, q.currency) }),
          h("td", { text: q.validUntil }),
          h("td", {}, h("div", { class: "row" },
            h("select", {
              "aria-label": `Status of ${q.quoteNo}`, class: "w-auto",
              onchange: (e) => { q.status = e.target.value; persistQuotes(); renderHistory(); },
            }, ["QUOTED", "WON", "LOST"].map((st) => h("option", { value: st, selected: q.status === st, text: st[0] + st.slice(1).toLowerCase() }))),
            eff === "EXPIRED" ? h("span", { class: `badge ${badgeClass[eff]}`, text: "Expired" }) : null)),
          h("td", {}, h("div", { class: "row" },
            h("button", { class: "btn sm", onclick: () => openQuote(q), text: "Open" }),
            h("button", { class: "btn sm", onclick: () => printQuote(q), text: "Print" }),
            h("button", { class: "icon-btn", title: "Delete quote", "aria-label": `Delete ${q.quoteNo}`, onclick: () => deleteQuote(q), text: "×" }))),
        );
      }))));
  }

  const breakdown = (rows, label) => rows.length
    ? h("table", {},
      h("thead", {}, h("tr", {}, [label, "Quotes", "Won", "Lost", "Win rate", "Won profit"].map((x, i) => h("th", { class: i ? "num" : "", text: x })))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { text: r.key }), h("td", { class: "num", text: r.quoted }), h("td", { class: "num", text: r.won }), h("td", { class: "num", text: r.lost }),
        h("td", { class: "num", text: pct(r.winRate) }), h("td", { class: "num", text: money(r.wonProfit, cur()) })))))
    : h("div", { class: "empty small", text: "No data yet." });
  mount($("#hist-lanes"), breakdown(s.byLane, "Lane"));
  mount($("#hist-modes"), breakdown(s.byMode, "Mode"));
}

function isValidQuote(q) {
  const str = (v) => typeof v === "string";
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  return q && str(q.quoteNo) && str(q.customer) && str(q.createdAt) && str(q.currency) && ["QUOTED", "WON", "LOST"].includes(q.status) &&
    Object.hasOwn(INCOTERMS, q.incoterm) && q.shipment && str(q.shipment.origin) && str(q.shipment.destination) && Array.isArray(q.shipment.pieces) &&
    q.option && str(q.option.mode) && str(q.option.carrier) && q.totals && n(q.totals.sell) && n(q.totals.profit) && n(q.totals.buy) &&
    Array.isArray(q.lines) && q.cargo && q.landed;
}

function deleteQuote(q) {
  if (!confirm(`Delete ${q.quoteNo} for ${q.customer}? This can't be undone.`)) return;
  state.quotes = state.quotes.filter((x) => x !== q);
  if (state.draft.quoteNo === q.quoteNo) { state.draft.quoteNo = null; fillForm(); renderBuilder(); }
  persistQuotes();
  renderHistory();
}

function exportHistoryCsv() {
  const cols = ["quote_no", "created", "valid_until", "status", "customer", "role", "origin", "destination", "mode", "carrier", "equipment", "incoterm", "currency", "buy", "sell", "profit", "margin_pct", "landed_cost"];
  const t = today();
  const lines = [cols.join(",")];
  for (const q of state.quotes) {
    lines.push([
      q.quoteNo, q.createdAt, q.validUntil, effectiveStatus(q, t), q.customer, q.role, q.shipment.origin, q.shipment.destination, q.option.mode,
      q.option.carrier, q.option.container ? `${q.option.containers}x${q.option.container}` : "", q.incoterm, q.currency,
      q.totals.buy, q.totals.sell, q.totals.profit, q.totals.marginPct, q.landed.total,
    ].map(csvCell).join(","));
  }
  download(`quotecraft-history-${t}.csv`, lines.join("\n") + "\n", "text/csv");
}

function backup() {
  const data = { app: "quotecraft", version: 1, exportedAt: new Date().toISOString(), settings: state.settings, quotes: state.quotes, rates: state.rates.source === "upload" ? state.rates : null };
  download(`quotecraft-backup-${today()}.json`, JSON.stringify(data, null, 2), "application/json");
}

async function restore(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== "quotecraft" || !Array.isArray(data.quotes)) throw new Error("not a QuoteCraft backup");
    const quotes = data.quotes.filter(isValidQuote);
    if (!confirm(`Replace your current settings and ${state.quotes.length} quote(s) with this backup (${quotes.length} quotes)?`)) return;
    const settings = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const v = data.settings?.[k];
      if (v != null && typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
    }
    const logo = data.settings?.logo;
    settings.logo = typeof logo === "string" && /^data:image\/(png|jpeg|svg\+xml);base64,/.test(logo) ? logo : null;
    state.settings = settings;
    state.quotes = quotes;
    store.save(store.KEYS.settings, state.settings);
    persistQuotes();
    if (Array.isArray(data.rates?.rows) && data.rates.rows.length) {
      // Re-validate through the CSV pipeline so a hand-edited backup can't feed bad rows to the engine.
      const { rows, errors } = normalizeRates(parseCsv(ratesToCsv(data.rates.rows)));
      state.rates = { rows, source: "upload", fileName: String(data.rates.fileName || "restored.csv"), loadedAt: new Date().toISOString(), errors };
      store.save(store.KEYS.rates, state.rates);
      refreshLocations();
    }
    fillForm();
    recompute();
    renderHistory();
    toast("Backup restored.");
  } catch (err) {
    toast(`Couldn't restore: ${err.message}`);
  }
}

// ------------------------------------------------------------------ rates view

function renderRates() {
  const t = today();
  const rows = state.rates.rows;
  const statuses = rows.map((r) => rateStatus(r, t));
  const count = (s) => statuses.filter((x) => x === s).length;
  const lanes = new Set(rows.filter((r) => r.chargeCode === "FRT").map((r) => `${r.origin}>${r.destination}`));
  const carriers = new Set(rows.filter((r) => r.carrier !== "*").map((r) => r.carrier));
  mount($("#rate-stats"),
    stat("Source", state.rates.source === "sample" ? "Sample" : "Uploaded", state.rates.fileName || ""),
    stat("Rows", num(rows.length)),
    stat("Lanes", num(lanes.size)),
    stat("Carriers", num(carriers.size)),
    stat("Expiring ≤14d", num(count("EXPIRING"))),
    stat("Expired", num(count("EXPIRED"))),
  );
  const msgs = [];
  if (state.rates.source === "sample") msgs.push(h("div", { class: "notice info", text: "You're using the bundled sample rates (fictional carriers, illustrative prices). Upload your own rate sheet to quote real business." }));
  if (count("EXPIRED")) msgs.push(h("div", { class: "notice bad", text: `${count("EXPIRED")} row(s) have expired and are ignored when quoting.` }));
  if (count("EXPIRING")) msgs.push(h("div", { class: "notice warn", text: `${count("EXPIRING")} row(s) expire within 14 days — request updated rates.` }));
  if (state.rates.errors?.length) msgs.push(h("div", { class: "notice bad" }, h("strong", { text: `${state.rates.errors.length} row(s) skipped:` }), h("ul", {}, state.rates.errors.map((e) => h("li", { text: e })))));
  mount($("#rate-messages"), msgs);
  $("#rate-messages").classList.toggle("hidden", !msgs.length);

  const f = $("#f-rate-filter").value.trim().toLowerCase();
  const filtered = rows.map((r, i) => [r, statuses[i]]).filter(([r]) => !f ||
    [r.origin, r.destination, r.mode, r.carrier, r.chargeCode, r.chargeName, r.category, r.container].join(" ").toLowerCase().includes(f));
  const LIMIT = 400;
  const statusBadge = { VALID: ["good", "Valid"], EXPIRING: ["warn", "Expiring"], EXPIRED: ["bad", "Expired"], FUTURE: ["", "Future"] };
  mount($("#rate-table"),
    filtered.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["Lane", "Mode", "Carrier", "Code", "Charge", "Category", "Basis", "Cntr", "Break", "Rate", "Min", "Cur", "Transit", "Valid to", ""].map((x, i) =>
        h("th", { class: [8, 9, 10, 12].includes(i) ? "num" : "", text: x })))),
      h("tbody", {}, filtered.slice(0, LIMIT).map(([r, st]) => h("tr", {},
        h("td", { class: "mono", text: `${r.origin} → ${r.destination}` }), h("td", { class: "mode", text: r.mode }), h("td", { text: r.carrier }),
        h("td", { class: "mono", text: r.chargeCode }), h("td", { text: r.chargeName }), h("td", { class: "small", text: r.category }),
        h("td", { class: "small", text: r.basis }), h("td", { text: r.container }), h("td", { class: "num", text: r.breakMin || "" }),
        h("td", { class: "num", text: r.basis === "PCT_FRT" ? `${r.rate}%` : num(r.rate, 2) }), h("td", { class: "num", text: r.minCharge ? num(r.minCharge, 2) : "" }),
        h("td", { text: r.currency }), h("td", { class: "num", text: r.transitDays ?? "" }), h("td", { text: r.validTo || "—" }),
        h("td", {}, h("span", { class: `badge ${statusBadge[st][0]}`, text: statusBadge[st][1] })),
      )))) : h("div", { class: "empty", text: rows.length ? "No rows match the filter." : "No rates loaded." }),
    filtered.length > LIMIT ? h("p", { class: "muted small", text: `Showing first ${LIMIT} of ${filtered.length} rows — refine the filter to see more.` }) : null,
  );
}

function downloadTemplate() {
  const example = [
    "AAAAA,BBBBB,FCL,CARRIER-1,FRT,Ocean freight,FREIGHT,CONTAINER,40HC,,2500,,USD,30,2026-01-01,2026-12-31",
    "AAAAA,BBBBB,LCL,CONSOL-1,FRT,Ocean freight (LCL),FREIGHT,WM,,,45,45,USD,35,,",
    "AAAAA,BBBBB,AIR,AIRLINE-1,FRT,Air freight,FREIGHT,KG,,0,6.50,120,USD,3,,",
    "AAAAA,BBBBB,AIR,AIRLINE-1,FRT,Air freight,FREIGHT,KG,,100,5.20,,USD,3,,",
    "AAAAA,*,FCL,*,OTHC,Origin terminal handling,ORIGIN,CONTAINER,,,150,,USD,,,",
    "*,BBBBB,LCL,*,DCFS,Destination CFS,DEST,WM,,,30,60,EUR,,,",
    "*,BBBBB,AIR,*,IMPCC,Import customs clearance,IMPORT_CLEARANCE,SHIPMENT,,,90,,USD,,,",
  ];
  download("quotecraft-rate-template.csv", [RATE_COLUMNS.join(","), ...example].join("\n") + "\n", "text/csv");
}

// --------------------------------------------------------------- settings

const SETTINGS_FIELDS = {
  "s-company": "company", "s-address": "address", "s-phone": "phone", "s-email": "email", "s-website": "website", "s-terms": "terms",
  "s-currency": "currency", "s-markup": "markupPct", "s-ins-pct": "insurancePct", "s-ins-min": "insuranceMin",
  "s-validity": "validityDays", "s-divisor": "airDivisor", "s-fx": "fxText",
};
const NUMERIC_SETTINGS = new Set(["markupPct", "insurancePct", "insuranceMin", "validityDays", "airDivisor"]);
let pendingLogo;

function fillSettings() {
  for (const [id, key] of Object.entries(SETTINGS_FIELDS)) $(`#${id}`).value = state.settings[key] ?? "";
  pendingLogo = state.settings.logo;
  showLogo();
}

function showLogo() {
  const img = $("#logo-preview");
  img.classList.toggle("hidden", !pendingLogo);
  if (pendingLogo) img.src = pendingLogo; else img.removeAttribute("src");
}

function onLogo(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/svg+xml"].includes(file.type)) return toast("Logo must be PNG, JPG or SVG.");
  if (file.size > 300 * 1024) { e.target.value = ""; return toast("Logo must be under 300 KB."); }
  const reader = new FileReader();
  reader.onload = () => { pendingLogo = reader.result; showLogo(); };
  reader.readAsDataURL(file);
}

function saveSettings() {
  const next = { ...state.settings };
  for (const [id, key] of Object.entries(SETTINGS_FIELDS)) {
    const v = $(`#${id}`).value;
    next[key] = NUMERIC_SETTINGS.has(key) ? Number(v) || 0 : v;
  }
  next.currency = next.currency.trim().toUpperCase();
  next.logo = pendingLogo || null;
  next.validityDays = Math.max(1, Math.round(next.validityDays) || 14);
  next.airDivisor = Number(next.airDivisor) === 5000 ? 5000 : 6000;
  const { fx, errors } = parseFx(next.fxText);
  if (!/^[A-Z]{3}$/.test(next.currency)) return toast("Currency must be a 3-letter code, e.g. USD.");
  if (!fx[next.currency]) return toast(`Add an FX rate for ${next.currency} (units per 1 USD).`);
  if (errors.length) return toast(`FX: ${errors[0]}`);
  const markupChanged = next.markupPct !== state.settings.markupPct;
  state.settings = next;
  if (markupChanged && !state.draft.quoteNo) state.draft.markupPct = next.markupPct;
  if (!store.save(store.KEYS.settings, next)) toast("Couldn't save settings — browser storage is full or blocked.");
  else toast("Settings saved.");
  fillForm();
  recompute();
}

// -------------------------------------------------------------------- init

async function init() {
  mount($("#f-incoterm"), Object.entries(INCOTERMS).map(([k, v]) => h("option", { value: k, text: `${k} — ${v.name}` })));
  for (const t of $$(".tab")) t.addEventListener("click", () => showView(t.dataset.view));
  for (const id of Object.keys(FIELD_MAP)) $(`#${id}`).addEventListener("input", onFieldInput);
  $("#f-insure").addEventListener("change", (e) => { state.draft.insure = e.target.checked; recompute(); });
  $("#btn-add-piece").addEventListener("click", () => { state.draft.pieces.push(blankPiece()); renderPieces(); recompute(); });
  $("#btn-new").addEventListener("click", () => {
    state.draft = blankDraft(state.settings);
    fillForm();
    recompute();
    $("#f-customer").focus();
  });
  initHsSearch();

  $("#f-hist-filter").addEventListener("input", debounce(renderHistory, 150));
  $("#btn-hist-csv").addEventListener("click", exportHistoryCsv);
  $("#btn-backup").addEventListener("click", backup);
  $("#f-restore").addEventListener("change", restore);

  $("#f-rates-file").addEventListener("change", onRatesUpload);
  $("#f-rate-filter").addEventListener("input", debounce(renderRates, 150));
  $("#btn-template").addEventListener("click", downloadTemplate);
  $("#btn-rates-export").addEventListener("click", () => download(state.rates.fileName?.replace(/\.xlsx?$/i, ".csv") || "rates.csv", ratesToCsv(state.rates.rows), "text/csv"));
  $("#btn-rates-sample").addEventListener("click", async () => {
    if (state.rates.source === "upload" && !confirm("Replace your uploaded rates with the sample sheet?")) return;
    store.remove(store.KEYS.rates);
    try { await loadSampleRates(); toast("Sample rates loaded."); } catch (e) { toast(`Couldn't load sample: ${e.message}`); }
    refreshLocations();
    recompute();
    renderRates();
  });

  $("#s-logo").addEventListener("change", onLogo);
  $("#btn-logo-clear").addEventListener("click", () => { pendingLogo = null; $("#s-logo").value = ""; showLogo(); });
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#btn-wipe").addEventListener("click", () => {
    if (!confirm("Erase all QuoteCraft settings, rates, quotes and drafts from this browser?")) return;
    store.wipe();
    location.reload();
  });

  await initRates();
  refreshLocations();
  fillForm();
  recompute();
  const start = location.hash.slice(1);
  showView(["history", "rates", "settings"].includes(start) ? start : "quote");
}

init();
