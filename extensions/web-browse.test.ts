import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	fetchWebPageLocal,
	fetchWithFirecrawl,
	fetchWebPage,
	extractReadableText,
	htmlToMarkdownLocal,
	searchDuckDuckGo,
	resetTestState,
} from "./web-browse.js";

// Cheerio is lazy-loaded, so we trigger it once before tests that need it.
async function loadCheerio() {
	// fetchWebPageLocal with a minimal HTML response loads cheerio internally.
	vi.stubGlobal("fetch", async () =>
		makeResponse({
			body: "<html><body><p>hi</p></body></html>",
			contentType: "text/html",
		}),
	);
	await fetchWebPageLocal("http://example.com", "text", undefined, undefined);
	vi.unstubAllGlobals();
}

function makeResponse({
	body,
	contentType,
	status = 200,
	statusText = "OK",
}: {
	body: string;
	contentType: string;
	status?: number;
	statusText?: string;
}) {
	return new Response(body, {
		status,
		statusText,
		headers: { "content-type": contentType },
	});
}

describe("fetchWebPageLocal", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.FIRECRAWL_API_KEY;
	});

	it("rejects unsupported content types", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "%PDF-1.4",
					contentType: "application/pdf",
				}),
		);

		await expect(
			fetchWebPageLocal("https://example.com/file.pdf", "markdown", undefined, undefined),
		).rejects.toThrow("Unsupported content type: application/pdf");
	});

	it("rejects images", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "binary",
					contentType: "image/png",
				}),
		);

		await expect(
			fetchWebPageLocal("https://example.com/img.png", "markdown", undefined, undefined),
		).rejects.toThrow("Unsupported content type: image/png");
	});

	it("accepts text/markdown", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "# Hello",
					contentType: "text/markdown",
				}),
		);

		const result = await fetchWebPageLocal("https://example.com/readme.md", "html", undefined, undefined);
		expect(result.content).toBe("# Hello");
		expect(result.source).toBe("local");
	});

	it("returns raw html when format is html", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><title>Page</title><body><p>Hello</p></body></html>",
					contentType: "text/html",
				}),
		);

		const result = await fetchWebPageLocal("https://example.com", "html", undefined, undefined);
		expect(result.content).toContain("<p>Hello</p>");
		expect(result.source).toBe("local");
	});

	it("extracts text when format is text", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><body><p>This is a long paragraph with enough text to pass the filter.</p></body></html>",
					contentType: "text/html",
				}),
		);

		const result = await fetchWebPageLocal("https://example.com", "text", undefined, undefined);
		expect(result.content).toContain("This is a long paragraph");
		expect(result.source).toBe("local");
	});

	it("extracts markdown when format is markdown", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><head><title>My Page</title></head><body><main><h1>Heading</h1><p>Paragraph</p></main></body></html>",
					contentType: "text/html",
				}),
		);

		const result = await fetchWebPageLocal("https://example.com", "markdown", undefined, undefined);
		expect(result.content).toContain("# My Page");
		expect(result.content).toContain("Heading");
		expect(result.source).toBe("local");
	});

	it("uses CSS selector when provided", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><body><div id='main'>Selected</div><div id='other'>Other</div></body></html>",
					contentType: "text/html",
				}),
		);

		const result = await fetchWebPageLocal("https://example.com", "html", "#main", undefined);
		expect(result.content).toContain("Selected");
		expect(result.content).not.toContain("Other");
	});

	it("throws when CSS selector is not found", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><body><div>No match</div></body></html>",
					contentType: "text/html",
				}),
		);

		await expect(
			fetchWebPageLocal("https://example.com", "html", "#missing", undefined),
		).rejects.toThrow('Selector "#missing" not found on the page');
	});
});

describe("extractReadableText", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("extracts article content when available", async () => {
		await loadCheerio();
		const cheerioMod = await import("cheerio");
		const $ = cheerioMod.load(
			"<html><body><article><p>" + "a".repeat(250) + "</p></article><footer>ignore me</footer></body></html>",
		);
		const text = extractReadableText($);
		expect(text).toContain("a".repeat(250));
		expect(text).not.toContain("ignore me");
	});

	it("falls back to body text when no article", async () => {
		await loadCheerio();
		const cheerioMod = await import("cheerio");
		const $ = cheerioMod.load(
			"<html><body><p>This is a reasonably long paragraph that should be included.</p></body></html>",
		);
		const text = extractReadableText($);
		expect(text).toContain("reasonably long paragraph");
	});
});

