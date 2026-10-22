// HS code lookup over the bundled WCO HS 2022 6-digit nomenclature.
// The ~2 MB dataset is only fetched the first time the search box is used.

// Everyday words → the formal wording the HS nomenclature uses.
export const SYNONYMS = {
  laptop: "data processing portable", laptops: "data processing portable", notebook: "data processing portable",
  computer: "data processing", computers: "data processing", pc: "data processing",
  phone: "telephone", phones: "telephone", smartphone: "telephone", smartphones: "telephone", mobile: "telephone",
  tv: "television", tvs: "television",
  shoe: "footwear", shoes: "footwear", sneakers: "footwear", boots: "footwear", sandals: "footwear",
  solar: "photovoltaic", panel: "", panels: "",
  car: "motor", cars: "motor", truck: "motor vehicles goods", trucks: "motor vehicles goods", tire: "tyres", tires: "tyres",
  bike: "bicycles", bikes: "bicycles", bicycle: "bicycles",
  tshirt: "t-shirts", tshirts: "t-shirts", tee: "t-shirts", tees: "t-shirts",
  jeans: "trousers denim", pants: "trousers",
  sofa: "seats upholstered", chair: "seats", chairs: "seats",
  mens: "", womens: "", "men's": "", "women's": "",
};

export function expandQuery(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean)
    .flatMap((w) => (Object.hasOwn(SYNONYMS, w) ? SYNONYMS[w].split(" ") : [w]))
    .map((w) => w.replace(/[|'!^=$"]/g, ""))
    .filter((w) => w.length > 0);
}

let fuse = null;
let loading = null;

function ensureLoaded() {
  if (fuse) return Promise.resolve(fuse);
  if (!loading) {
    loading = fetch("data/hs-codes.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        // Fuse is loaded as a classic script (vendor/fuse.min.js).
        fuse = new window.Fuse(data, {
          keys: [
            { name: "description", weight: 0.6 },
            { name: "heading", weight: 0.3 },
            { name: "code", weight: 0.1 },
            { name: "rawCode", weight: 0.1 },
          ],
          threshold: 0.3,
          ignoreLocation: true,
          useExtendedSearch: true,
          minMatchCharLength: 2,
        });
        return fuse;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export async function searchHs(query, limit = 12) {
  const q = query.trim();
  if (q.length < 2) return [];
  const f = await ensureLoaded();
  // Extended search: space-separated terms are ANDed, each matched fuzzily.
  const terms = expandQuery(q);
  let results = terms.length ? f.search(terms.join(" "), { limit }) : [];
  // If every word together finds nothing, fall back to matching any of them.
  if (!results.length && terms.length > 1) results = f.search(terms.join(" | "), { limit });
  return results.map((r) => r.item);
}
