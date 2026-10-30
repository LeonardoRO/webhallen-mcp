import { z } from "zod";

// Normalized models the tools work with. The provider maps the raw REST
// payloads into these so the rest of the code doesn't care about the wire format.

export const MoneySchema = z.object({
  amount: z.number(),
  currency: z.string().default("SEK"),
});
export type Money = z.infer<typeof MoneySchema>;

export const AvailabilitySchema = z.enum([
  "in_stock", // shippable from the web warehouse
  "in_store_only", // only on shelves in one or more physical stores
  "out_of_stock",
  "preorder", // release date is in the future
  "discontinued",
]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const ProductSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  url: z.string().url(),
  price: MoneySchema.nullable().optional(),
  regularPrice: MoneySchema.nullable().optional(),
  onSale: z.boolean().default(false),
  rating: z.number().nullable().optional(),
  ratingCount: z.number().nullable().optional(),
  availability: AvailabilitySchema,
  webStock: z.number().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  isFyndware: z.boolean().default(false),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const PriceInfoSchema = z.object({
  current: MoneySchema.nullable(),
  regular: MoneySchema.nullable(),
  // lowest price in the last 30 days, which Swedish shops have to show next to
  // a discount (EU Omnibus directive). closest thing to a price history here
  lowest30Days: MoneySchema.nullable(),
  onSale: z.boolean(),
  discountPercent: z.number().nullable(),
  campaignEndsAt: z.string().nullable(),
  maxQtyPerCustomer: z.number().nullable(),
});
export type PriceInfo = z.infer<typeof PriceInfoSchema>;

export const StoreStockSchema = z.object({
  storeId: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  quantity: z.number(),
});
export type StoreStock = z.infer<typeof StoreStockSchema>;

export const StockInfoSchema = z.object({
  web: z.number(),
  stores: z.array(StoreStockSchema),
  /** Quantities are capped at this value by the API ("50+"). */
  displayCap: z.number().nullable(),
});
export type StockInfo = z.infer<typeof StockInfoSchema>;

export const ProductDetailSchema = ProductSummarySchema.extend({
  brand: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  partNumbers: z.array(z.string()).default([]),
  eans: z.array(z.string()).default([]),
  releaseDate: z.string().nullable().optional(),
  categoryPath: z.array(z.string()).default([]),
  /** Spec group -> { attribute -> value }, e.g. { "Lagring": { "Kapacitet": "1 TB" } }. */
  specifications: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  images: z.array(z.string().url()).default([]),
  pricing: PriceInfoSchema,
  stock: StockInfoSchema,
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

/** Friendly sort keys, mapped to the API's sortBy values by the provider. */
export const SortOrderSchema = z
  .enum(["relevance", "popularity", "price_asc", "price_desc", "rating", "newest", "discount"])
  .default("relevance");
export type SortOrder = z.infer<typeof SortOrderSchema>;

export const SearchFiltersSchema = z.object({
  sort: SortOrderSchema.optional(),
  minPrice: z.number().nonnegative().optional(),
  maxPrice: z.number().nonnegative().optional(),
  /** Exact manufacturer names, OR-ed together. */
  brands: z.array(z.string().min(1)).optional(),
  /** "web" or a store id from list_stores. */
  inStock: z.string().optional(),
  page: z.number().int().min(1).default(1),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

// small price/stock view, for tracking without pulling the whole product
export interface PriceSnapshot {
  id: string;
  name: string;
  url: string;
  availability: Availability;
  pricing: PriceInfo;
  stock: StockInfo;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface CategoryNode {
  id: string;
  name: string;
  /** In search facets: how many of the search hits are in this category, not its total size. */
  productCount: number | null;
  /** Names from the top of the tree down to (and including) this node. */
  path: string[];
}

export interface SearchFacets {
  brands: FacetValue[];
  priceRange: { min: number; max: number } | null;
  categories: CategoryNode[];
}

export interface SearchResult {
  products: ProductSummary[];
  total: number | null;
  page: number;
  nextPage: number | null;
  facets: SearchFacets;
}

export interface Review {
  id: string;
  rating: number | null;
  text: string;
  author: string | null;
  verifiedPurchase: boolean;
  upvotes: number;
  downvotes: number;
  createdAt: string | null;
  /** Reviews are shared across variants, this says which one it was written for. */
  productId: string | null;
}

export interface ReviewPage {
  productId: string;
  total: number;
  page: number;
  nextPage: number | null;
  reviews: Review[];
}


export interface Store {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  isPickupPoint: boolean;
}

// kept as an interface so the data source can be swapped later if the internal
// API stops being usable. RestProvider is the only implementation right now.
export interface DataProvider {
  readonly name: string;
  searchProducts(query: string, filters: SearchFilters): Promise<SearchResult>;
  listCategory(categoryIdOrName: string, filters: SearchFilters): Promise<SearchResult & { category: CategoryNode }>;
  getProduct(idOrUrl: string): Promise<ProductDetail>;
  getPriceSnapshot(idOrUrl: string): Promise<PriceSnapshot>;
  getReviews(idOrUrl: string, page: number): Promise<ReviewPage>;
  listStores(): Promise<Store[]>;
}
