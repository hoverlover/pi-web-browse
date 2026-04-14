import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	fetchWebPageLocal,
	fetchWithFirecrawl,
	fetchWebPage,
	extractReadableText,
	htmlToMarkdownLocal,
	searchDuckDuckGo,
	resetTestState,
} from "../extensions/web-browse.js";
import { isPrivateIp, isPrivateIpv4, isPrivateIpv6, safeFetch, SafeFetchError } from "./safe-fetch.js";
import { resolveSearchProvider } from "./search.js";

// Tests mock `fetch` globally. Bypass SSRF DNS checks so we don't hit the
// network during tests.
process.env.PI_WEB_BROWSE_UNSAFE_DISABLE_SSRF = "1";

function makeResponse({
	body,
	contentType,
	status = 200,
	statusText = "OK",
	extraHeaders = {},
}: {
	body: string;
	contentType: string;
	status?: number;
	statusText?: string;
	extraHeaders?: Record<string, string>;
}) {
	return new Response(body, {
		status,
		statusText,
		headers: { "content-type": contentType, ...extraHeaders },
	});
}

async function loadCheerio() {
	vi.stubGlobal("fetch", async () =>
		makeResponse({ body: "<html><body><p>hi</p></body></html>", contentType: "text/html" }),
	);
	await fetchWebPageLocal("http://example.com", "text", undefined, undefined);
	vi.unstubAllGlobals();
}

function resetEnv() {
	delete process.env.FIRECRAWL_API_KEY;
	delete process.env.BRAVE_API_KEY;
	delete process.env.SERPER_API_KEY;
	delete process.env.TAVILY_API_KEY;
}

