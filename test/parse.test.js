import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFilterParams,
  discountPercent,
  flattenCategories,
  htmlToText,
  matchCategory,
  parseProductId,
  productUrl,
  storeQuantities,
  toAvailability,
  toMoney,
  toSortParam,
  toSpecifications,
} from "../dist/parse.js";

test("parseProductId handles ids, slugs and urls", () => {
  assert.equal(parseProductId("399175"), "399175");
  assert.equal(parseProductId(" 399175 "), "399175");
  assert.equal(parseProductId("399175-Gigabyte-SSD-1TB"), "399175");
  assert.equal(parseProductId("https://www.webhallen.com/se/product/399175-Gigabyte-SSD-1TB"), "399175");
  assert.equal(parseProductId("https://www.webhallen.com/se/product/399175?foo=1"), "399175");
  assert.throws(() => parseProductId("gigabyte ssd"));
  // a number buried in a name isn't an id
  assert.throws(() => parseProductId("ssd-1tb"));
});

test("productUrl builds the same slug style as the site", () => {
  assert.equal(
    productUrl("https://www.webhallen.com", "se", 269878, 'Kingston A400 2.5" SATA (SA400S37/240G) - 240GB'),
    "https://www.webhallen.com/se/product/269878-Kingston-A400-2-5-SATA-SA400S37-240G-240GB",
  );
  assert.equal(
    productUrl("https://www.webhallen.com", "se", 1, "Hörlurar Åäö"),
    "https://www.webhallen.com/se/product/1-Horlurar-Aao",
  );
});

test("buildFilterParams encodes like the storefront", () => {
  assert.deepEqual(buildFilterParams({ page: 1 }), []);
  assert.deepEqual(buildFilterParams({ page: 1, brands: ["Kingston", "Samsung"], inStock: "web" }), [
    "brand-1-Kingston~Samsung",
    "custom.has_stock-1-web",
  ]);
  assert.deepEqual(buildFilterParams({ page: 1, minPrice: 999.5, maxPrice: 2000.2 }), ["price-3-999~2001"]);
  // open-ended ranges get padded
  assert.deepEqual(buildFilterParams({ page: 1, maxPrice: 500 }), ["price-3-0~500"]);
  assert.deepEqual(buildFilterParams({ page: 1, minPrice: 500 }), ["price-3-500~10000000"]);
});

test("toSortParam leaves relevance to the api default", () => {
  assert.equal(toSortParam(undefined), undefined);
  assert.equal(toSortParam("relevance"), undefined);
  assert.equal(toSortParam("price_asc"), "priceAsc");
  assert.equal(toSortParam("rating"), "reviewScore");
});

test("toMoney parses decimal strings", () => {
  assert.deepEqual(toMoney({ price: "1699.00", currency: "SEK" }), { amount: 1699, currency: "SEK" });
  assert.deepEqual(toMoney({ price: 10 }), { amount: 10, currency: "SEK" });
  assert.equal(toMoney(null), null);
  assert.equal(toMoney({ price: "n/a" }), null);
});

test("discountPercent only reports real discounts", () => {
  const m = (amount) => ({ amount, currency: "SEK" });
  assert.equal(discountPercent(m(1699), m(2099)), 19);
  assert.equal(discountPercent(m(2099), m(2099)), null);
  assert.equal(discountPercent(m(2500), m(2099)), null);
  assert.equal(discountPercent(null, m(2099)), null);
});

test("storeQuantities picks only numeric store keys", () => {
  const stock = { web: 16, displayCap: 50, supplyType: "STD", webStock: { 992: 16 }, 2: 0, 5: 3 };
  assert.deepEqual([...storeQuantities(stock).entries()], [["2", 0], ["5", 3]]);
  assert.equal(storeQuantities([]).size, 0);
  assert.equal(storeQuantities(null).size, 0);
});

test("toAvailability", () => {
  const now = Date.UTC(2026, 9, 30);
  assert.equal(toAvailability({ stock: { web: 2 }, now }), "in_stock");
  assert.equal(toAvailability({ stock: { web: 0, 5: 1 }, now }), "in_store_only");
  assert.equal(toAvailability({ stock: { web: 0 }, discontinued: 1, now }), "discontinued");
  assert.equal(toAvailability({ stock: [], releaseTimestamp: now / 1000 + 86400, now }), "preorder");
  assert.equal(toAvailability({ stock: { web: 0 }, releaseTimestamp: now / 1000 - 86400, now }), "out_of_stock");
  // stock beats discontinued, the last units are still sellable
  assert.equal(toAvailability({ stock: { web: 1 }, discontinued: 1, now }), "in_stock");
});

test("htmlToText strips tags and keeps list structure", () => {
  assert.equal(htmlToText(null), null);
  assert.equal(htmlToText('<img src="x">'), null);
  assert.equal(
    htmlToText("<ul><li>Fast</li><li>Quiet &amp; cool</li></ul><p>Hello<br>world</p><style>p{}</style>"),
    "- Fast\n- Quiet & cool\nHello\nworld",
  );
});

test("toSpecifications groups values and skips the Header group", () => {
  const data = {
    Header: { Märke: { name: "Märke", value: "GIGABYTE" } },
    Lagring: {
      Kapacitet: { name: "Kapacitet", value: "1 TB " },
      Tom: { name: "Tom", value: "" },
    },
    Tomt: {},
  };
  assert.deepEqual(toSpecifications(data), { Lagring: { Kapacitet: "1 TB" } });
  assert.deepEqual(toSpecifications([]), {});
});

// trimmed from a real /productdiscovery/search/grafikkort response
const grafikkortTree = {
  id: 0,
  name: "",
  children: [
    {
      id: "47",
      name: "Grafikkort / GPU",
      type: "c",
      productCount: 69,
      children: [
        { id: "4684", name: "GeForce RTX", type: "c", productCount: 47, children: [] },
        { id: "3031", name: "AMD Radeon", type: "c", productCount: 18, children: [] },
      ],
    },
    {
      id: "s41",
      name: "Datorkomponenter",
      type: "s",
      children: [{ id: "4818", name: "Grafikkort", type: "c", productCount: 7, children: [] }],
    },
  ],
};

test("flattenCategories keeps only browsable categories, with full paths", () => {
  const flat = flattenCategories(grafikkortTree);
  assert.deepEqual(
    flat.map((c) => c.id),
    ["47", "4684", "3031", "4818"],
  );
  assert.deepEqual(flat.find((c) => c.id === "4818").path, ["Datorkomponenter", "Grafikkort"]);
  assert.deepEqual(flattenCategories(null), []);
});

test("matchCategory prefers the bigger category among exact/alias matches", () => {
  const flat = flattenCategories(grafikkortTree);
  assert.equal(matchCategory(flat, "grafikkort").id, "47");
  assert.equal(matchCategory(flat, "GPU").id, "47");
  assert.equal(matchCategory(flat, "radeon").id, "3031");
  assert.equal(matchCategory(flat, "billiga geforce rtx kort").id, "4684");
  assert.equal(matchCategory(flat, "tangentbord"), null);
});
