import type { Config } from "../config.js";
import { HttpClient, NotFoundError } from "../http.js";
import {
  brandFacet,
  buildFilterParams,
  discountPercent,
  flattenCategories,
  htmlToText,
  matchCategory,
  parseProductId,
  priceRangeFacet,
  productUrl,
  storeQuantities,
  toAvailability,
  toMoney,
  toRating,
  toSortParam,
  toSpecifications,
  unixToIsoDate,
  type RawCategory,
  type RawFilter,
  type RawPrice,
  type RawSpec,
  type RawStock,
} from "../parse.js";
import {
  ProductDetailSchema,
  ProductSummarySchema,
  type CategoryNode,
  type DataProvider,
  type PriceInfo,
  type PriceSnapshot,
  type ProductDetail,
  type ProductSummary,
  type Review,
  type ReviewPage,
  type SearchFilters,
  type SearchResult,
  type StockInfo,
  type Store,
} from "../types.js";

/** The listing endpoints always return 24 products per page, there's no size param. */
const PAGE_SIZE = 24;
/** Store list barely ever changes, no point refetching it every minute. */
const STORES_TTL_MS = 6 * 60 * 60 * 1000;

// Talks to the JSON API behind webhallen.com's Vue storefront:
//   search:   GET /api/productdiscovery/search/<query>?page=&sortBy=&filters[n]=
//   category: GET /api/productdiscovery/category/<id>?page=&sortBy=&filters[n]=
//   product:  GET /api/product/<id>
//   reviews:  GET /api/reviews?product=<id>&page=&sortby=
//   stores:   GET /api/store/<country>
// No auth or special headers needed. Unknown /api/ paths return the SPA html
// with a 200, which HttpClient turns into an error.
export class RestProvider implements DataProvider {
  readonly name = "rest";
  private readonly http: HttpClient;

  constructor(private readonly config: Config) {
    this.http = new HttpClient(config);
  }

  private api(path: string, params?: URLSearchParams): string {
    const qs = params?.toString();
    return `${this.config.baseUrl}/api/${path}${qs ? `?${qs}` : ""}`;
  }

  async searchProducts(query: string, filters: SearchFilters): Promise<SearchResult> {
    return this.listing(`productdiscovery/search/${encodeURIComponent(query.trim())}`, filters);
  }

  async listCategory(categoryIdOrName: string, filters: SearchFilters): Promise<SearchResult & { category: CategoryNode }> {
    const category = await this.resolveCategory(categoryIdOrName);
    const result = await this.listing(`productdiscovery/category/${category.id}`, filters);
    // productCount from the name lookup only counts that search's hits, so it
    // would be misleading here. `total` is the real (filtered) count
    return { ...result, category: { ...category, productCount: null } };
  }

