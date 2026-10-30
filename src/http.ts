import type { Config } from "./config.js";

// serializes requests with a min interval, times them out, and caches responses
// by url for a short TTL. No deps on purpose.
export class HttpClient {
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  // Map keeps insertion order, so the first key is always the oldest entry
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly config: Config) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.lastRequestAt + this.config.minRequestIntervalMs - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** Run fn serialized behind the throttle gate. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.throttle()).then(fn);
    // keep the chain alive regardless of individual failures
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private cacheGet<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private cacheSet(key: string, value: unknown): void {
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), value });
    while (this.cache.size > this.config.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * GET a JSON endpoint. `ttlMs` overrides the default cache TTL (0 disables
   * caching for this call).
   */
  async getJson<T>(url: string, opts?: { ttlMs?: number }): Promise<T> {
    const ttl = opts?.ttlMs ?? this.config.cacheTtlMs;
    if (ttl > 0) {
      const hit = this.cacheGet<T>(url, ttl);
      if (hit !== undefined) return hit;
    }

    const result = await this.serialize(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent": this.config.userAgent,
            accept: "application/json",
            "accept-language": "sv-SE,sv;q=0.9,en;q=0.8",
          },
          signal: controller.signal,
        });
        if (res.status === 404) throw new NotFoundError(url);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 300)}`);
        }
        // unknown /api/ paths fall through to the SPA and come back as a 200
        // html page, so check the content type instead of trusting the status
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("json")) {
          throw new Error(`Expected JSON from ${url} but got "${type}" (endpoint moved?)`);
        }
        const text = await res.text();
        // some endpoints answer an empty body instead of {} when params are wrong
        if (!text) throw new Error(`Empty response from ${url}`);
        return JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Request to ${url} timed out after ${this.config.requestTimeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });

    if (ttl > 0) this.cacheSet(url, result);
    return result;
  }
}

export class NotFoundError extends Error {
  constructor(readonly url: string) {
    super(`Not found: ${url}`);
    this.name = "NotFoundError";
  }
}
