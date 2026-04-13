# pi-web-browse

Web browsing tools for [pi](https://shittycodingagent.ai) - fetch pages and search the web.

## Features

- **web_fetch** - Fetch and extract content from web pages as markdown, text, or HTML
- **web_search** - Search the web using DuckDuckGo (no API key required)
- Optional **Firecrawl API** integration for superior content extraction
- Session history tracking with `/web-history` command

## Installation

### From npm (when published)
```bash
pi install npm:pi-web-browse
```

### From local path
```bash
pi install /path/to/pi-web-browse
```

### From git
```bash
pi install git:github.com/yourusername/pi-web-browse
```

## Usage

Once installed, two new tools are available to the agent:

### web_fetch

Fetch content from a URL:

```
Fetch the React documentation from https://react.dev/learn/thinking-in-react
```

The agent will use the `web_fetch` tool to extract the content as markdown.

Parameters:
- `url` - The URL to fetch (required)
- `format` - Output format: `"markdown"` (default), `"text"`, or `"html"`
- `selector` - CSS selector to extract specific content (e.g., `"article"`, `".content"`)
- `maxLength` - Maximum characters to return (default: 10000)
- `useFirecrawl` - Use Firecrawl API (default: true if key is available)

### web_search

Search the web:

```
Search for "React Server Components best practices"
```

Parameters:
- `query` - The search query (required)
- `numResults` - Number of results (default: 5, max: 10)

## Configuration

This extension reads configuration from `~/.pi/agent/web-browse.json`. Create this file to persist settings across pi sessions.

### Config File Location

```
~/.pi/agent/web-browse.json
```

### Available Options

| Option | Type | Description |
|--------|------|-------------|
| `firecrawlApiKey` | `string` | Your Firecrawl API key for superior content extraction |

### Example Config

```json
{
  "firecrawlApiKey": "fc-your-api-key-here"
}
```

### API Key Resolution Order

The extension looks for the Firecrawl API key in this order:

1. `FIRECRAWL_API_KEY` environment variable
2. `firecrawlApiKey` in `~/.pi/agent/web-browse.json`

If neither is set, the extension falls back to local extraction using cheerio + turndown.

### Why Use a Config File?

The config file is the most convenient option because:
- It persists across pi sessions
- No need to edit shell profiles (`.zshrc`, `.bashrc`, etc.)
- No need to remember to export env vars before starting pi
- Keeps API keys separate from pi's core `settings.json`

## Firecrawl Integration (Recommended)

For the best content extraction quality, sign up for a free API key at [firecrawl.dev](https://www.firecrawl.dev/).

### What Firecrawl Provides
- Superior HTML-to-markdown conversion
- Better handling of JavaScript-rendered pages
- Cleaner extraction of article content
- Removes ads and navigation clutter automatically

Without Firecrawl, the extension falls back to local extraction using cheerio + turndown.

## Commands

- `/web-history` - Show recent web browsing activity from the current session
- `/web-status` - Show extension status, config file path, and Firecrawl configuration

Run `/web-status` to verify your config file is being read correctly.

## Example Workflows

### Research a topic
```
Search for "Rust async runtime comparison"
```

The agent will search and can then fetch the most relevant results for detailed reading.

### Read documentation
```
Fetch the guide at https://docs.example.com/getting-started
```

### Extract specific content
```
Fetch the API reference from https://api.example.com/docs using selector "#api-reference"
```

## License

MIT
