// Pure helpers for turning Webhallen's wire format into the normalized models.
// Kept free of I/O so they can be unit tested against captured payloads.

import type { Availability, CategoryNode, FacetValue, Money, SearchFilters, SortOrder } from "./types.js";

/** Map friendly sort keys to the API's sortBy values. undefined = API default. */
const SORT_MAP: Record<SortOrder, string | undefined> = {
  relevance: undefined,
  popularity: "popularity",
  price_asc: "priceAsc",
  price_desc: "priceDesc",
  rating: "reviewScore",
  newest: "latest",
  discount: "highestDiscountPercent",
};

export function toSortParam(sort: SortOrder | undefined): string | undefined {
  return SORT_MAP[sort ?? "relevance"];
}

// Filters go out as `filters[n]=<attributeId>-<filterType>-<v1~v2~...>`, same as
// the storefront builds them. type 1 = multi-select, 3 = numeric range.
export function buildFilterParams(f: SearchFilters): string[] {
  const out: string[] = [];
  if (f.brands?.length) out.push(`brand-1-${f.brands.join("~")}`);
  if (f.minPrice != null || f.maxPrice != null) {
    // the range filter needs both ends, so pad the open side
    const min = Math.floor(f.minPrice ?? 0);
    const max = Math.ceil(f.maxPrice ?? 10_000_000);
    out.push(`price-3-${min}~${max}`);
  }
  if (f.inStock) out.push(`custom.has_stock-1-${f.inStock}`);
  return out;
}

