import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WebBrowseConfig {
	firecrawlApiKey?: string;
}

export function getConfigPath(): string {
	return join(homedir(), ".pi", "agent", "web-browse.json");
}

async function loadConfigFile(): Promise<WebBrowseConfig> {
	try {
		const raw = await readFile(getConfigPath(), "utf8");
		return JSON.parse(raw) as WebBrowseConfig;
	} catch {
		return {};
	}
}

let cachedKey: string | undefined | null = null;

export function resetConfigCache(): void {
	cachedKey = null;
}

export async function getFirecrawlApiKey(): Promise<string | undefined> {
	if (cachedKey !== null) return cachedKey || undefined;
	if (process.env.FIRECRAWL_API_KEY) {
		cachedKey = process.env.FIRECRAWL_API_KEY;
		return cachedKey;
	}
	const config = await loadConfigFile();
	cachedKey = config.firecrawlApiKey ?? undefined;
	return cachedKey;
}

export async function hasFirecrawlKey(): Promise<boolean> {
	return !!(await getFirecrawlApiKey());
}

export function maskKey(key: string | undefined): string {
	if (!key) return "not set";
	if (key.length <= 4) return "****";
	return `${key.slice(0, 2)}${"*".repeat(Math.max(4, key.length - 4))}${key.slice(-2)}`;
}