  async getProduct(idOrUrl: string): Promise<ProductDetail> {
    const raw = await this.fetchProduct(idOrUrl);
    const summary = this.toSummary(raw);
    if (!summary) throw new Error(`Product data for "${idOrUrl}" was missing required fields`);

    const candidate = {
      ...summary,
      brand: raw.manufacturer?.name ?? null,
      description: htmlToText(raw.description),
      partNumbers: raw.partNumbers ?? [],
      eans: raw.eans ?? [],
      releaseDate: unixToIsoDate(raw.release?.timestamp),
      categoryPath: (raw.mainCategoryPath ?? []).map((c) => c.name).filter((n): n is string => !!n),
      specifications: toSpecifications(raw.data),
      images: (raw.images ?? []).map((img) => img.large ?? img.zoom).filter((u): u is string => !!u),
      pricing: toPriceInfo(raw),
      stock: await this.toStockInfo(raw.stock),
    };
    const parsed = ProductDetailSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Product data for "${idOrUrl}" didn't validate: ${parsed.error.message.slice(0, 300)}`);
    }
    return parsed.data;
  }

  async getPriceSnapshot(idOrUrl: string): Promise<PriceSnapshot> {
    const raw = await this.fetchProduct(idOrUrl);
    const summary = this.toSummary(raw);
    if (!summary) throw new Error(`Product data for "${idOrUrl}" was missing required fields`);
    return {
      id: summary.id,
      name: summary.name,
      url: summary.url,
      availability: summary.availability,
      pricing: toPriceInfo(raw),
      stock: await this.toStockInfo(raw.stock),
    };
  }

  async getReviews(idOrUrl: string, page: number): Promise<ReviewPage> {
    const id = parseProductId(idOrUrl);
    // the site also sends sortby=latest|score|highest|lowest, but the api returns
    // the same order for all of them unless you're logged in, so not exposed
    const params = new URLSearchParams({ product: id, page: String(page) });
    let res: RawReviewResponse;
    try {
      res = await this.http.getJson<RawReviewResponse>(this.api("reviews", params));
    } catch (err) {
      // products with no reviews get an empty body back rather than a zero count
      if (err instanceof Error && err.message.startsWith("Empty response")) {
        return { productId: id, total: 0, page, nextPage: null, reviews: [] };
      }
      throw err;
    }

    const total = res.totalReviewCount ?? 0;
    const perPage = res.reviewsPerPage ?? 15;
    const reviews = (res.reviews ?? []).map(toReview).filter((r): r is Review => r !== null);
    return {
      productId: id,
      total,
      page,
      nextPage: page * perPage < total ? page + 1 : null,
      reviews,
    };
  }

  async listStores(): Promise<Store[]> {
    const res = await this.http.getJson<{ stores?: RawStore[] }>(this.api(`store/${this.config.country}`), {
      ttlMs: STORES_TTL_MS,
    });
    return (res.stores ?? [])
      .filter((s) => s.id != null && s.name)
      .map((s) => ({
        id: String(s.id),
        name: s.name!,
        city: s.city ?? null,
        address: s.address ?? null,
        zipCode: s.zipCode ?? null,
        isPickupPoint: !!s.isPickupPoint,
      }));
  }

  // --- internals ---------------------------------------------------------------

  private async listing(path: string, filters: SearchFilters): Promise<SearchResult> {
    const params = new URLSearchParams({ page: String(filters.page) });
    const sortBy = toSortParam(filters.sort);
    if (sortBy) params.set("sortBy", sortBy);
    buildFilterParams(filters).forEach((f, i) => params.set(`filters[${i}]`, f));

    const res = await this.http.getJson<RawListingResponse>(this.api(path, params));
    if (!Array.isArray(res.products)) {
      throw new Error(`Webhallen returned no product list for ${path}`);
    }

    const products = res.products
      .map((p) => this.toSummary(p))
      .filter((p): p is ProductSummary => p !== null);
    const total = res.filteredProductCount ?? res.totalProductCount ?? null;
    // fall back to "was the page full" when there's no total to compare against
    const hasMore = total != null ? filters.page * PAGE_SIZE < total : res.products.length >= PAGE_SIZE;

    return {
      products,
      total,
      page: filters.page,
      nextPage: hasMore ? filters.page + 1 : null,
      facets: {
        brands: brandFacet(res.filters),
        priceRange: priceRangeFacet(res.filters),
        categories: flattenCategories(Array.isArray(res.categories) ? null : res.categories),
      },
    };
  }

  private async resolveCategory(idOrName: string): Promise<CategoryNode> {
    const v = idOrName.trim();
    if (/^\d+$/.test(v)) return { id: v, name: v, productCount: null, path: [] };

    // no public category-by-name lookup, but a search for the name returns the
    // category tree of its hits, which is where the category usually is
    const search = await this.listing(`productdiscovery/search/${encodeURIComponent(v)}`, { page: 1 });
    const match = matchCategory(search.facets.categories, v);
    if (!match) {
      const seen = search.facets.categories.slice(0, 10).map((c) => `${c.name} (${c.id})`);
      throw new Error(
        `No category matching "${v}".` +
          (seen.length ? ` Categories seen for that search: ${seen.join(", ")}` : " Try search_products instead."),
      );
    }
    return match;
  }

  private async fetchProduct(idOrUrl: string): Promise<RawProduct> {
    const id = parseProductId(idOrUrl);
    try {
      const res = await this.http.getJson<{ product?: RawProduct }>(this.api(`product/${id}`));
      if (!res.product) throw new Error(`No product in response for "${idOrUrl}"`);
      return res.product;
    } catch (err) {
      if (err instanceof NotFoundError) throw new Error(`No Webhallen product with id ${id}`);
      throw err;
    }
  }

  private async toStockInfo(stock: RawStock | unknown[] | null | undefined): Promise<StockInfo> {
    const s = stock && !Array.isArray(stock) ? stock : null;
    const quantities = storeQuantities(s);
    // stock lookups shouldn't fail just because the store list did
    const stores = await this.listStores().catch(() => [] as Store[]);
    const byId = new Map(stores.map((st) => [st.id, st]));
    return {
      web: typeof s?.web === "number" ? s.web : 0,
      stores: [...quantities.entries()]
        .map(([storeId, quantity]) => ({
          storeId,
          name: byId.get(storeId)?.name ?? `Store ${storeId}`,
          city: byId.get(storeId)?.city ?? null,
          quantity,
        }))
        .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
      displayCap: typeof s?.displayCap === "number" ? s.displayCap : null,
    };
  }

  private toSummary(raw: RawProduct | null | undefined): ProductSummary | null {
    if (!raw || raw.id == null || !raw.name) return null;
    const price = toMoney(raw.price);
    const regular = toMoney(raw.regularPrice);
    const stock = raw.stock && !Array.isArray(raw.stock) ? raw.stock : null;
    const candidate = {
      id: String(raw.id),
      name: raw.name,
      subtitle: raw.subTitle ?? null,
      category: raw.categoryTree ?? null,
      url: productUrl(this.config.baseUrl, this.config.country, raw.id, raw.name),
      price,
      regularPrice: regular,
      onSale: raw.price?.type === "campaign" || discountPercent(price, regular) != null,
      rating: toRating(raw.averageRating),
      ratingCount: raw.reviewCount ?? null,
      availability: toAvailability({
        stock,
        discontinued: raw.discontinued,
        releaseTimestamp: raw.release?.timestamp,
      }),
      webStock: typeof stock?.web === "number" ? stock.web : null,
      imageUrl: raw.image ?? raw.images?.[0]?.large ?? null,
      isFyndware: !!raw.isFyndware,
    };
    const parsed = ProductSummarySchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
}

