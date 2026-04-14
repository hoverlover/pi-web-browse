/**
 * Hardened fetch wrapper: SSRF protection, byte cap, timeout, manual redirects.
 *
 * Limitations:
 * - DNS rebinding is not fully prevented (we validate at lookup time, not at
 *   connect time). For higher assurance, proxy through a trusted egress.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeFetchOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	/** Bypass SSRF checks. ONLY for test URLs explicitly controlled by the caller. */
	allowPrivate?: boolean;
}

export interface SafeFetchResult {
	status: number;
	statusText: string;
	headers: Headers;
	url: string;
	body: string;
	truncated: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

export class SafeFetchError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "SafeFetchError";
	}
}

function ipv4ToInt(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	let n = 0;
	for (const p of parts) {
		const x = Number(p);
		if (!Number.isInteger(x) || x < 0 || x > 255) return undefined;
		n = (n << 8) | x;
	}
	return n >>> 0;
}

export function isPrivateIpv4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === undefined) return false;
	const inRange = (cidr: string) => {
		const [base, bits] = cidr.split("/");
		const baseN = ipv4ToInt(base)!;
		const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
		return (n & mask) === (baseN & mask);
	};
	return (
		inRange("0.0.0.0/8") ||
		inRange("10.0.0.0/8") ||
		inRange("127.0.0.0/8") ||
		inRange("169.254.0.0/16") ||
		inRange("172.16.0.0/12") ||
		inRange("192.168.0.0/16") ||
		inRange("100.64.0.0/10") ||
		inRange("224.0.0.0/4") ||
		inRange("240.0.0.0/4")
	);
}

export function isPrivateIpv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	// IPv4-mapped: ::ffff:a.b.c.d
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isPrivateIpv4(mapped[1]);
	// Parse first hextet for range checks
	const first = parseInt(lower.split(":")[0] || "0", 16);
	if (Number.isNaN(first)) return false;
	// fc00::/7 (unique local)
	if ((first & 0xfe00) === 0xfc00) return true;
	// fe80::/10 (link-local)
	if ((first & 0xffc0) === 0xfe80) return true;
	// ff00::/8 (multicast)
	if ((first & 0xff00) === 0xff00) return true;
	return false;
}

export function isPrivateIp(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateIpv4(ip);
	if (version === 6) return isPrivateIpv6(ip);
	return false;
}

async function assertPublicUrl(url: URL): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SafeFetchError(`Only http and https URLs are allowed (got ${url.protocol})`, "BAD_PROTOCOL");
	}
	// URL hostnames for IPv6 literals are bracketed (e.g. "[::1]"); strip.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host) {
		throw new SafeFetchError("URL has no hostname", "BAD_HOST");
	}
	if (isIP(host)) {
		if (isPrivateIp(host)) {
			throw new SafeFetchError(`Refusing to fetch private/loopback address: ${host}`, "PRIVATE_IP");
		}
		return;
	}
	// Resolve all A/AAAA records
	let addrs: { address: string; family: number }[];
	try {
		addrs = await lookup(host, { all: true });
	} catch (err) {
		throw new SafeFetchError(`DNS lookup failed for ${host}: ${(err as Error).message}`, "DNS_FAIL");
	}
	if (addrs.length === 0) {
		throw new SafeFetchError(`No addresses resolved for ${host}`, "DNS_EMPTY");
	}
	for (const { address } of addrs) {
		if (isPrivateIp(address)) {
			throw new SafeFetchError(
				`Refusing to fetch ${host} — resolves to private address ${address}`,
				"PRIVATE_IP",
			);
		}
	}
}

async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			// Keep only up to maxBytes
			const overflow = total - maxBytes;
			const keep = value.byteLength - overflow;
			if (keep > 0) chunks.push(value.subarray(0, keep));
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
	}
	const buf = Buffer.concat(chunks);
	return { text: buf.toString("utf8"), truncated };
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

	const timeoutCtrl = new AbortController();
	const timer = setTimeout(() => timeoutCtrl.abort(new Error("timeout")), timeoutMs);

	const combinedSignal = opts.signal
		? AbortSignal.any([opts.signal, timeoutCtrl.signal])
		: timeoutCtrl.signal;

	const bypass = opts.allowPrivate || process.env.PI_WEB_BROWSE_UNSAFE_DISABLE_SSRF === "1";

	try {
		let currentUrl = new URL(rawUrl);
		let hops = 0;
		while (true) {
			if (!bypass) await assertPublicUrl(currentUrl);

			const response = await fetch(currentUrl, {
				method: opts.method ?? "GET",
				headers: opts.headers,
				body: opts.body,
				redirect: "manual",
				signal: combinedSignal,
			});

			if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
				if (hops >= maxRedirects) {
					throw new SafeFetchError(`Exceeded max redirects (${maxRedirects})`, "TOO_MANY_REDIRECTS");
				}
				hops++;
				const next = new URL(response.headers.get("location")!, currentUrl);
				currentUrl = next;
				// Drain the body so the connection can be reused
				await response.body?.cancel().catch(() => {});
				continue;
			}

			const { text, truncated } = await readBodyCapped(response, maxBytes);
			return {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				url: currentUrl.toString(),
				body: text,
				truncated,
			};
		}
	} finally {
		clearTimeout(timer);
	}
}
