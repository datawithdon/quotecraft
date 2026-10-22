import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// Load the vendored Fuse UMD build and stub fetch so js/hs.js runs under Node.
const ctx = {};
vm.runInNewContext(readFileSync(new URL("../vendor/fuse.min.js", import.meta.url), "utf8"), ctx);
globalThis.window = { Fuse: ctx.Fuse };
globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(readFileSync(new URL("../data/hs-codes.json", import.meta.url), "utf8")) });
const { searchHs, expandQuery } = await import("../js/hs.js");

// Spread into a local array: Fuse runs in a vm realm, so its arrays have a foreign prototype.
const top = async (q) => [...(await searchHs(q, 3))].map((r) => r.code);

test("synonym expansion", () => {
  assert.deepEqual(expandQuery("Mens leather Shoes"), ["leather", "footwear"]);
  assert.deepEqual(expandQuery("solar panels"), ["photovoltaic"]);
});

test("HS search finds common commodities", async () => {
  assert.ok((await top("cotton t-shirts")).includes("6109.10"));
  assert.ok((await top("laptop")).includes("8471.30"));
  assert.ok((await top("frozen shrimp")).includes("0306.17"));
  assert.ok((await top("solar panels")).includes("8541.43"));
  assert.ok((await searchHs("car tyres")).some((r) => r.code.startsWith("4011")));
  assert.deepEqual((await top("6109")).slice(0, 2), ["6109.10", "6109.90"]);
  assert.deepEqual(await top("a"), []);
});
