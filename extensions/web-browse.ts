/**
 * Web Browsing Extension for pi
 *
 * Provides tools for fetching web pages and searching the web.
 *
 * Tools:
 * - web_fetch: Fetch a URL and extract content as HTML, markdown, or text
 *   - Uses Firecrawl API if FIRECRAWL_API_KEY is set (superior extraction)
 *   - Falls back to local cheerio+turndown processing otherwise
 * - web_search: Search the web using DuckDuckGo (no API key required)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Lazy-loaded dependencies
let TurndownService: typeof import("turndown")["default"] | undefined;
let cheerio: typeof import("cheerio") | undefined;

async function loadLocalDeps() {
	if (!TurndownService) {
		({ default: TurndownService } = await import("turndown"));
	}
	if (!cheerio) {
		cheerio = await import("cheerio");
	}
}

// ============================================================================
// Config Loading
// ============================================================================

let cachedFirecrawlKey: string | undefined | null = null;

interface WebBrowseConfig {
	firecrawlApiKey?: string;
}

function getFirecrawlConfigPath(): string {
	return join(homedir(), ".pi", "agent", "web-browse.json");
}

async function loadConfig(): Promise<WebBrowseConfig> {
	try {
		const configPath = getFirecrawlConfigPath();
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as WebBrowseConfig;
	} catch {
		return {};
	}
}

async function getFirecrawlApiKey(): Promise<string | undefined> {
	if (cachedFirecrawlKey !== null) {
		return cachedFirecrawlKey || undefined;
	}

	// 1. Check environment variable
	if (process.env.FIRECRAWL_API_KEY) {
		cachedFirecrawlKey = process.env.FIRECRAWL_API_KEY;
		return cachedFirecrawlKey;
	}

	// 2. Check config file
	const config = await loadConfig();
	if (config.firecrawlApiKey) {
		cachedFirecrawlKey = config.firecrawlApiKey;
		return cachedFirecrawlKey;
	}

	cachedFirecrawlKey = undefined;
	return undefined;
}

async function hasFirecrawlKey(): Promise<boolean> {
	const key = await getFirecrawlApiKey();
	return !!key;
}

// ============================================================================
// Firecrawl Integration
// ============================================================================

interface FirecrawlResponse {
	success: boolean;
	data?: {
		markdown?: string;
		html?: string;
		metadata?: {
			title?: string;
			sourceURL?: string;
			description?: string;
		};
	};
	error?: string;
}

/**
 * Fetch page using Firecrawl API for superior extraction
 */
async function fetchWithFirecrawl(
	url: string,
	format: "markdown" | "text" | "html",
	signal: AbortSignal | undefined,
): Promise<{ content: string; title?: string; source: "firecrawl" }> {
	const apiKey = await getFirecrawlApiKey();
	if (!apiKey) {
		throw new Error("FIRECRAWL_API_KEY not set");
	}

	const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			url,
			formats: format === "html" ? ["html"] : ["markdown", "html"],
		}),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw new Error(`Firecrawl API error: ${response.status} ${errorText}`);
	}

	const result: FirecrawlResponse = await response.json();

	if (!result.success || !result.data) {
		throw new Error(result.error || "Firecrawl extraction failed");
	}

	const data = result.data;
	const title = data.metadata?.title;

	if (format === "html" && data.html) {
		return { content: data.html, title, source: "firecrawl" };
	}

	if (format === "text") {
		// Convert markdown to plain text (simple approach)
		const markdown = data.markdown || "";
		const text = markdown
			.replace(/#+ /g, "") // Remove heading markers
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove links, keep text
			.replace(/\*\*|__/g, "") // Remove bold/italic markers
			.replace(/\n{3,}/g, "\n\n") // Normalize whitespace
			.trim();
		return { content: text, title, source: "firecrawl" };
	}

	// Default: markdown
	let markdown = data.markdown || "";
	if (title && !markdown.startsWith("# ")) {
		markdown = `# ${title}\n\n${markdown}`;
	}
	if (!markdown.includes("Source:") && data.metadata?.sourceURL) {
		markdown += `\n\n---\n\nSource: ${data.metadata.sourceURL}`;
	}

	return { content: markdown, title, source: "firecrawl" };
}

// ============================================================================
// Local Processing (Fallback)
// ============================================================================

/**
 * Extract readable text content from HTML using heuristics
 */