describe("fetchWebPageLocal", () => {
	beforeEach(() => {
		resetTestState();
		resetEnv();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetEnv();
	});

	it("rejects unsupported content types", async () => {
		vi.stubGlobal("fetch", async () => makeResponse({ body: "%PDF-1.4", contentType: "application/pdf" }));
		await expect(
			fetchWebPageLocal("https://example.com/file.pdf", "markdown", undefined, undefined),
		).rejects.toThrow("Unsupported content type: application/pdf");
	});

	it("rejects images", async () => {
		vi.stubGlobal("fetch", async () => makeResponse({ body: "binary", contentType: "image/png" }));
		await expect(
			fetchWebPageLocal("https://example.com/img.png", "markdown", undefined, undefined),
		).rejects.toThrow("Unsupported content type: image/png");
	});

	it("accepts text/markdown", async () => {
		vi.stubGlobal("fetch", async () => makeResponse({ body: "# Hello", contentType: "text/markdown" }));
		const result = await fetchWebPageLocal("https://example.com/readme.md", "html", undefined, undefined);
		expect(result.content).toBe("# Hello");
		expect(result.source).toBe("local");
		expect(result.status).toBe(200);
	});

	it("returns raw html when format is html", async () => {
		vi.stubGlobal("fetch", async () =>
			makeResponse({
				body: "<html><title>Page</title><body><p>Hello</p></body></html>",
				contentType: "text/html",
			}),
		);
		const result = await fetchWebPageLocal("https://example.com", "html", undefined, undefined);
		expect(result.content).toContain("<p>Hello</p>");
	});

	it("extracts text when format is text", async () => {
		vi.stubGlobal("fetch", async () =>
			makeResponse({
				body: "<html><body><p>This is a long paragraph with enough text to pass the filter.</p></body></html>",
				contentType: "text/html",
			}),
		);
		const result = await fetchWebPageLocal("https://example.com", "text", undefined, undefined);
		expect(result.content).toContain("This is a long paragraph");
	});

	it("extracts markdown when format is markdown", async () => {
		vi.stubGlobal("fetch", async () =>
			makeResponse({
				body: "<html><head><title>My Page</title></head><body><main><h1>Heading</h1><p>Paragraph</p></main></body></html>",
				contentType: "text/html",
			}),
		);
		const result = await fetchWebPageLocal("https://example.com", "markdown", undefined, undefined);
		expect(result.content).toContain("# My Page");
		expect(result.content).toContain("Heading");
	});

	it("uses CSS selector when provided", async () => {
		vi.stubGlobal("fetch", async () =>
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
		vi.stubGlobal("fetch", async () =>
			makeResponse({ body: "<html><body><div>No match</div></body></html>", contentType: "text/html" }),
		);
		await expect(
			fetchWebPageLocal("https://example.com", "html", "#missing", undefined),
		).rejects.toThrow('Selector "#missing" not found on the page');
	});
});

describe("extractReadableText", () => {
	beforeEach(() => resetTestState());
	afterEach(() => vi.unstubAllGlobals());

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
	beforeEach(() => resetTestState());
	afterEach(() => vi.unstubAllGlobals());

	it("converts html to markdown and includes title", async () => {
		await loadCheerio();
		const md = await htmlToMarkdownLocal(
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
		resetEnv();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		resetEnv();
	});

	it("throws when API key is missing", async () => {
		await expect(fetchWithFirecrawl("https://example.com", "markdown", undefined)).rejects.toThrow(
			"FIRECRAWL_API_KEY not set",
		);
	});

	it("returns markdown on success", async () => {
		process.env.FIRECRAWL_API_KEY = "test-key";
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			expect(url).toBe("https://api.firecrawl.dev/v1/scrape");
			const body = JSON.parse(init.body as string);
			expect(body.url).toBe("https://example.com");
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						markdown: "# Hello",
						metadata: { title: "Example", sourceURL: "https://example.com", statusCode: 200 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const result = await fetchWithFirecrawl("https://example.com", "markdown", undefined);
		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("Source: https://example.com");
		expect(result.source).toBe("firecrawl");
		expect(result.status).toBe(200);
	});

	it("throws on Firecrawl API error", async () => {
		process.env.FIRECRAWL_API_KEY = "test-key";
		vi.stubGlobal("fetch", async () =>
			new Response(JSON.stringify({ success: false, error: "Bad URL" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(fetchWithFirecrawl("https://bad.example.com", "markdown", undefined)).rejects.toThrow("Bad URL");
	});
});

describe("fetchWebPage", () => {
	beforeEach(() => {
		resetTestState();
		resetEnv();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		resetEnv();
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
				body: "<html><body><p>Fallback content here that is long enough.</p></body></html>",
				contentType: "text/html",
			});
		});
		const result = await fetchWebPage("https://example.com", "text", undefined, 10000, undefined, undefined);
		expect(result.content).toContain("Fallback content here");
		expect(result.details.source).toBe("local");
		expect(result.details.statusCode).toBe(200);
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

	it("truncates content when maxLength is exceeded and suffix does not overflow", async () => {
		vi.stubGlobal("fetch", async () =>
			makeResponse({
				body: "<html><body><p>" + "a".repeat(500) + "</p></body></html>",
				contentType: "text/html",
			}),
		);
		const result = await fetchWebPage("https://example.com", "text", undefined, 100, false, undefined);
		expect(result.content.endsWith("\n\n[Content truncated...]")).toBe(true);
		expect(result.details.truncated).toBe(true);
		expect(result.content.length).toBeLessThanOrEqual(100);
	});
});

describe("searchDuckDuckGo", () => {
	beforeEach(() => resetTestState());
	afterEach(() => vi.unstubAllGlobals());

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
		vi.stubGlobal("fetch", async () => makeResponse({ body: html, contentType: "text/html" }));
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
		vi.stubGlobal("fetch", async () => makeResponse({ body: html, contentType: "text/html" }));
		const results = await searchDuckDuckGo("query", 5, undefined);
		expect(results[0].url).toBe("https://example.com");
	});
});

describe("safeFetch SSRF guards", () => {
	beforeEach(() => {
		// Temporarily turn SSRF back on for these specific tests.
		delete process.env.PI_WEB_BROWSE_UNSAFE_DISABLE_SSRF;
	});
	afterEach(() => {
		process.env.PI_WEB_BROWSE_UNSAFE_DISABLE_SSRF = "1";
		vi.unstubAllGlobals();
	});

	it("rejects non-http(s) protocols", async () => {
		await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/Only http and https/);
	});

	it("rejects loopback literal IP", async () => {
		await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow(/private\/loopback/);
	});

	it("rejects RFC1918 literal IP", async () => {
		await expect(safeFetch("http://10.0.0.1/")).rejects.toThrow(/private\/loopback/);
	});

	it("rejects link-local IPv4", async () => {
		await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
			/private\/loopback/,
		);
	});

	it("rejects IPv6 loopback", async () => {
		await expect(safeFetch("http://[::1]/")).rejects.toThrow(/private\/loopback/);
	});

	it("includes SafeFetchError code", async () => {
		try {
			await safeFetch("http://127.0.0.1/");
		} catch (err) {
			expect(err).toBeInstanceOf(SafeFetchError);
			expect((err as SafeFetchError).code).toBe("PRIVATE_IP");
		}
	});
});

describe("isPrivateIp", () => {
	it("flags IPv4 private ranges", () => {
		expect(isPrivateIpv4("10.0.0.1")).toBe(true);
		expect(isPrivateIpv4("172.16.0.1")).toBe(true);
		expect(isPrivateIpv4("192.168.1.1")).toBe(true);
		expect(isPrivateIpv4("127.0.0.1")).toBe(true);
		expect(isPrivateIpv4("169.254.169.254")).toBe(true);
		expect(isPrivateIpv4("0.0.0.0")).toBe(true);
		expect(isPrivateIpv4("100.64.0.1")).toBe(true); // CGNAT
	});

	it("allows public IPv4", () => {
		expect(isPrivateIpv4("8.8.8.8")).toBe(false);
		expect(isPrivateIpv4("1.1.1.1")).toBe(false);
		expect(isPrivateIpv4("142.250.80.14")).toBe(false);
	});

	it("flags IPv6 private / link-local", () => {
		expect(isPrivateIpv6("::1")).toBe(true);
		expect(isPrivateIpv6("fe80::1")).toBe(true);
		expect(isPrivateIpv6("fc00::1")).toBe(true);
		expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
	});

	it("allows public IPv6", () => {
		expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
	});

	it("returns false for non-IP strings", () => {
		expect(isPrivateIp("example.com")).toBe(false);
	});
});

describe("safeFetch size and redirect caps", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("caps response body at maxBytes", async () => {
		const big = "x".repeat(10_000);
		vi.stubGlobal("fetch", async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }));
		const result = await safeFetch("http://example.com", { maxBytes: 100, allowPrivate: true });
		expect(result.truncated).toBe(true);
		expect(result.body.length).toBeLessThanOrEqual(100);
	});

	it("follows redirects up to maxRedirects", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			if (calls <= 10) {
				return new Response("", {
					status: 302,
					headers: { location: "http://example.com/next" },
				});
			}
			return new Response("done", { status: 200 });
		});
		await expect(
			safeFetch("http://example.com", { allowPrivate: true, maxRedirects: 3 }),
		).rejects.toThrow(/max redirects/);
	});
});

describe("resolveSearchProvider", () => {
	beforeEach(() => resetEnv());
	afterEach(() => resetEnv());

	it("defaults to DuckDuckGo when no keys are set", async () => {
		const provider = await resolveSearchProvider();
		expect(provider.name).toBe("duckduckgo");
	});

	it("prefers Brave when BRAVE_API_KEY is set", async () => {
		process.env.BRAVE_API_KEY = "test";
		const provider = await resolveSearchProvider();
		expect(provider.name).toBe("brave");
	});

	it("prefers Serper when only SERPER_API_KEY is set", async () => {
		process.env.SERPER_API_KEY = "test";
		const provider = await resolveSearchProvider();
		expect(provider.name).toBe("serper");
	});

	it("throws when explicit provider is not configured", async () => {
		await expect(resolveSearchProvider("brave")).rejects.toThrow(/not configured/);
	});

	it("throws on unknown provider", async () => {
		await expect(resolveSearchProvider("bogus")).rejects.toThrow(/Unknown search provider/);
	});
});
