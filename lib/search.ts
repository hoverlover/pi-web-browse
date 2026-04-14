import { getCheerio } from "./deps.js";
import { safeFetch } from "./safe-fetch.js";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchProvider {
	name: string;
	isAvailable(): Promise<boolean>;
	search(query: string, numResults: number, signal: AbortSignal | undefined): Promise<WebSearchResult[]>;
}

// ---------------------------------------------------------------------------
// Brave Search (https://api.search.brave.com) — requires BRAVE_API_KEY
// ---------------------------------------------------------------------------

interface BraveResponse {
	web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

export const braveProvider: SearchProvider = {
	name: "brave",
	async isAvailable() {
		return !!process.env.BRAVE_API_KEY;
	},
	async search(query, numResults, signal) {
		const key = process.env.BRAVE_API_KEY;
		if (!key) throw new Error("BRAVE_API_KEY not set");
		const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;
		const response = await fetch(url, {
			signal,
			headers: { Accept: "application/json", "X-Subscription-Token": key },
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Brave search failed: ${response.status} ${body}`);
		}
		const data = (await response.json()) as BraveResponse;
		const results = data.web?.results ?? [];
		return results
			.slice(0, numResults)
			.filter((r) => r.title && r.url)
			.map((r) => ({ title: r.title!, url: r.url!, snippet: r.description ?? "" }));
	},
};

// ---------------------------------------------------------------------------
// Serper (https://serper.dev) — requires SERPER_API_KEY
// ---------------------------------------------------------------------------

interface SerperResponse {
	organic?: Array<{ title?: string; link?: string; snippet?: string }>;
}

export const serperProvider: SearchProvider = {
	name: "serper",
	async isAvailable() {
		return !!process.env.SERPER_API_KEY;
	},
	async search(query, numResults, signal) {
		const key = process.env.SERPER_API_KEY;
		if (!key) throw new Error("SERPER_API_KEY not set");
		const response = await fetch("https://google.serper.dev/search", {
			method: "POST",
			signal,
			headers: { "X-API-KEY": key, "Content-Type": "application/json" },
			body: JSON.stringify({ q: query, num: numResults }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Serper search failed: ${response.status} ${body}`);
		}
		const data = (await response.json()) as SerperResponse;
		return (data.organic ?? [])
			.slice(0, numResults)
			.filter((r) => r.title && r.link)
			.map((r) => ({ title: r.title!, url: r.link!, snippet: r.snippet ?? "" }));
	},
};

// ---------------------------------------------------------------------------
// Tavily (https://tavily.com) — requires TAVILY_API_KEY
// ---------------------------------------------------------------------------

interface TavilyResponse {
	results?: Array<{ title?: string; url?: string; content?: string }>;
}

export const tavilyProvider: SearchProvider = {
	name: "tavily",
	async isAvailable() {
		return !!process.env.TAVILY_API_KEY;
	},
	async search(query, numResults, signal) {
		const key = process.env.TAVILY_API_KEY;
		if (!key) throw new Error("TAVILY_API_KEY not set");
		const response = await fetch("https://api.tavily.com/search", {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: key, query, max_results: numResults }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Tavily search failed: ${response.status} ${body}`);
		}
		const data = (await response.json()) as TavilyResponse;
		return (data.results ?? [])
			.slice(0, numResults)
			.filter((r) => r.title && r.url)
			.map((r) => ({ title: r.title!, url: r.url!, snippet: r.content ?? "" }));
	},
};

// ---------------------------------------------------------------------------
// DuckDuckGo (no API key) — HTML scraping, fragile by nature.
// ---------------------------------------------------------------------------

type DuckSelectors = { container: string; title: string; snippet: string };

const DUCK_SELECTORS: DuckSelectors[] = [
	{ container: ".web-result", title: ".result__a", snippet: ".result__snippet" },
	{
		container: ".result",
		title: "a.result__a, h2 a, .result__title a",
		snippet: ".result__snippet, .result__snippet a, .web-result__snippet",
	},
];

function decodeDuckHref(href: string): string {
	if (!href.includes("duckduckgo.com/l/?")) return href;
	const m = href.match(/uddg=([^&]+)/);
	if (!m) return href;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return href;
	}
}

function parseDuck(html: string, selectors: DuckSelectors, numResults: number, cheerio: typeof import("cheerio")): WebSearchResult[] {
	const $ = cheerio.load(html);
	const results: WebSearchResult[] = [];
	$(selectors.container).each((_, el) => {
		if (results.length >= numResults) return false;
		const $el = $(el);
		const titleEl = $el.find(selectors.title).first();
		const title = titleEl.text().trim();
		const href = titleEl.attr("href");
		const snippet = $el.find(selectors.snippet).first().text().trim();
		if (!title || !href) return;
		// Accept absolute URLs and DuckDuckGo protocol-relative redirects.
		const isAbsolute = /^https?:\/\//i.test(href);
		const isDuckRedirect = href.startsWith("//duckduckgo.com/l/");
		if (!isAbsolute && !isDuckRedirect) return;
		results.push({ title, url: decodeDuckHref(href), snippet });
	});
	return results;
}

export const duckDuckGoProvider: SearchProvider = {
	name: "duckduckgo",
	async isAvailable() {
		return true;
	},
	async search(query, numResults, signal) {
		const cheerio = await getCheerio();
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const response = await safeFetch(url, {
			signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				Accept: "text/html",
			},
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Search failed: ${response.status} ${response.statusText}`);
		}
		for (const sel of DUCK_SELECTORS) {
			const results = parseDuck(response.body, sel, numResults, cheerio);
			if (results.length > 0) return results;
		}
		return [];
	},
};

// ---------------------------------------------------------------------------
// Public API: pluggable provider selection.
// ---------------------------------------------------------------------------

export const SEARCH_PROVIDERS: SearchProvider[] = [
	braveProvider,
	serperProvider,
	tavilyProvider,
	duckDuckGoProvider,
];

export async function resolveSearchProvider(preferred?: string): Promise<SearchProvider> {
	if (preferred) {
		const match = SEARCH_PROVIDERS.find((p) => p.name === preferred);
		if (!match) throw new Error(`Unknown search provider: ${preferred}`);
		if (!(await match.isAvailable())) {
			throw new Error(`Search provider "${preferred}" is not configured (missing API key)`);
		}
		return match;
	}
	for (const provider of SEARCH_PROVIDERS) {
		if (await provider.isAvailable()) return provider;
	}
	return duckDuckGoProvider;
}

/** Back-compat helper used by tests. */
export async function searchDuckDuckGo(
	query: string,
	numResults: number,
	signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
	return duckDuckGoProvider.search(query, numResults, signal);
}