function extractReadableText($: cheerio.CheerioAPI): string {
	// Remove script, style, nav, footer, aside, and hidden elements
	$("script, style, nav, footer, aside, [hidden], [aria-hidden='true']").remove();

	// Common content selectors to try (in order of preference)
	const contentSelectors = [
		"article",
		"[role='main']",
		"main",
		".content",
		"#content",
		".post",
		"#post",
		"article",
		".article",
		"#article",
		".entry",
		".post-content",
		".entry-content",
		"#main",
		".main",
	];

	for (const sel of contentSelectors) {
		const el = $(sel).first();
		if (el.length && el.text().trim().length > 200) {
			return el.text().trim();
		}
	}

	// Fallback: get body text, prioritizing paragraphs and headings
	const body = $("body");
	if (body.length) {
		const paragraphs = body.find("p, h1, h2, h3, h4, h5, h6, li");
		if (paragraphs.length > 0) {
			const texts: string[] = [];
			paragraphs.each((_, el) => {
				const text = $(el).text().trim();
				if (text.length > 20) {
					texts.push(text);
				}
			});
			if (texts.length > 0) {
				return texts.join("\n\n");
			}
		}
		return body.text().trim();
	}

	return "";
}

/**
 * Convert HTML to markdown locally
 */
function htmlToMarkdownLocal(html: string, url: string): string {
	const $ = cheerio!.load(html);

	// Extract title
	const title = $("title").text().trim();
	const h1 = $("h1").first().text().trim();
	const pageTitle = title || h1 || "Untitled";

	// Extract main content
	let content = "";
	const mainSelectors = ["article", "main", "[role='main']", ".content", "#content", ".post", ".entry"];
	for (const sel of mainSelectors) {
		const el = $(sel).first();
		if (el.length && el.text().trim().length > 200) {
			content = el.html() || "";
			break;
		}
	}

	// Fallback to body if no main content found
	if (!content) {
		content = $("body").html() || "";
	}

	// Use turndown to convert to markdown
	const turndown = new TurndownService!({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});

	// Remove images, scripts, and other non-content elements
	turndown.remove(["script", "style", "nav", "footer", "aside", "img", "svg"]);

	const markdown = turndown.turndown(content);

	return `# ${pageTitle}\n\nSource: ${url}\n\n---\n\n${markdown}`;
}

async function fetchWebPageLocal(
	url: string,
	format: "markdown" | "text" | "html",
	selector: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ content: string; source: "local" }> {
	await loadLocalDeps();

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.5",
		},
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	let html = await response.text();

	// If selector is specified, extract that element
	if (selector) {
		const $ = cheerio!.load(html);
		const selected = $(selector).first();
		if (selected.length) {
			html = selected.html() || "";
		} else {
			throw new Error(`Selector "${selector}" not found on the page`);
		}
	}

	// Convert based on format
	let content: string;
	switch (format) {
		case "html":
			content = html;
			break;
		case "text": {
			const $ = cheerio!.load(html);
			content = extractReadableText($);
			break;
		}
		case "markdown":
		default:
			content = htmlToMarkdownLocal(html, url);
			break;
	}

	return { content, source: "local" };
}

// ============================================================================
// Web Fetch Tool
// ============================================================================

const WebFetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	format: Type.Optional(
		StringEnum(["markdown", "text", "html"] as const),
		{ description: "Output format (default: markdown)" },
	),
	selector: Type.Optional(
		Type.String({ description: "CSS selector to extract specific content (e.g., 'article', '.content', '#main'). Only works with local extraction, not Firecrawl." }),
	),
	maxLength: Type.Optional(
		Type.Number({ description: "Maximum characters to return (default: 10000)" }),
	),
	useFirecrawl: Type.Optional(
		Type.Boolean({ description: "Use Firecrawl API for superior extraction (requires FIRECRAWL_API_KEY env var or config file). Default: true if key is available, false otherwise." }),
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

async function fetchWebPage(
	url: string,
	format: "markdown" | "text" | "html",
	selector: string | undefined,
	maxLength: number,
	useFirecrawl: boolean | undefined,
	signal: AbortSignal | undefined,
): Promise<{ content: string; details: WebFetchDetails }> {
	// Determine whether to use Firecrawl
	const firecrawlAvailable = await hasFirecrawlKey();
	const shouldUseFirecrawl = useFirecrawl !== false && firecrawlAvailable;

	let content: string;
	let source: "firecrawl" | "local";
	let statusCode = 200;

	if (shouldUseFirecrawl) {
		try {
			const result = await fetchWithFirecrawl(url, format, signal);
			content = result.content;
			source = result.source;
		} catch (error) {
			// Fall back to local extraction if Firecrawl fails
			if (useFirecrawl === true) {
				// User explicitly wanted Firecrawl, don't silently fall back
				throw error;
			}
			const localResult = await fetchWebPageLocal(url, format, selector, signal);
			content = localResult.content;
			source = localResult.source;
		}
	} else {
		const localResult = await fetchWebPageLocal(url, format, selector, signal);
		content = localResult.content;
		source = localResult.source;
	}

	// Apply maxLength limit
	const truncated = content.length > maxLength;
	if (truncated) {
		content = content.substring(0, maxLength) + "\n\n[Content truncated...]";
	}

	return {
		content,
		details: {
			url,
			format,
			statusCode,
			selector,
			truncated,
			contentLength: content.length,
			source,
		},
	};
}

// ============================================================================
// Web Search Tool
// ============================================================================

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(
		Type.Number({ description: "Number of results (default: 5, max: 10)" }),
	),
});