/** Accepts a bare id ("399175"), a "id-slug" path segment, or a full product URL. */
export function parseProductId(idOrUrl: string): string {
  const v = idOrUrl.trim();
  const fromUrl = v.match(/\/product\/(\d+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  const leading = v.match(/^(\d+)(?:-|$)/);
  if (leading?.[1]) return leading[1];
  throw new Error(`Can't find a Webhallen product id in "${idOrUrl}"`);
}

/** Same shape as the site's own links. The slug part is cosmetic, the router only reads the id. */
export function productUrl(baseUrl: string, country: string, id: string | number, name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseUrl}/${country}/product/${id}${slug ? `-${slug}` : ""}`;
}

export interface RawPrice {
  price?: string | number | null;
  currency?: string | null;
  type?: string | null;
  endAt?: string | null;
  maxQtyPerCustomer?: number | null;
}

/** Prices come back as decimal strings ("1699.00"). */
export function toMoney(p: RawPrice | null | undefined): Money | null {
  if (!p || p.price == null) return null;
  const amount = typeof p.price === "number" ? p.price : Number.parseFloat(p.price);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: p.currency ?? "SEK" };
}

export function discountPercent(current: Money | null, regular: Money | null): number | null {
  if (!current || !regular || regular.amount <= 0 || current.amount >= regular.amount) return null;
  return Math.round((1 - current.amount / regular.amount) * 100);
}

/** averageRating is `{ rating: "4.5", ratingType }` or null. */
export function toRating(raw: { rating?: string | number | null } | null | undefined): number | null {
  if (raw?.rating == null) return null;
  const n = typeof raw.rating === "number" ? raw.rating : Number.parseFloat(raw.rating);
  return Number.isFinite(n) ? n : null;
}

// stock is a flat object: { web: 16, "2": 0, "5": 3, ..., displayCap, supplyType, webStock: {...} }
// where numeric keys are store ids. webStock is per-warehouse and we ignore it.
export interface RawStock {
  web?: number;
  displayCap?: number;
  [key: string]: unknown;
}

export function storeQuantities(stock: RawStock | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!stock || Array.isArray(stock)) return out;
  for (const [key, value] of Object.entries(stock)) {
    if (/^\d+$/.test(key) && typeof value === "number") out.set(key, value);
  }
  return out;
}

export function toAvailability(input: {
  stock: RawStock | null | undefined;
  discontinued?: number | boolean | null;
  releaseTimestamp?: number | null;
  now?: number;
}): Availability {
  const web = typeof input.stock?.web === "number" ? input.stock.web : 0;
  if (web > 0) return "in_stock";
  const inStore = [...storeQuantities(input.stock).values()].some((q) => q > 0);
  if (inStore) return "in_store_only";
  if (input.discontinued) return "discontinued";
  const now = input.now ?? Date.now();
  if (input.releaseTimestamp && input.releaseTimestamp * 1000 > now) return "preorder";
  return "out_of_stock";
}

export function unixToIsoDate(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Descriptions are vendor HTML (sometimes nothing but <img> tags). Good enough
// for an LLM to read; not trying to be a real HTML parser.
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

export interface RawSpec {
  name?: string;
  value?: string | null;
}

export function toSpecifications(
  data: Record<string, Record<string, RawSpec>> | unknown[] | null | undefined,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  // products without spec data send [] instead of {}
  if (!data || Array.isArray(data)) return out;
  for (const [group, attrs] of Object.entries(data)) {
    // "Header" just repeats brand/qty/manufacturer that we already expose
    if (group === "Header" || !attrs || typeof attrs !== "object") continue;
    const values: Record<string, string> = {};
    for (const [key, spec] of Object.entries(attrs)) {
      const v = spec?.value?.trim();
      if (v) values[spec.name ?? key] = v;
    }
    if (Object.keys(values).length) out[group] = values;
  }
  return out;
}

export interface RawFilter {
  id?: string;
  min?: number | null;
  max?: number | null;
  values?: { value?: string; count?: number }[];
}

export function brandFacet(filters: RawFilter[] | null | undefined): FacetValue[] {
  const brand = filters?.find((f) => f.id === "brand");
  return (brand?.values ?? [])
    .filter((v): v is { value: string; count: number } => !!v.value)
    .map((v) => ({ value: v.value, count: v.count ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

export function priceRangeFacet(filters: RawFilter[] | null | undefined): { min: number; max: number } | null {
  const price = filters?.find((f) => f.id === "price");
  if (price?.min == null || price.max == null) return null;
  return { min: price.min, max: price.max };
}

export interface RawCategory {
  id?: string | number;
  name?: string;
  type?: string;
  productCount?: number;
  children?: RawCategory[];
}

// The search response has a tree rooted at an unnamed node. Sections ("s41")
// can't be browsed through the category endpoint, so only real categories
// (type "c") are returned, but section names are kept in the path.
export function flattenCategories(root: RawCategory | null | undefined): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (node: RawCategory, path: string[]) => {
    const here = node.name ? [...path, node.name] : path;
    if (node.type === "c" && node.id != null && node.name) {
      out.push({ id: String(node.id), name: node.name, productCount: node.productCount ?? null, path: here });
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  if (root) walk(root, []);
  return out;
}

/**
 * Pick the category that best matches a free-text name: exact match first,
 * then the shortest name containing the term, then any containing it the other
 * way round. Ties go to the one with more products.
 */
export function matchCategory(categories: CategoryNode[], name: string): CategoryNode | null {
  const term = name.trim().toLowerCase();
  const byCount = (a: CategoryNode, b: CategoryNode) => (b.productCount ?? 0) - (a.productCount ?? 0);

  // some names are aliases joined with a slash ("Grafikkort / GPU"), and the
  // main category often has one of those while a small duplicate has the bare
  // name (e.g. Datorkomponenter/Grafikkort with a handful of products). treat
  // both as exact and let the product count decide
  const exact = categories
    .filter((c) => {
      const n = c.name.toLowerCase();
      return n === term || n.split(/\s*\/\s*/).includes(term);
    })
    .sort(byCount);
  if (exact[0]) return exact[0];

  const containing = categories
    .filter((c) => c.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.length - b.name.length || byCount(a, b));
  if (containing[0]) return containing[0];

  const contained = categories.filter((c) => term.includes(c.name.toLowerCase())).sort(byCount);
  return contained[0] ?? null;
}
