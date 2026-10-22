// HS code lookup over the bundled WCO HS 2022 6-digit nomenclature.
// The ~2 MB dataset is only fetched the first time the search box is used.

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
          threshold: 0.35,
          ignoreLocation: true,
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
  return f.search(q, { limit }).map((r) => r.item);
}