type WebSearchResult = {
	title: string;
	url: string;
	snippet: string;
};

type WebSearchDetails = {
	query: string;
	numResults: number;
	results: WebSearchResult[];
	error?: string;
};

/**
 * Search using DuckDuckGo HTML interface
 */
async function searchDuckDuckGo(
	query: string,
	numResults: number,
	signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
	await loadLocalDeps();

	const encodedQuery = encodeURIComponent(query);
	const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

	const response = await fetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			"Accept": "text/html",
		},
	});

	if (!response.ok) {
		throw new Error(`Search failed: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	const $ = cheerio!.load(html);

	const results: WebSearchResult[] = [];

	// DuckDuckGo HTML results structure
	$(".web-result").each((i, el) => {
		if (results.length >= numResults) return false;

		const $el = $(el);
		const titleEl = $el.find(".result__a").first();
		const snippetEl = $el.find(".result__snippet").first();

		const title = titleEl.text().trim();
		const href = titleEl.attr("href");
		const snippet = snippetEl.text().trim();

		if (title && href) {
			// DuckDuckGo uses redirects, extract actual URL
			let url = href;
			if (href.startsWith("//duckduckgo.com/l/?")) {
				const urlMatch = href.match(/uddg=([^&]+)/);
				if (urlMatch) {
					try {
						url = decodeURIComponent(urlMatch[1]);
					} catch {
						url = href;
					}
				}
			}

			results.push({
				title,
				url,
				snippet: snippet || "",
			});
		}
	});

	// Fallback: try alternative selectors
	if (results.length === 0) {
		$(".result").each((i, el) => {
			if (results.length >= numResults) return false;

			const $el = $(el);
			const titleEl = $el.find("a.result__a, h2 a, .result__title a").first();
			const snippetEl = $el.find(".result__snippet, .result__snippet a, .web-result__snippet").first();

			const title = titleEl.text().trim();
			const href = titleEl.attr("href");
			const snippet = snippetEl.text().trim();

			if (title && href && !href.startsWith("/")) {
				let url = href;
				if (href.includes("duckduckgo.com/l/?")) {
					const urlMatch = href.match(/uddg=([^&]+)/);
					if (urlMatch) {
						try {
							url = decodeURIComponent(urlMatch[1]);
						} catch {
							url = href;
						}
					}
				}

				results.push({
					title,
					url,
					snippet: snippet || "",
				});
			}
		});
	}

	return results;
}

// ============================================================================
// Main Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	// Check for Firecrawl key on startup
	hasFirecrawlKey().then((available) => {
		if (available) {
			console.log("[web-browse] Firecrawl API detected - using for superior content extraction");
		}
	});

	// Register web_fetch tool
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch and extract content from a web page.

Parameters:
- url: The URL to fetch
- format: Output format - "markdown" (default), "text", or "html"
- selector: Optional CSS selector to extract specific content (local extraction only)
- maxLength: Maximum characters to return (default: 10000)
- useFirecrawl: Use Firecrawl API for superior extraction (default: true if key is available)

Extraction Methods:
1. Firecrawl API (recommended): Set FIRECRAWL_API_KEY environment variable or add it 
   to ~/.pi/agent/web-browse.json for superior content extraction.
2. Local extraction: Uses cheerio + turndown as fallback. Supports CSS selectors.

Use this tool to:
- Read documentation from a URL
- Extract article content for analysis  
- Get the text/markdown version of a web page
- Fetch specific sections using CSS selectors (local mode only)

Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const format = params.format || "markdown";
			const maxLength = params.maxLength || 10000;

			try {
				const result = await fetchWebPage(
					params.url,
					format,
					params.selector,
					maxLength,
					params.useFirecrawl,
					signal,
				);
				return {
					content: [{ type: "text", text: result.content }],
					details: result.details,
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				const firecrawlAvailable = await hasFirecrawlKey();
				return {
					content: [{ type: "text", text: `Error fetching page: ${errorMsg}` }],
					details: {
						url: params.url,
						format,
						statusCode: 0,
						truncated: false,
						contentLength: 0,
						source: firecrawlAvailable ? "firecrawl" : "local",
						error: errorMsg,
					} as WebFetchDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url);
			if (args.format && args.format !== "markdown") {
				text += theme.fg("dim", ` as ${args.format}`);
			}
			if (args.selector) {
				text += theme.fg("muted", ` [${args.selector}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as WebFetchDetails | undefined;

			if (!details) {
				return new Text(theme.fg("error", "Error: Missing result details"), 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			let text = theme.fg("success", "✓ Fetched ");
			text += theme.fg("accent", details.url);
			text += theme.fg("muted", ` (${details.format})`);

			// Show extraction source
			if (details.source === "firecrawl") {
				text += theme.fg("success", " 🔥");
			} else {
				text += theme.fg("dim", " local");
			}

			if (details.selector) {
				text += theme.fg("dim", ` [${details.selector}]`);
			}

			if (details.truncated) {
				text += theme.fg("warning", " truncated");
			}

			if (expanded) {
				text += `\n${theme.fg("dim", `Length: ${details.contentLength} chars`)}`;
				text += `\n${theme.fg("dim", `Source: ${details.source}`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// Register web_search tool
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using DuckDuckGo.

Parameters:
- query: The search query
- numResults: Number of results to return (default: 5, max: 10)

Use this tool to:
- Find documentation, tutorials, or references
- Research topics and gather information
- Find code examples or solutions
- Look up current information not in training data

Returns a list of search results with titles, URLs, and snippets.
Use web_fetch to retrieve the full content of interesting results.`,
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const numResults = Math.min(params.numResults || 5, 10);

			try {
				const results = await searchDuckDuckGo(params.query, numResults, signal);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results found." }],
						details: {
							query: params.query,
							numResults: 0,
							results: [],
						} as WebSearchDetails,
					};
				}

				// Format results
				const formattedResults = results
					.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
					.join("\n\n");

				const content = `Search results for "${params.query}":\n\n${formattedResults}`;

				return {
					content: [{ type: "text", text: content }],
					details: {
						query: params.query,
						numResults: results.length,
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
			if (numResults !== 5) {
				text += theme.fg("dim", ` (${numResults} results)`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as WebSearchDetails | undefined;

			if (!details) {
				return new Text(theme.fg("error", "Error: Missing result details"), 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (details.results.length === 0) {
				return new Text(theme.fg("dim", "No results found"), 0, 0);
			}

			let text = theme.fg("success", `✓ ${details.results.length} results `);
			text += theme.fg("muted", `for "${details.query}"`);

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

	// Register a command to view search history
	pi.registerCommand("web-history", {
		description: "Show recent web browsing activity from this session",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const webActivity: Array<{ type: "fetch" | "search"; url?: string; query?: string; timestamp: number }> = [];

			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg.role !== "toolResult") continue;

				if (msg.toolName === "web_fetch") {
					const details = msg.details as WebFetchDetails | undefined;
					if (details?.url) {
						webActivity.push({
							type: "fetch",
							url: details.url,
							timestamp: entry.timestamp,
						});
					}
				} else if (msg.toolName === "web_search") {
					const details = msg.details as WebSearchDetails | undefined;
					if (details?.query) {
						webActivity.push({
							type: "search",
							query: details.query,
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
					output += `[${time}] Search: "${item.query}"\n`;
				}
			}

			ctx.ui.notify(output, "info");
		},
	});

	// Register a command to check Firecrawl status
	pi.registerCommand("web-status", {
		description: "Show web browsing extension status",
		handler: async (_args, ctx) => {
			const hasKey = await hasFirecrawlKey();
			const key = await getFirecrawlApiKey();
			const keyPreview = hasKey ? `${key?.slice(0, 8)}...` : "not set";
			const configPath = getFirecrawlConfigPath();

			const status = `Web Browse Extension Status:\n\nFirecrawl API: ${hasKey ? "✓ enabled" : "✗ disabled"}\nAPI Key: ${keyPreview}\nConfig file: ${configPath}\n\nTools available:\n- web_fetch: Fetch and extract content from URLs\n- web_search: Search the web using DuckDuckGo\n\nCommands available:\n- /web-history: Show browsing history\n- /web-status: Show this status`;

			ctx.ui.notify(status, "info");
		},
	});
}
