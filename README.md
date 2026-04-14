# pi-web-browse

Web browsing tools for [pi](https://shittycodingagent.ai) — fetch pages and search the web.

## Features

- **web_fetch** — Fetch and extract content as markdown, text, or HTML
- **web_search** — Pluggable search with Brave / Serper / Tavily / DuckDuckGo
- Optional **Firecrawl API** integration for superior content extraction
- Hardened `fetch`: SSRF protection, timeouts, body size caps, redirect limits
- Session history with `/web-history` and status via `/web-status`

## Installation

```bash
pi install git:github.com/hoverlover/pi-web-browse
```

## Tools

### web_fetch

Fetch content from a URL.

Parameters:
- `url` — URL to fetch (required; http/https only)
- `format` — `"markdown"` (default), `"text"`, or `"html"`
- `selector` — CSS selector for local extraction only (e.g. `"article"`, `".content"`)
- `maxLength` — max characters returned (default: 10000)
- `useFirecrawl` — prefer Firecrawl (default: true when key is available)

### web_search

Search the web.

Parameters:
- `query` — search query (required)
- `numResults` — 1–10 (default: 5)
- `provider` — `"brave"`, `"serper"`, `"tavily"`, or `"duckduckgo"` (optional)

## Search providers

Providers are preferred in this order, and the first with a configured API key is used. DuckDuckGo has no key and is the keyless fallback (but scrapes HTML, so it can break at any time).

| Provider   | Env var           | Signup                       |
|------------|-------------------|------------------------------|
| Brave      | `BRAVE_API_KEY`   | https://brave.com/search/api |
| Serper     | `SERPER_API_KEY`  | https://serper.dev           |
| Tavily     | `TAVILY_API_KEY`  | https://tavily.com           |
| DuckDuckGo | — (scraper)       | —                            |

You can force a specific provider via the `provider` argument, but the call will fail if that provider's key is not set.

## Configuration

`~/.pi/agent/web-browse.json` holds settings that persist across sessions:

```json
{
  "firecrawlApiKey": "fc-your-api-key-here"
}
```

### Firecrawl key resolution order
1. `FIRECRAWL_API_KEY` environment variable
2. `firecrawlApiKey` in `~/.pi/agent/web-browse.json`

Without a key, `web_fetch` falls back to local extraction (cheerio + turndown).

> Search provider keys (`BRAVE_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`) are read from environment variables only. Export them in your shell profile.

## Safety

`web_fetch` requests go through a hardened fetch wrapper:
- **Protocol allowlist**: http / https only
- **SSRF**: resolves DNS, blocks loopback, link-local, RFC1918, CGNAT, IPv4/IPv6 private ranges, and validates every redirect hop
- **Timeout**: 30 seconds per request
- **Body cap**: 5 MB (response is truncated beyond that)
- **Redirects**: up to 5, then rejected

Limitations: DNS rebinding is not fully prevented (lookup and connect happen separately). For high-assurance environments, route pi through a vetted egress proxy.

For testing only, set `PI_WEB_BROWSE_UNSAFE_DISABLE_SSRF=1` to bypass SSRF checks. Do not enable this in production.

## Commands

- `/web-history` — recent browsing activity in the current session
- `/web-status` — extension status, config path, provider availability
- `/web-status --reveal` — also print the full Firecrawl API key (masked by default)

## Example Workflows

Research:
```
Search for "Rust async runtime comparison"
```

Read docs:
```
Fetch https://docs.example.com/getting-started
```

Extract a section:
```
Fetch the API reference from https://api.example.com/docs using selector "#api-reference"
```

## License

MIT
