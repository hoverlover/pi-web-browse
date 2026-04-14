/**
 * Web Browsing Extension for pi
 *
 * Tools:
 * - web_fetch: Fetch a URL and extract content as HTML, markdown, or text.
 *   - Uses Firecrawl API if FIRECRAWL_API_KEY is set (preferred).
 *   - Otherwise falls back to local cheerio+turndown extraction.
 * - web_search: Search the web via a pluggable provider (Brave, Serper,
 *   Tavily, or DuckDuckGo). The first provider with a configured API key is
 *   used; DuckDuckGo is the keyless fallback.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import { getConfigPath, getFirecrawlApiKey, hasFirecrawlKey, maskKey, resetConfigCache } from "../lib/config.js";
import { resetDepsCache } from "../lib/deps.js";
import { fetchWithFirecrawl } from "../lib/firecrawl.js";
import { fetchWebPageLocal } from "../lib/local-extract.js";
import { SEARCH_PROVIDERS, WebSearchResult, resolveSearchProvider } from "../lib/search.js";

// Re-exports for tests and downstream consumers.
export { fetchWithFirecrawl } from "../lib/firecrawl.js";
export { extractReadableText, fetchWebPageLocal, htmlToMarkdownLocal } from "../lib/local-extract.js";
export { searchDuckDuckGo } from "../lib/search.js";
export { hasFirecrawlKey } from "../lib/config.js";

export function resetTestState(): void {
	resetDepsCache();
	resetConfigCache();
}

// ============================================================================
// Web Fetch
// ============================================================================

const DEFAULT_MAX_LENGTH = 10_000;
const TRUNCATION_SUFFIX = "\n\n[Content truncated...]";

const WebFetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	format: Type.Optional(
		StringEnum(["markdown", "text", "html"] as const),
		{ description: "Output format (default: markdown)" },
	),
	selector: Type.Optional(
		Type.String({
			description:
				"CSS selector to extract specific content (e.g., 'article', '.content'). Only applies to local extraction.",
		}),
	),
	maxLength: Type.Optional(
		Type.Number({ description: `Maximum characters to return (default: ${DEFAULT_MAX_LENGTH})` }),
	),
	useFirecrawl: Type.Optional(
		Type.Boolean({
			description:
				"Use Firecrawl API (requires FIRECRAWL_API_KEY). Default: true if key is available, false otherwise.",
		}),
	),
});

type WebFetchDetails = {
	url: string;
	format: "markdown" | "text" | "html";
	statusCode: number;
	selector?: string;
	truncated: boolean;
	contentLength: number;
	source: "firecrawl" | "local";
	error?: string;
};

function truncate(content: string, maxLength: number): { content: string; truncated: boolean } {
	if (content.length <= maxLength) return { content, truncated: false };
	const head = Math.max(0, maxLength - TRUNCATION_SUFFIX.length);
	return { content: content.substring(0, head) + TRUNCATION_SUFFIX, truncated: true };
}

export type FetchProgress = (message: string, partialDetails: Partial<WebFetchDetails>) => void;

export async function fetchWebPage(
	url: string,
	format: "markdown" | "text" | "html",
	selector: string | undefined,
	maxLength: number,
	useFirecrawl: boolean | undefined,
	signal: AbortSignal | undefined,
	onProgress?: FetchProgress,
): Promise<{ content: string; details: WebFetchDetails }> {
	const firecrawlAvailable = await hasFirecrawlKey();
	const shouldUseFirecrawl = useFirecrawl !== false && firecrawlAvailable;

	let content: string;
	let source: "firecrawl" | "local";
	let statusCode: number;

	if (shouldUseFirecrawl) {
		onProgress?.("Fetching via Firecrawl…", { url, format, source: "firecrawl" });
		try {
			const result = await fetchWithFirecrawl(url, format, signal);
			content = result.content;
			source = result.source;
			statusCode = result.status;
		} catch (error) {
			if (useFirecrawl === true) throw error;
			onProgress?.("Firecrawl failed, falling back to local extraction…", {
				url,
				format,
				source: "local",
			});
			const local = await fetchWebPageLocal(url, format, selector, signal);
			content = local.content;
			source = local.source;
			statusCode = local.status;
		}
	} else {
		onProgress?.("Fetching page…", { url, format, source: "local" });
		const local = await fetchWebPageLocal(url, format, selector, signal);
		content = local.content;
		source = local.source;
		statusCode = local.status;
	}

	onProgress?.("Processing content…", { url, format, source, statusCode });

	const { content: final, truncated } = truncate(content, maxLength);

	return {
		content: final,
		details: {
			url,
			format,
			statusCode,
			selector,
			truncated,
			contentLength: final.length,
			source,
		},
	};
}

// ============================================================================
// Web Search
// ============================================================================

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(
		Type.Number({ description: "Number of results (default: 5, max: 10)" }),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Force a specific provider: 'brave', 'serper', 'tavily', or 'duckduckgo'. Defaults to the first provider with a configured API key (DuckDuckGo if none).",
		}),
	),
});

type WebSearchDetails = {
	query: string;
	numResults: number;
	provider: string;
	results: WebSearchResult[];
	error?: string;
};

// ============================================================================
// Extension entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	hasFirecrawlKey().then((available) => {
		if (available) {
			console.log("[web-browse] Firecrawl API detected — using it for content extraction");
		}
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch and extract content from a web page.

Parameters:
- url: The URL to fetch
- format: Output format — "markdown" (default), "text", or "html"
- selector: Optional CSS selector (local extraction only)
- maxLength: Maximum characters to return (default: ${DEFAULT_MAX_LENGTH})
- useFirecrawl: Use Firecrawl API (default: true if key is available)

Safety: requests are limited to http(s), block private/loopback addresses,
time out after 30s, and cap bodies at ${formatSize(DEFAULT_MAX_BYTES)}.

Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const format = params.format || "markdown";
			const maxLength = params.maxLength || DEFAULT_MAX_LENGTH;

			const emit: FetchProgress | undefined = onUpdate
				? (message, partial) => {
					const details: WebFetchDetails = {
						url: params.url,
						format,
						statusCode: 0,
						selector: params.selector,
						truncated: false,
						contentLength: 0,
						source: "local",
						...partial,
					};
					onUpdate({
						content: [{ type: "text", text: message }],
						details,
					});
				}
				: undefined;

			try {
				const result = await fetchWebPage(
					params.url,
					format,
					params.selector,
					maxLength,
					params.useFirecrawl,
					signal,
					emit,
				);
				return {
					content: [{ type: "text", text: result.content }],
					details: result.details,
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error fetching page: ${errorMsg}` }],
					details: {
						url: params.url,
						format,
						statusCode: 0,
						truncated: false,
						contentLength: 0,
						source: "local",
						error: errorMsg,
					} as WebFetchDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url);
			if (args.format && args.format !== "markdown") text += theme.fg("dim", ` as ${args.format}`);
			if (args.selector) text += theme.fg("muted", ` [${args.selector}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as WebFetchDetails | undefined;
			if (!details) return new Text(theme.fg("error", "Error: Missing result details"), 0, 0);
			if (details.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);

			let text = theme.fg("success", "✓ Fetched ");
			text += theme.fg("accent", details.url);
			text += theme.fg("muted", ` (${details.format})`);
			text += details.source === "firecrawl" ? theme.fg("success", " 🔥") : theme.fg("dim", " local");
			if (details.selector) text += theme.fg("dim", ` [${details.selector}]`);
			if (details.truncated) text += theme.fg("warning", " truncated");

			if (expanded) {
				text += `\n${theme.fg("dim", `Status: ${details.statusCode}`)}`;
				text += `\n${theme.fg("dim", `Length: ${details.contentLength} chars`)}`;
				text += `\n${theme.fg("dim", `Source: ${details.source}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web.

Parameters:
- query: The search query
- numResults: Number of results (default: 5, max: 10)
- provider: 'brave' | 'serper' | 'tavily' | 'duckduckgo' (optional)

Providers are preferred in order: Brave → Serper → Tavily → DuckDuckGo.
Brave/Serper/Tavily require API keys (BRAVE_API_KEY, SERPER_API_KEY,
TAVILY_API_KEY). DuckDuckGo is the keyless fallback.

Returns a list of search results with titles, URLs, and snippets.`,
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const numResults = Math.min(params.numResults || 5, 10);

			try {
				const provider = await resolveSearchProvider(params.provider);
				onUpdate?.({
					content: [{ type: "text", text: `Searching via ${provider.name}…` }],
					details: {
						query: params.query,
						numResults: 0,
						provider: provider.name,
						results: [],
					} as WebSearchDetails,
				});
				const results = await provider.search(params.query, numResults, signal);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: {
							query: params.query,
							numResults: 0,
							provider: provider.name,
							results: [],
						} as WebSearchDetails,
					};
				}

				const formatted = results
					.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
					.join("\n\n");
				const text = `Search results for "${params.query}" (via ${provider.name}):\n\n${formatted}`;

				return {
					content: [{ type: "text", text }],
					details: {
						query: params.query,
						numResults: results.length,
						provider: provider.name,
						results,
					} as WebSearchDetails,
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Search error: ${errorMsg}` }],
					details: {
						query: params.query,
						numResults: 0,
						provider: params.provider ?? "unknown",
						results: [],
						error: errorMsg,
					} as WebSearchDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${args.query}"`);
			const numResults = args.numResults || 5;
			if (numResults !== 5) text += theme.fg("dim", ` (${numResults} results)`);
			if (args.provider) text += theme.fg("muted", ` [${args.provider}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as WebSearchDetails | undefined;
			if (!details) return new Text(theme.fg("error", "Error: Missing result details"), 0, 0);
			if (details.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			if (details.results.length === 0) return new Text(theme.fg("dim", "No results found"), 0, 0);

			let text = theme.fg("success", `✓ ${details.results.length} results `);
			text += theme.fg("muted", `for "${details.query}" via ${details.provider}`);

			if (expanded) {
				for (const r of details.results.slice(0, 5)) {
					text += `\n${theme.fg("accent", "•")} ${theme.fg("text", r.title)}`;
					text += `\n  ${theme.fg("dim", r.url)}`;
				}
				if (details.results.length > 5) {
					text += `\n${theme.fg("dim", `... and ${details.results.length - 5} more`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("web-history", {
		description: "Show recent web browsing activity from this session",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			type HistoryItem = { type: "fetch" | "search"; url?: string; query?: string; provider?: string; timestamp: number };
			const webActivity: HistoryItem[] = [];

			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg.role !== "toolResult") continue;

				if (msg.toolName === "web_fetch") {
					const details = msg.details as WebFetchDetails | undefined;
					if (details?.url) webActivity.push({ type: "fetch", url: details.url, timestamp: entry.timestamp });
				} else if (msg.toolName === "web_search") {
					const details = msg.details as WebSearchDetails | undefined;
					if (details?.query) {
						webActivity.push({
							type: "search",
							query: details.query,
							provider: details.provider,
							timestamp: entry.timestamp,
						});
					}
				}
			}

			if (webActivity.length === 0) {
				ctx.ui.notify("No web browsing activity in this session", "info");
				return;
			}

			let output = `Web browsing activity (${webActivity.length} items):\n\n`;
			for (const item of webActivity.slice(-20)) {
				const time = new Date(item.timestamp).toLocaleTimeString();
				if (item.type === "fetch" && item.url) {
					output += `[${time}] Fetch: ${item.url}\n`;
				} else if (item.type === "search" && item.query) {
					output += `[${time}] Search: "${item.query}"${item.provider ? ` (${item.provider})` : ""}\n`;
				}
			}
			ctx.ui.notify(output, "info");
		},
	});

	pi.registerCommand("web-status", {
		description: "Show web browsing extension status",
		handler: async (args, ctx) => {
			const reveal = typeof args === "string" && args.includes("--reveal");
			const hasKey = await hasFirecrawlKey();
			const key = await getFirecrawlApiKey();
			const keyDisplay = !hasKey ? "not set" : reveal ? (key ?? "not set") : maskKey(key);
			const configPath = getConfigPath();

			const providerLines: string[] = [];
			for (const provider of SEARCH_PROVIDERS) {
				const available = await provider.isAvailable();
				providerLines.push(`  - ${provider.name}: ${available ? "✓ available" : "✗ not configured"}`);
			}

			const status = [
				"Web Browse Extension Status:",
				"",
				`Firecrawl API: ${hasKey ? "✓ enabled" : "✗ disabled"}`,
				`API Key: ${keyDisplay}`,
				`Config file: ${configPath}`,
				"",
				"Search providers:",
				...providerLines,
				"",
				"Tools available:",
				"- web_fetch: Fetch and extract content from URLs",
				"- web_search: Search the web",
				"",
				"Commands available:",
				"- /web-history: Show browsing history",
				"- /web-status [--reveal]: Show this status (add --reveal to show full API key)",
			].join("\n");

			ctx.ui.notify(status, "info");
		},
	});
}
