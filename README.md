# QuoteCraft

A freight quote and landed-cost builder for freight forwarders. Enter a shipment
and QuoteCraft prices every air, LCL and FCL option in your rate sheet, splits the
charges by Incoterm, applies your margin, estimates duty and landed cost, and
produces a PDF quote and a ready-to-send email.

**Live demo:** https://datawithdon.github.io/quotecraft/

It's a fully static web app. There's no backend, no account and no API keys, and
your data never leaves your browser.

## Features

- **Chargeable weight for every mode**
  - Air: volumetric weight at 1:6000 (or 1:5000 for express), rounded up to 0.5 kg.
  - LCL: weight or measure (1 CBM = 1,000 kg).
  - FCL: container count and fill level for 20GP, 40GP and 40HC.
- **Side-by-side comparison**: every carrier, mode and container option with transit time, buy price, sell price and landed cost. The cheapest and fastest options are badged.
- **Rate engine**
  - Air weight breaks (+45, +100, +300 kg…).
  - Minimum charges.
  - Surcharges as a percentage of freight.
  - Wildcard rows (`*`) for charges that apply to any origin, destination or carrier.
  - Multi-currency rates converted with your FX table.
  - Validity dates: expired rates are ignored and rates expiring soon are flagged.
- **Incoterms 2020**: each charge is tagged as paid by the shipper or the consignee. The quote can show only your customer's share or all charges. You get a warning when you use sea-only terms (FOB, CFR, CIF) with air freight, or CIF/CIP without insurance.
- **Margin control**: a markup % for the whole quote, plus per-line sell overrides, with live profit and margin.
- **Duty and landed cost**
  - Built-in HS code search over the WCO HS 2022 6-digit nomenclature.
  - Duty and VAT/GST on a CIF or FOB customs value.
  - Landed cost in total and per unit.
- **Output**
  - A branded quote, printed or saved as a PDF, with your logo, address and terms.
  - A plain-text email you can copy, or open in your mail app.
- **Quote history**: saved quotes, quoted/won/lost status, automatic expiry, win rate by lane and by mode, CSV export, and JSON backup and restore.
- **Rate sheet upload**: CSV or Excel (.xlsx). Bad rows are listed with the exact reason they were skipped.

## Run it locally

ES modules need to be served over HTTP (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Run the tests (Node 20+, no dependencies to install):

```bash
npm test
```

## Rate sheet format

There is one row per charge. Download a template from the **Rates** tab.

| Column | Description |
|---|---|
| `origin`, `destination` | Location codes (UN/LOCODE recommended, e.g. `CNSHA`). Use `*` to match any. |
| `mode` | `AIR`, `LCL` or `FCL` |
| `carrier` | Carrier name. Use `*` for charges that apply to every carrier. |
| `charge_code` | Short code. Every option needs a `FRT` row with a specific carrier. |
| `charge_name` | Text shown on the quote |
| `category` | `ORIGIN`, `FREIGHT`, `DEST`, `IMPORT_CLEARANCE` or `DELIVERY` |
| `basis` | `KG` (chargeable kg for air, gross kg for sea), `WM`, `CBM`, `CONTAINER`, `SHIPMENT` or `PCT_FRT` (% of the FRT line) |
| `container` | FCL only: `20GP`, `40GP` or `40HC`. Leave blank to apply to all container types. |
| `break_min` | Weight or quantity break. The highest break that doesn't exceed the shipment's quantity applies. |
| `rate`, `min_charge` | Rate per basis unit, and the minimum amount for the line |
| `currency` | 3-letter code, converted with the FX table in Settings |
| `transit_days` | Taken from the `FRT` row |
| `valid_from`, `valid_to` | Optional, `YYYY-MM-DD` |

When two rows share a `charge_code`, the more specific one wins: an exact origin
beats `*`, then an exact destination, then an exact carrier.

## How the Incoterm split works

| Incoterm | Seller (shipper) pays |
|---|---|
| EXW | Nothing |
| FCA, FAS, FOB | Origin charges |
| CPT, CFR | Origin charges and main freight |
| CIP, CIF | Origin charges, main freight and insurance |
| DAP, DPU | Everything except import clearance and duties |
| DDP | Everything |

This is a simplified commercial model. Actual sales contracts and local port
practice (for example, destination THC under CFR/CIF) can differ.

## Data and privacy

- Settings, uploaded rates, quotes and drafts are stored in your browser's
  `localStorage` only. Use **History → Backup JSON** to move them to another
  browser.
- A strict Content Security Policy limits scripts, styles and network requests
  to the app's own origin.

## Sample data

`data/sample-rates.csv` covers three lanes (Shanghai → Hamburg, Shanghai →
Los Angeles, Ho Chi Minh City → Los Angeles). It is **illustrative only**: the
carriers (SEA-ALPHA, AIR-BRAVO, …) are fictional and the prices are made up.
The default FX rates are rough placeholders too, so update them in Settings
before quoting.

## Disclaimer

QuoteCraft produces estimates. Confirm rates with your carriers, and confirm HS
classification and duty rates with your customs broker or the destination
country's tariff before you commit to a price.

## Third-party components

- [Fuse.js](https://www.fusejs.io/) 7.x (Apache-2.0), vendored in `vendor/fuse.min.js`.
- [SheetJS Community Edition](https://sheetjs.com/) 0.20.3 (Apache-2.0), vendored in
  `vendor/xlsx.mini.min.js`. It only loads when you upload an Excel file.
- HS code data in `data/hs-codes.json` comes from the
  [`datasets/harmonized-system`](https://github.com/datasets/harmonized-system)
  dataset (WCO HS 2022), licensed under
  [ODC-PDDL-1.0](https://opendatacommons.org/licenses/pddl/) (public domain).

## License

MIT. See `LICENSE`. The bundled third-party components keep their own licenses.
