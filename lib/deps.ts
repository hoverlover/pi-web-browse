import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type TurndownConstructor = typeof import("turndown")["default"];
type CheerioModule = typeof import("cheerio");

let TurndownService: TurndownConstructor | undefined;
let cheerioMod: CheerioModule | undefined;

function resolveTurndown(mod: unknown, seen = new Set<unknown>()): TurndownConstructor | undefined {
	if (!mod || seen.has(mod)) return undefined;
	if (typeof mod === "function") return mod as TurndownConstructor;
	if (typeof mod !== "object") return undefined;
	seen.add(mod);
	const c = mod as Record<string, unknown>;
	return resolveTurndown(c.default, seen) ?? resolveTurndown(c.TurndownService, seen);
}

function resolveCheerio(mod: unknown, seen = new Set<unknown>()): CheerioModule | undefined {
	if (!mod || seen.has(mod)) return undefined;
	if (typeof mod === "object" && "load" in mod && typeof (mod as { load?: unknown }).load === "function") {
		return mod as CheerioModule;
	}
	if (typeof mod !== "object") return undefined;
	seen.add(mod);
	return resolveCheerio((mod as Record<string, unknown>).default, seen);
}

async function loadModule<T>(name: string, resolve: (m: unknown) => T | undefined): Promise<T> {
	let result: T | undefined;
	try {
		result = resolve(await import(name));
	} catch {
		// fall through to require
	}
	if (!result) {
		try {
			result = resolve(require(name));
		} catch {
			// fall through to throw
		}
	}
	if (!result) throw new Error(`Failed to load ${name}`);
	return result;
}

export async function getTurndown(): Promise<TurndownConstructor> {
	if (!TurndownService) TurndownService = await loadModule("turndown", resolveTurndown);
	return TurndownService;
}

export async function getCheerio(): Promise<CheerioModule> {
	if (!cheerioMod) cheerioMod = await loadModule("cheerio", resolveCheerio);
	return cheerioMod;
}

export function resetDepsCache(): void {
	TurndownService = undefined;
	cheerioMod = undefined;
}
