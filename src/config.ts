export interface Config {
  /** Storefront origin, e.g. "https://www.webhallen.com". */
  baseUrl: string;
  /** Country segment used in product URLs and the store list ("se"). */
  country: string;
  /** min delay between outbound requests, ms */
  minRequestIntervalMs: number;
  /** Per-request timeout, ms. */
  requestTimeoutMs: number;
  /** In-memory cache TTL for product/search responses, ms. */
  cacheTtlMs: number;
  /** Max cached responses before the oldest get dropped. */
  cacheMaxEntries: number;
  /** User-Agent sent with requests. */
  userAgent: string;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  return {
    baseUrl: (process.env.WEBHALLEN_BASE_URL ?? "https://www.webhallen.com").replace(/\/+$/, ""),
    country: process.env.WEBHALLEN_COUNTRY ?? "se",
    minRequestIntervalMs: envNumber("WEBHALLEN_MIN_INTERVAL_MS", 500),
    requestTimeoutMs: envNumber("WEBHALLEN_TIMEOUT_MS", 15000),
    cacheTtlMs: envNumber("WEBHALLEN_CACHE_TTL_MS", 60_000),
    cacheMaxEntries: envNumber("WEBHALLEN_CACHE_MAX_ENTRIES", 500),
    userAgent:
      process.env.WEBHALLEN_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}
