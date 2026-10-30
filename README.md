# webhallen-mcp

An **unofficial** [Model Context Protocol](https://modelcontextprotocol.io) server that lets
AI assistants (Claude, ChatGPT, and any other MCP client) search products, check prices and
store stock, and read reviews on [Webhallen](https://www.webhallen.com), the Swedish
electronics and gaming retailer.

> ⚠️ **Unofficial / use at your own risk.** Webhallen does not offer a public API. This server
> talks to the same internal JSON endpoints their website uses, so there's no stability
> guarantee: Webhallen can change or block them at any time. Respect their
> [Terms of Service](https://www.webhallen.com/) and `robots.txt`, keep
> request volume low, and don't use this to resell their data. Provided as-is under the MIT
> license with no affiliation to Webhallen Sverige AB.

## Tools

| Tool | Description |
| --- | --- |
| `search_products` | Search the catalog by keyword. Returns name, price (SEK), sale info, rating, availability, image and URL, plus brand / price-range / category facets and `nextPage`. Supports `sort` (relevance/popularity/price_asc/price_desc/rating/newest/discount) and `minPrice` / `maxPrice` / `brands` / `inStock` filters, all applied server-side. |
| `list_category` | Browse a category by id or by (Swedish) name, e.g. `Grafikkort`. Same sorting and filters as search. |
| `get_product` | Full details for one product by id or URL: description, grouped specifications, part numbers / EAN, images, pricing and stock per store. |
| `check_price_availability` | Lightweight price + stock snapshot: current vs regular price, **lowest price in the last 30 days**, campaign end date, web stock and stock in each physical store. |
| `compare_products` | Full details for 2–8 products at once for side-by-side comparison. |
| `get_reviews` | Customer reviews for a product, paginated. |
| `list_stores` | Physical stores with id, name, city and address (ids work with the `inStock` filter). |

## How it works

webhallen.com is a Vue SPA on top of a plain JSON REST API under `/api/`. No auth or special
headers are needed for catalog data:

- **Search** → `GET /api/productdiscovery/search/<query>?page=&sortBy=&filters[n]=`
- **Category** → `GET /api/productdiscovery/category/<id>?page=&sortBy=&filters[n]=`
- **Product** → `GET /api/product/<id>`
- **Reviews** → `GET /api/reviews?product=<id>&page=`
- **Stores** → `GET /api/store/se`

Filters use the same encoding the storefront builds, `<attribute>-<type>-<v1~v2>`, e.g.
`brand-1-Kingston~Samsung`, `price-3-1000~2000` or `custom.has_stock-1-web`, so filtering
happens on Webhallen's side and pages come back full.

Some things worth knowing about the API:

- Unknown `/api/` paths don't 404, they return the SPA's HTML with a `200`. The HTTP client
  checks the content type, so a moved endpoint shows up as a clear error instead of a JSON
  parse failure.
- Listing endpoints always return 24 products per page; there's no page-size parameter.
- `stock` is a flat object where numeric keys are store ids (`{ "web": 16, "2": 0, "5": 3, ... }`),
  and quantities are capped at `displayCap` (50).
- Instead of a price history, Webhallen exposes `lowestPrice`: the lowest price in the last 30
  days, which Swedish shops have to show next to a discount (EU Omnibus directive).
- There's no category-by-name endpoint, so `list_category` searches for the name and picks the
  best match from the category tree that comes back with the results.

Every request goes through a small rate limiter, a bounded short-lived response cache, and a
timeout.

## Install

```bash
npm install
npm run build
```

## Use with Claude Code

```bash
claude mcp add webhallen -- node /absolute/path/to/webhallen-mcp/dist/index.js
```

## Use with Claude Desktop / other MCP clients

Add to your client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webhallen": {
      "command": "node",
      "args": ["/absolute/path/to/webhallen-mcp/dist/index.js"]
    }
  }
}
```

## Configuration (env vars)

| Variable | Default | Notes |
| --- | --- | --- |
| `WEBHALLEN_BASE_URL` | `https://www.webhallen.com` | storefront origin |
| `WEBHALLEN_COUNTRY` | `se` | country segment for URLs and the store list |
| `WEBHALLEN_MIN_INTERVAL_MS` | `500` | min delay between requests |
| `WEBHALLEN_CACHE_TTL_MS` | `60000` | response cache TTL (store list is cached for 6h) |
| `WEBHALLEN_CACHE_MAX_ENTRIES` | `500` | oldest entries are dropped past this |
| `WEBHALLEN_TIMEOUT_MS` | `15000` | per-request timeout |
| `WEBHALLEN_USER_AGENT` | Chrome UA | sent with every request |

## Development

```bash
npm test        # builds, then runs the unit tests in test/
npm run dev     # tsc --watch
```

The tests cover the parsing/mapping layer (`src/parse.ts`) against payloads captured from the
live API, so they run offline.

## Project layout

```
src/
  index.ts            MCP server + tool registration
  config.ts           env-driven config (base url, rate limits, cache)
  types.ts            normalized models + DataProvider interface
  http.ts             HTTP client (throttle + cache + timeout)
  parse.ts            pure helpers mapping the wire format to the models
  providers/
    rest.ts           internal REST API provider
test/
  parse.test.js       unit tests for parse.ts
```

The tools talk to a `DataProvider` interface rather than the REST client directly, so the
data source can be swapped out later if the internal API stops working.

## License

MIT
