import type { CheerioAPI } from "cheerio";
import { getCheerio, getTurndown } from "./deps.js";
import { safeFetch } from "./safe-fetch.js";

export const CONTENT_SELECTORS = [
	"article",
	"[role='main']",
	"main",
	".post-content",
	".entry-content",
	".content",
	"#content",
	".post",
	"#post",
	".article",
	"#article",
	".entry",
	"#main",
	".main",
] as const;

const SUPPORTED_MIMES = new Set([
	"text/html",
	"application/xhtml+xml",
	"application/xml",
	"text/xml",
	"text/plain",
	"text/markdown",
	"text/x-markdown",
]);

function findMainContent($: CheerioAPI): string | undefined {
	for (const sel of CONTENT_SELECTORS) {
		const el = $(sel).first();
		if (el.length && el.text().trim().length > 200) {
			return el.html() ?? undefined;
		}
	}
	return undefined;
}

export function extractReadableText($: CheerioAPI): string {
	$("script, style, nav, footer, aside, [hidden], [aria-hidden='true']").remove();
	for (const sel of CONTENT_SELECTORS) {
		const el = $(sel).first();
		if (el.length && el.text().trim().length > 200) return el.text().trim();
	}
	const body = $("body");
	if (!body.length) return "";
	const parts: string[] = [];
	body.find("p, h1, h2, h3, h4, h5, h6, li").each((_, el) => {
		const t = $(el).text().trim();
		if (t.length > 20) parts.push(t);
	});
	return parts.length ? parts.join("\n\n") : body.text().trim();
}

export async function htmlToMarkdownLocal(html: string, url: string): Promise<string> {
	const cheerio = await getCheerio();
	const Turndown = await getTurndown();
	const $ = cheerio.load(html);

	const title = $("title").text().trim();
	const h1 = $("h1").first().text().trim();
	const pageTitle = title || h1 || "Untitled";

	const content = findMainContent($) ?? $("body").html() ?? "";

	const turndown = new Turndown({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});
	turndown.remove(["script", "style", "nav", "footer", "aside", "img", "svg"]);
	const markdown = turndown.turndown(content);

	return `# ${pageTitle}\n\nSource: ${url}\n\n---\n\n${markdown}`;
}

export interface LocalFetchResult {
	content: string;
	status: number;
	source: "local";
}

export async function fetchWebPageLocal(
	url: string,
	format: "markdown" | "text" | "html",
	selector: string | undefined,
	signal: AbortSignal | undefined,
): Promise<LocalFetchResult> {
	const response = await safeFetch(url, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.5",
		},
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
	if (!SUPPORTED_MIMES.has(mime)) {
		throw new Error(
			`Unsupported content type: ${mime}. web_fetch only supports HTML, markdown, XML, and plain text pages (got ${mime}).`,
		);
	}

	let html = response.body;

	if (selector) {
		const cheerio = await getCheerio();
		const $ = cheerio.load(html);
		const selected = $(selector).first();
		if (!selected.length) throw new Error(`Selector "${selector}" not found on the page`);
		html = selected.html() ?? "";
	}

	let content: string;
	switch (format) {
		case "html":
			content = html;
			break;
		case "text": {
			const cheerio = await getCheerio();
			content = extractReadableText(cheerio.load(html));
			break;
		}
		case "markdown":
		default:
			content = await htmlToMarkdownLocal(html, url);
			break;
	}

	return { content, status: response.status, source: "local" };
}
