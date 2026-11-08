# Dev Deep Research MCP Server (`mcp-server-dev-research`)

![Dev Deep Research Architecture](./architecture.jpg)

A high-performance, 100% free Model Context Protocol (MCP) server designed specifically for developers and AI coding assistants. It executes deep research on coding bugs, compiler crashes, runtime exceptions, and dependency issues across **Stack Overflow**, **GitHub Closed Issues**, **Reddit dev communities**, and **technical documentation** simultaneously.

Unlike standard web searches that return superficial SEO links, this MCP server extracts **accepted answers, vote counts, maintainer resolutions, and raw code snippets directly into your AI assistant's context**.

---

## 🚀 Why Use This MCP Server Over Normal Search?

| Capability | Standard Web Search (Google / DDG) | Dev Deep Research MCP |
| :--- | :--- | :--- |
| **Output Type** | SEO snippets and page links | **Verified code fixes, diffs, and step-by-step solutions** |
| **Context Hygiene** | Returns 50KB+ HTML with ads, cookies, and navbars | **Clean, LLM-optimized Markdown** isolating only the solution |
| **Verified Answers** | AI must guess which answer works | Auto-detects `isAccepted: true` with vote scores via official APIs |
| **GitHub Closed Issues** | Returns generic repo links or issue titles | Extracts **maintainer resolutions and top-reacted solution comments** |
| **Anti-Bot & Blocks** | Often blocked by Cloudflare (403) or CAPTCHAs | Bypasses blocks using official REST endpoints and low-overhead mirrors |
| **Multi-Source Aggregation** | Searches generally across the open web | Concurrently queries **Stack Overflow + GitHub Issues + Reddit + Dev Articles** in a single call |
| **Speed & Token Savings** | High latency & token waste | **In-memory LRU caching** with near 0ms lookups on repeated errors |

---

## 🛠️ Features

* **Multi-Source Parallel Execution:** Automatically queries Stack Overflow, GitHub closed issues, Reddit developer discussions, and tech documentation concurrently.
* **Stack Overflow API Engine:** Uses StackExchange REST endpoints to isolate accepted answers and high-vote solutions without Cloudflare blocks.
* **GitHub Issues & Discussions:** Scrapes and queries closed issues, pulling reaction counts, maintainer resolutions, and community comments.
* **Reddit Thread Extractor:** Bypasses bot gates using lightweight endpoints to extract real developer workarounds and community fixes.
* **Error Sanitizer & Normalizer:** Automatically strips local file paths (e.g. `C:\Users\...` or `/var/log/...`), line numbers (`:42:15`), internal trace noise, and Webpack/Vite module prefixes (`(0, module.func)`) before querying.
* **Direct Thread Extractor (`fetch_thread_solution`):** Pass any Stack Overflow or GitHub issue URL to retrieve clean, formatted Markdown of the accepted answers and code blocks without ads or fluff.
* **In-Memory LRU Cache:** 15-minute rolling cache prevents redundant network round-trips for repeated errors.

---

## 📦 Tools Provided

### 1. `deep_research_coding_issue`
Performs multi-source deep research on an error message or technical question.

**Inputs:**
* `query` *(string, required)*: The exact error code, bug message, or technical problem.
* `framework_or_language` *(string, optional)*: E.g., `react`, `docker`, `mongodb`, `next.js`, `python`, `node`.
* `sources` *(array, optional)*: `['stackoverflow', 'github', 'reddit', 'web']` (defaults to all).
* `max_results_per_source` *(number, optional)*: 1–5 results per source (default: 3).

### 2. `fetch_thread_solution`
Extracts only the accepted answers, discussion resolutions, and code blocks from a target URL.

**Inputs:**
* `url` *(string, required)*: The URL of the Stack Overflow question, GitHub issue, or documentation page.

### 3. `find_commit_fix`
Searches merged GitHub pull requests and commits that solved a specific bug or technical problem, extracting the **actual Git diff (lines added `+` and removed `-`)**.

**Inputs:**
* `query` *(string, required)*: The bug, error code, or function failure (e.g. `"useActionState is not a function"`, `"SIGKILL 137"`).
* `repository` *(string, optional)*: Scope search to a specific GitHub repository (e.g. `"vercel/next.js"`, `"facebook/react"`).
* `max_results` *(number, optional)*: Number of merged PR fixes to retrieve (default: 3, max: 5).

---

## ⚙️ Installation & Configuration

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/YOUR_USERNAME/mcp-server-dev-research.git
cd mcp-server-dev-research
npm install
```

### 2. Add to your MCP Config (`mcp_config.json` or Claude Desktop / Antigravity Config)

```json
{
  "mcpServers": {
    "dev-research": {
      "command": "node",
      "args": [
        "path/to/mcp-server-dev-research/index.mjs"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "optional_token_for_higher_github_rate_limits"
      }
    }
  }
}
```

---

## 📄 License

MIT