function toPriceInfo(raw: RawProduct): PriceInfo {
  const current = toMoney(raw.price);
  const regular = toMoney(raw.regularPrice);
  return {
    current,
    regular,
    lowest30Days: toMoney(raw.lowestPrice),
    onSale: raw.price?.type === "campaign" || discountPercent(current, regular) != null,
    discountPercent: discountPercent(current, regular),
    // regular prices have an endAt too (far in the future), only meaningful for campaigns
    campaignEndsAt: raw.price?.type === "campaign" ? raw.price.endAt ?? null : null,
    maxQtyPerCustomer: raw.price?.maxQtyPerCustomer ?? null,
  };
}

function toReview(r: RawReview): Review | null {
  if (r.id == null || r.isHype) return null;
  return {
    id: String(r.id),
    rating: r.rating ?? null,
    text: r.text ?? "",
    author: r.isAnonymous ? null : r.user?.username ?? null,
    verifiedPurchase: !!r.verifiedPurchase,
    upvotes: r.upvotes ?? 0,
    downvotes: r.downvotes ?? 0,
    createdAt: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null,
    productId: r.product?.id != null ? String(r.product.id) : null,
  };
}

// --- raw response shapes (only the parts we read) ------------------------------

interface RawProduct {
  id?: number;
  name?: string;
  subTitle?: string | null;
  categoryTree?: string | null;
  price?: RawPrice | null;
  regularPrice?: RawPrice | null;
  lowestPrice?: RawPrice | null;
  averageRating?: { rating?: string | number | null } | null;
  reviewCount?: number | null;
  // listing endpoints send an object, discontinued products send []
  stock?: RawStock | unknown[] | null;
  release?: { timestamp?: number } | null;
  discontinued?: number | boolean | null;
  image?: string | null;
  images?: { large?: string; zoom?: string; thumb?: string }[];
  isFyndware?: boolean;
  description?: string | null;
  manufacturer?: { name?: string } | null;
  partNumbers?: string[];
  eans?: string[];
  mainCategoryPath?: { name?: string }[];
  data?: Record<string, Record<string, RawSpec>> | unknown[] | null;
}

interface RawListingResponse {
  products?: RawProduct[];
  filters?: RawFilter[];
  // a tree on search, [] on category listings
  categories?: RawCategory | unknown[];
  filteredProductCount?: number | null;
  totalProductCount?: number | null;
}

interface RawReview {
  id?: number;
  text?: string;
  rating?: number;
  upvotes?: number;
  downvotes?: number;
  verifiedPurchase?: boolean;
  createdAt?: number;
  isAnonymous?: boolean;
  isHype?: boolean;
  product?: { id?: number };
  user?: { username?: string } | null;
}

interface RawReviewResponse {
  totalReviewCount?: number;
  reviewsPerPage?: number;
  reviews?: RawReview[];
}

interface RawStore {
  id?: number;
  name?: string;
  city?: string;
  address?: string;
  zipCode?: string;
  isPickupPoint?: boolean;
}
