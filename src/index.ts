#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { RestProvider } from "./providers/rest.js";
import { SearchFiltersSchema, SortOrderSchema, type DataProvider } from "./types.js";

const config = loadConfig();
const provider: DataProvider = new RestProvider(config);

const server = new McpServer({ name: "webhallen-mcp", version: "0.1.0" });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const sortDescription =
  "Sort order: relevance (default), popularity, price_asc, price_desc, rating, newest, discount";

// shared by search_products and list_category
const listingFilters = {
  sort: SortOrderSchema.optional().describe(sortDescription),
  minPrice: z.number().nonnegative().optional().describe("Minimum price in SEK"),
  maxPrice: z.number().nonnegative().optional().describe("Maximum price in SEK"),
  brands: z
    .array(z.string().min(1))
    .optional()
    .describe("Only these manufacturers (exact names as shown in the brands facet), e.g. ['Samsung', 'Kingston']"),
  inStock: z
    .string()
    .optional()
    .describe("Only products in stock: 'web' for online orders, or a store id from list_stores"),
  page: z.number().int().min(1).default(1).describe("Page number, 24 products per page"),
};

server.registerTool(
  "search_products",
  {
    title: "Search Webhallen products",
    description:
      "Search the Webhallen catalog by keyword (Swedish or English). Returns products with price (SEK), sale info, rating, availability and URL, plus brand/price/category facets and nextPage for paging. Filters are applied server-side.",
    inputSchema: {
      query: z.string().min(1).describe("Search keywords, e.g. 'nvme ssd 2tb' or 'mekaniskt tangentbord'"),
      ...listingFilters,
    },
  },
  async ({ query, ...rest }) => json(await provider.searchProducts(query, SearchFiltersSchema.parse(rest))),
);

server.registerTool(
  "list_category",
  {
    title: "Browse a Webhallen category",
    description:
      "Browse a product category by numeric id or by name (e.g. 'Intern M.2 SSD', 'Grafikkort'). Category names are Swedish; ids show up in search_products facets. Sorted and filterable like search, with brand facets to help refine.",
    inputSchema: {
      category: z.string().min(1).describe("Category id (e.g. '3002') or name (e.g. 'Grafikkort')"),
      ...listingFilters,
    },
  },
  async ({ category, ...rest }) => {
    const result = await provider.listCategory(category, SearchFiltersSchema.parse(rest));
    return json({
      category: result.category,
      total: result.total,
      page: result.page,
      nextPage: result.nextPage,
      brands: result.facets.brands,
      priceRange: result.facets.priceRange,
      products: result.products,
    });
  },
);

server.registerTool(
  "get_product",
  {
    title: "Get Webhallen product details",
    description:
      "Full details for one product by id or URL: description, specifications (grouped), part numbers/EAN, images, pricing (incl. lowest price last 30 days) and stock per store.",
    inputSchema: {
      idOrUrl: z.string().min(1).describe("Webhallen product id (e.g. '399175') or product URL"),
    },
  },
  async ({ idOrUrl }) => json(await provider.getProduct(idOrUrl)),
);

server.registerTool(
  "check_price_availability",
  {
    title: "Check price & availability",
    description:
      "Lightweight price + stock snapshot for one product: current/regular price, lowest price in the last 30 days, campaign end date, web stock and stock in each physical store. Handy for price tracking or finding a store to pick up from.",
    inputSchema: {
      idOrUrl: z.string().min(1).describe("Webhallen product id or URL"),
    },
  },
  async ({ idOrUrl }) => json(await provider.getPriceSnapshot(idOrUrl)),
);

server.registerTool(
  "compare_products",
  {
    title: "Compare Webhallen products",
    description:
      "Fetch full details for several products at once (by id or URL) for side-by-side comparison. Returns one detail object per input; one failing doesn't fail the rest.",
    inputSchema: {
      idsOrUrls: z.array(z.string().min(1)).min(2).max(8).describe("2-8 product ids or URLs to compare"),
    },
  },
  async ({ idsOrUrls }) => {
    // requests are serialized by the http client anyway, Promise.all just keeps
    // the code simple
    const results = await Promise.all(
      idsOrUrls.map(async (ref) => {
        try {
          return { ref, product: await provider.getProduct(ref) };
        } catch (err) {
          return { ref, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return json(results);
  },
);

server.registerTool(
  "get_reviews",
  {
    title: "Get product reviews",
    description:
      "Customer reviews for a product (mostly in Swedish), newest first, 15 per page. Reviews are shared across variants of the same product; productId says which variant a review was for.",
    inputSchema: {
      idOrUrl: z.string().min(1).describe("Webhallen product id or URL"),
      page: z.number().int().min(1).default(1),
    },
  },
  async ({ idOrUrl, page }) => json(await provider.getReviews(idOrUrl, page)),
);

server.registerTool(
  "list_stores",
  {
    title: "List Webhallen stores",
    description: "All physical Webhallen stores with id, name, city and address. Use the id with the inStock filter.",
    inputSchema: {},
  },
  async () => json(await provider.listStores()),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`webhallen-mcp running (base=${config.baseUrl}, provider=${provider.name})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
