import { getFirecrawlApiKey } from "./config.js";

interface FirecrawlResponse {
	success: boolean;
	data?: {
		markdown?: string;
		html?: string;
		metadata?: {
			title?: string;
			sourceURL?: string;
			description?: string;
			statusCode?: number;
		};
	};
	error?: string;
}

export interface FirecrawlFetchResult {
	content: string;
	title?: string;
	status: number;
	source: "firecrawl";
}

function markdownToPlainText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ""))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#+ /gm, "")
		.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(\*|_)(.*?)\1/g, "$2")
		.replace(/^\s*>\s?/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export async function fetchWithFirecrawl(
	url: string,
	format: "markdown" | "text" | "html",
	signal: AbortSignal | undefined,
): Promise<FirecrawlFetchResult> {
	const apiKey = await getFirecrawlApiKey();
	if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

	// Note: Firecrawl is a trusted third-party service, so we use fetch
	// directly here (no SSRF hardening needed for the known endpoint).
	const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
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
	const status = data.metadata?.statusCode ?? 200;

	if (format === "html" && data.html) {
		return { content: data.html, title, status, source: "firecrawl" };
	}

	if (format === "text") {
		return { content: markdownToPlainText(data.markdown || ""), title, status, source: "firecrawl" };
	}

	let markdown = data.markdown || "";
	if (title && !markdown.startsWith("# ")) {
		markdown = `# ${title}\n\n${markdown}`;
	}
	if (!markdown.includes("Source:") && data.metadata?.sourceURL) {
		markdown += `\n\n---\n\nSource: ${data.metadata.sourceURL}`;
	}

	return { content: markdown, title, status, source: "firecrawl" };
}