describe("htmlToMarkdownLocal", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("converts html to markdown and includes title", async () => {
		await loadCheerio();
		const md = htmlToMarkdownLocal(
			"<html><head><title>Test Page</title></head><body><main><h2>Section</h2><p>Text</p></main></body></html>",
			"https://example.com",
		);
		expect(md).toContain("# Test Page");
		expect(md).toContain("## Section");
		expect(md).toContain("Text");
		expect(md).toContain("Source: https://example.com");
	});
});

describe("fetchWithFirecrawl", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.FIRECRAWL_API_KEY;
	});

	it("throws when API key is missing", async () => {
		await expect(
			fetchWithFirecrawl("https://example.com", "markdown", undefined),
		).rejects.toThrow("FIRECRAWL_API_KEY not set");
	});

	it("returns markdown on success", async () => {
		process.env.FIRECRAWL_API_KEY = "test-key";
		// resetTestState() cleared the cache; env var will be read next

		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			expect(url).toBe("https://api.firecrawl.dev/v1/scrape");
			const body = JSON.parse(init.body as string);
			expect(body.url).toBe("https://example.com");
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						markdown: "# Hello",
						metadata: { title: "Example", sourceURL: "https://example.com" },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const result = await fetchWithFirecrawl("https://example.com", "markdown", undefined);
		// Markdown already starts with a heading, so title is not prepended again
		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("Source: https://example.com");
		expect(result.source).toBe("firecrawl");
	});

	it("throws on Firecrawl API error", async () => {
		process.env.FIRECRAWL_API_KEY = "test-key";

		vi.stubGlobal("fetch", async () =>
			new Response(JSON.stringify({ success: false, error: "Bad URL" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(
			fetchWithFirecrawl("https://bad.example.com", "markdown", undefined),
		).rejects.toThrow("Bad URL");
	});
});

describe("fetchWebPage", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.FIRECRAWL_API_KEY;
	});

	it("falls back to local when Firecrawl fails and useFirecrawl is undefined", async () => {
		process.env.FIRECRAWL_API_KEY = "bad-key";

		vi.stubGlobal("fetch", async (url: string) => {
			if (url === "https://api.firecrawl.dev/v1/scrape") {
				return new Response(JSON.stringify({ success: false, error: "Rate limited" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return makeResponse({
				body: "<html><body><p>Fallback content here.</p></body></html>",
				contentType: "text/html",
			});
		});

		const result = await fetchWebPage("https://example.com", "text", undefined, 10000, undefined, undefined);
		expect(result.content).toContain("Fallback content here");
		expect(result.details.source).toBe("local");
	});

	it("does not fallback when useFirecrawl is explicitly true", async () => {
		process.env.FIRECRAWL_API_KEY = "bad-key";

		vi.stubGlobal("fetch", async () =>
			new Response(JSON.stringify({ success: false, error: "Rate limited" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(
			fetchWebPage("https://example.com", "markdown", undefined, 10000, true, undefined),
		).rejects.toThrow("Rate limited");
	});

	it("truncates content when maxLength is exceeded", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: "<html><body><p>" + "a".repeat(200) + "</p></body></html>",
					contentType: "text/html",
				}),
		);

		const result = await fetchWebPage("https://example.com", "text", undefined, 50, false, undefined);
		expect(result.content.endsWith("\n\n[Content truncated...]")).toBe(true);
		expect(result.details.truncated).toBe(true);
	});
});

describe("searchDuckDuckGo", () => {
	beforeEach(() => {
		resetTestState();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses DuckDuckGo HTML results", async () => {
		const html = `
			<div class="web-result">
				<a class="result__a" href="https://example.com/1">Title One</a>
				<a class="result__snippet">Snippet one</a>
			</div>
			<div class="web-result">
				<a class="result__a" href="https://example.com/2">Title Two</a>
				<a class="result__snippet">Snippet two</a>
			</div>
		`;
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: html,
					contentType: "text/html",
				}),
		);

		const results = await searchDuckDuckGo("test query", 5, undefined);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			title: "Title One",
			url: "https://example.com/1",
			snippet: "Snippet one",
		});
	});

	it("decodes DuckDuckGo redirect URLs", async () => {
		const html = `
			<div class="web-result">
				<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Redirected</a>
				<a class="result__snippet">Snippet</a>
			</div>
		`;
		vi.stubGlobal(
			"fetch",
			async () =>
				makeResponse({
					body: html,
					contentType: "text/html",
				}),
		);

		const results = await searchDuckDuckGo("query", 5, undefined);
		expect(results[0].url).toBe("https://example.com");
	});
});
