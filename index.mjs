#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Configure clean turndown rules
turndownService.remove(['script', 'style', 'nav', 'footer', 'iframe', 'svg']);

const server = new Server(
  {
    name: 'dev-deep-research',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// -------------------------------------------------------------
// In-Memory LRU-Style Cache (TTL: 15 minutes)
// -------------------------------------------------------------
const CACHE_TTL_MS = 15 * 60 * 1000;
const memoryCache = new Map();

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  if (memoryCache.size > 200) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// -------------------------------------------------------------
// Query Sanitizer, Normalizer & Intent Classifier
// -------------------------------------------------------------
function detectQueryIntent(query) {
  if (!query) return 'general';
  const lower = query.toLowerCase();

  // Explicit Bug / Error triggers
  const bugPatterns = [
    /\b(?:error|exception|err_|failed|failure|fatal|crash|panic|segfault)\b/i,
    /\b(?:cannot|can't|unable to|could not)\s+(?:find|read|import|resolve|connect|bind|load|parse)\b/i,
    /\b(?:undefined|null|nan|is not a function|not defined|not assignable)\b/i,
    /\b(?:400|401|403|404|429|500|502|503|504)\s+(?:bad request|unauthorized|forbidden|not found|internal)\b/i,
    /\b(?:exit code\s+\d+|sigkill|sigterm|out of memory|oom)\b/i,
    /\b(?:bug|broken|regression|reproduce|fix|workaround)\b/i,
    /:\d+:\d+/, // stack line numbers
  ];

  for (const pattern of bugPatterns) {
    if (pattern.test(lower)) return 'bug';
  }

  return 'general';
}

function cleanErrorQuery(rawQuery) {
  if (!rawQuery) return '';
  return rawQuery
    // Strip Webpack/Vite module prefixes e.g. (0 , react__WEBPACK_IMPORTED_MODULE_0__.xxx) -> xxx
    .replace(/\(\s*0\s*,\s*[^.]+\.([a-zA-Z0-9_$]+)\s*\)/g, '$1')
    .replace(/[a-zA-Z0-9_$]+__WEBPACK_[^.]+\./g, '')
    // Remove Windows file paths like C:\Users\... or /home/...
    .replace(/[a-zA-Z]:\\[^:\s\n]+\\?/g, ' ')
    .replace(/(?:\/[\w.-]+)+\/?/g, ' ')
    // Remove line numbers like :12:34 or (node:internal/...)
    .replace(/:\d+:\d+/g, ' ')
    .replace(/\(node:[^)]+\)/g, ' ')
    // Remove common log prefixes
    .replace(/^(?:Error|TypeError|ReferenceError|SyntaxError):\s*/i, '')
    // Normalize excess whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Optional GitHub PAT from environment for higher rate limits
const GITHUB_TOKEN =
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
  process.env.GITHUB_TOKEN ||
  null;

function getGitHubHeaders() {
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'DevResearchMCP-Server/1.0',
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

// -------------------------------------------------------------
// Helper: Generic web fetcher with timeout
// -------------------------------------------------------------
async function safeFetch(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/json,*/*',
        ...(options.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// -------------------------------------------------------------
// 1. Stack Overflow Search & Answers (Free StackExchange API)
// -------------------------------------------------------------
async function searchStackOverflow(query, tags = '', limit = 3) {
  try {
    // Attempt tagged query first, then fall back to untagged, then title search
    const fetchSO = async (withTag, useTitle = false) => {
      const tagParam = withTag && tags ? `&tagged=${encodeURIComponent(tags.replace(/[^a-zA-Z0-9.#-]/g, ''))}` : '';
      const cleanQ = cleanErrorQuery(query);
      const queryParam = useTitle ? `&title=${encodeURIComponent(cleanQ)}` : `&q=${encodeURIComponent(cleanQ)}`;
      const searchUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes${queryParam}${tagParam}&site=stackoverflow&pagesize=${limit}&filter=withbody`;
      const res = await safeFetch(searchUrl);
      if (!res.ok) return [];
      const data = await res.json();
      return data.items || [];
    };

    let items = tags ? await fetchSO(true) : [];
    if (!items.length) {
      items = await fetchSO(false);
    }
    if (!items.length) {
      items = await fetchSO(false, true);
    }

    const results = await Promise.all(
      items.map(async (q) => {
        const qObj = {
          source: 'Stack Overflow',
          title: q.title,
          url: q.link,
          score: q.score,
          isAnswered: q.is_answered,
          acceptedAnswerId: q.accepted_answer_id,
          questionBody: turndownService.turndown(q.body || '').slice(0, 1500),
          answers: [],
        };

        // Fetch top-voted answers concurrently
        if (q.question_id && q.is_answered) {
          try {
            const ansUrl = `https://api.stackexchange.com/2.3/questions/${q.question_id}/answers?order=desc&sort=votes&site=stackoverflow&pagesize=2&filter=withbody`;
            const ansRes = await safeFetch(ansUrl);
            if (ansRes.ok) {
              const ansData = await ansRes.json();
              if (Array.isArray(ansData.items)) {
                for (const ans of ansData.items) {
                  const bodyMd = turndownService.turndown(ans.body || '');
                  qObj.answers.push({
                    isAccepted: !!ans.is_accepted,
                    score: ans.score,
                    body: bodyMd.slice(0, 3000),
                  });
                }
              }
            }
          } catch (_) { }
        }
        return qObj;
      })
    );
    return results;
  } catch (err) {
    return [{ source: 'Stack Overflow', error: err.message }];
  }
}

// -------------------------------------------------------------
// 2. GitHub Issues & Resolutions Search (Free GitHub REST API)
// -------------------------------------------------------------
async function searchGitHubIssues(query, language = '', limit = 3, intent = 'bug') {
  try {
    const sanitized = cleanErrorQuery(query);
    const langFilter = language ? `+language:${encodeURIComponent(language)}` : '';
    // If it's a bug, closed issues have the accepted solutions.
    // If it's a general topic/feature/how-to, search all issues and discussions for architecture and guides.
    const stateFilter = intent === 'bug' ? '+state:closed' : '';
    const qString = `${encodeURIComponent(sanitized)}+in:title,body+type:issue${stateFilter}${langFilter}`;
    const url = `https://api.github.com/search/issues?q=${qString}&sort=comments&order=desc&per_page=${limit}`;

    const res = await safeFetch(url, {
      headers: getGitHubHeaders(),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const items = data.items || [];

    const results = await Promise.all(
      items.map(async (item) => {
        const issueObj = {
          source: intent === 'bug' ? 'GitHub Closed Issues' : 'GitHub Issues & Discussions',
          title: item.title,
          url: item.html_url,
          state: item.state,
          commentsCount: item.comments,
          body: (item.body || '').slice(0, 1000),
          topComments: [],
        };

        // Fetch solution comments concurrently
        if (item.comments > 0 && item.comments_url) {
          try {
            const commRes = await safeFetch(`${item.comments_url}?per_page=3&direction=desc`, {
              headers: getGitHubHeaders(),
            });
            if (commRes.ok) {
              const commData = await commRes.json();
              if (Array.isArray(commData)) {
                issueObj.topComments = commData.map((c) => ({
                  user: c.user?.login,
                  reactions: c.reactions?.total_count || 0,
                  body: (c.body || '').slice(0, 2000),
                }));
              }
            }
          } catch (_) { }
        }

        return issueObj;
      })
    );
    return results;
  } catch (err) {
    return [{ source: 'GitHub Issues', error: err.message }];
  }
}

// -------------------------------------------------------------
// 2B. Search Merged PRs and Commit Fixes (Git Diffs)
// -------------------------------------------------------------
async function findCommitFix(query, repository = '', limit = 3) {
  try {
    const cleanQ = cleanErrorQuery(query);
    const repoFilter = repository ? `+repo:${encodeURIComponent(repository)}` : '';
    const qString = `${encodeURIComponent(cleanQ)}+type:pr+is:merged${repoFilter}`;
    const url = `https://api.github.com/search/issues?q=${qString}&sort=updated&order=desc&per_page=${limit}`;

    const res = await safeFetch(url, {
      headers: getGitHubHeaders(),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const items = data.items || [];

    const fixPromises = items
      .filter((item) => Boolean(item.pull_request?.url))
      .map(async (item) => {
        const fixItem = {
          title: item.title,
          prUrl: item.html_url,
          state: 'merged',
          author: item.user?.login,
          diff: '',
        };

        try {
          // Try fetching via .diff on the web URL first (fast & reliable)
          const webDiffRes = await safeFetch(`${item.html_url}.diff`);
          if (webDiffRes.ok) {
            const diffText = await webDiffRes.text();
            fixItem.diff = diffText.slice(0, 4000);
          } else {
            // Fallback to GitHub REST API diff
            const diffRes = await safeFetch(item.pull_request.url, {
              headers: {
                ...getGitHubHeaders(),
                Accept: 'application/vnd.github.v3.diff',
              },
            });
            if (diffRes.ok) {
              const diffText = await diffRes.text();
              fixItem.diff = diffText.slice(0, 4000);
            }
          }
        } catch (_) { }

        return fixItem;
      });

    return await Promise.all(fixPromises);
  } catch (err) {
    return [{ error: err.message }];
  }
}

// -------------------------------------------------------------
// 3. Search DuckDuckGo (Reddit, Tech Blogs, Articles)
// -------------------------------------------------------------
async function searchWebViaDDG(query, siteFilter = '', limit = 4) {
  try {
    const fullQuery = siteFilter ? `site:${siteFilter} ${query}` : query;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}`;

    const res = await safeFetch(url, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((_, element) => {
      if (results.length >= limit) return false;
      const title = $(element).find('.result__title a').text().trim();
      const rawUrl = $(element).find('.result__title a').attr('href') || '';
      const snippet = $(element).find('.result__snippet').text().trim();

      // Clean redirect URLs from DDG if present
      let cleanUrl = rawUrl;
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        cleanUrl = decodeURIComponent(uddgMatch[1]);
      }

      if (title && cleanUrl) {
        results.push({
          source: siteFilter ? `Web (${siteFilter})` : 'Web Article',
          title,
          url: cleanUrl,
          snippet,
        });
      }
    });

    return results;
  } catch (err) {
    return [{ source: 'Web', error: err.message }];
  }
}

// -------------------------------------------------------------
// 4. Fetch and Clean specific URL / solution page
// -------------------------------------------------------------
async function extractThreadSolution(targetUrl) {
  try {
    // 4A. Stack Overflow: Use official API to bypass Cloudflare/403 blocks
    const soMatch = targetUrl.match(/stackoverflow\.com\/questions\/(\d+)/);
    if (soMatch) {
      const qid = soMatch[1];
      const [qRes, ansRes] = await Promise.all([
        safeFetch(`https://api.stackexchange.com/2.3/questions/${qid}?site=stackoverflow&filter=withbody`),
        safeFetch(
          `https://api.stackexchange.com/2.3/questions/${qid}/answers?order=desc&sort=votes&site=stackoverflow&pagesize=3&filter=withbody`
        ),
      ]);

      let markdown = '';
      if (qRes.ok) {
        const qData = await qRes.json();
        const q = qData.items?.[0];
        if (q) {
          markdown += `# ${q.title}\n\n**Question:**\n${turndownService.turndown(q.body || '')}\n\n---\n\n`;
        }
      }

      if (ansRes.ok) {
        const aData = await ansRes.json();
        const answers = aData.items || [];
        answers.forEach((ans, i) => {
          markdown += `## Solution ${i + 1} (${ans.is_accepted ? 'Accepted Answer, ' : ''}Score: ${ans.score})\n`;
          markdown += `${turndownService.turndown(ans.body || '')}\n\n---\n\n`;
        });
      }

      if (markdown) return markdown.slice(0, 12000);
    }

    // 4B. GitHub Issue: Use official GitHub REST API for 100% reliable comments & markdown
    const ghMatch = targetUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (ghMatch) {
      const [, owner, repo, issueNum] = ghMatch;
      const [issueRes, commRes] = await Promise.all([
        safeFetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'DevResearchMCP-Server/1.0',
          },
        }),
        safeFetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}/comments?per_page=5&direction=desc`,
          {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'DevResearchMCP-Server/1.0',
            },
          }
        ),
      ]);

      let markdown = '';
      if (issueRes.ok) {
        const issue = await issueRes.json();
        markdown += `# ${issue.title} (Status: ${issue.state})\n\n${issue.body || ''}\n\n---\n\n`;
      }

      if (commRes.ok) {
        const comments = await commRes.json();
        if (Array.isArray(comments)) {
          comments.forEach((c) => {
            markdown += `### Comment by @${c.user?.login} (Reactions: ${c.reactions?.total_count || 0})\n`;
            markdown += `${c.body || ''}\n\n---\n\n`;
          });
        }
      }

      if (markdown) return markdown.slice(0, 12000);
    }

    // 4C. Reddit Thread: Use old.reddit.com to cleanly parse community discussions
    if (targetUrl.includes('reddit.com/r/')) {
      const oldRedditUrl = targetUrl.replace(/https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
      const res = await safeFetch(oldRedditUrl);
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);
        const title = $('a.title').first().text().trim();
        const postBody = $('div.expando .usertext-body .md').first().text().trim();
        let markdown = `# ${title}\n\n${postBody}\n\n---\n\n## Community Solutions / Workarounds\n\n`;

        $('div.nestedlisting div.comment .usertext-body .md').each((_, el) => {
          const text = $(el).text().trim();
          if (text) {
            markdown += `* ${text}\n\n`;
          }
        });
        return markdown.slice(0, 12000);
      }
    }

    // 4D. General Documentation or Blog Post
    const res = await safeFetch(targetUrl);
    if (!res.ok) {
      return `Failed to fetch page (status ${res.status}): ${targetUrl}`;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    $('script, style, noscript, nav, header, footer, aside, .advertisement, #cookie-banner').remove();

    const mainContent = $('article, main, .main-content, #content, .post-content, body');
    const contentHtml = mainContent.length > 0 ? mainContent.first().html() : $('body').html();
    const extractedText = turndownService.turndown(contentHtml || '');

    return extractedText.slice(0, 12000);
  } catch (err) {
    return `Error extracting solution from ${targetUrl}: ${err.message}`;
  }
}

// -------------------------------------------------------------
// Tool Registration
// -------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'deep_research_coding_issue',
        description:
          'Deep research for coding problems, errors, and bugs across Stack Overflow, GitHub closed issues, Reddit dev communities, and web documentation. Returns accepted solutions, approaches, workarounds, and code examples.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The exact error message, bug description, or technical problem statement.',
            },
            framework_or_language: {
              type: 'string',
              description: 'Optional framework, library, or language (e.g. "react", "next.js", "docker", "mongodb", "python", "node").',
            },
            sources: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['stackoverflow', 'github', 'reddit', 'web'],
              },
              description: 'Sources to search. Defaults to searching all sources simultaneously.',
            },
            max_results_per_source: {
              type: 'number',
              description: 'Max results per source (default 3, max 5).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch_thread_solution',
        description:
          'Fetches a specific Stack Overflow answer, GitHub issue thread, or web article URL and extracts only the relevant code and solution without boilerplate.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL of the Stack Overflow question, GitHub issue, or documentation page.',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'find_commit_fix',
        description:
          'Searches merged GitHub pull requests and commits that solved a specific bug, error, or feature issue, returning the exact Git code diff (lines added/removed).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The bug or error message to find commit/PR fixes for (e.g. "useActionState is not a function", "SIGKILL 137").',
            },
            repository: {
              type: 'string',
              description: 'Optional GitHub repository to scope search to (e.g. "vercel/next.js", "facebook/react").',
            },
            max_results: {
              type: 'number',
              description: 'Max merged PR fixes to retrieve (default 3, max 5).',
            },
          },
          required: ['query'],
        },
      },
    ],
  };
});

// -------------------------------------------------------------
// Tool Execution Handler
// -------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'deep_research_coding_issue') {
    const rawQuery = args?.query || '';
    const query = cleanErrorQuery(rawQuery);
    const framework = args?.framework_or_language || '';
    const selectedSources = args?.sources || ['stackoverflow', 'github', 'reddit', 'web'];
    const limit = Math.min(Math.max(Number(args?.max_results_per_source) || 3, 1), 5);
    const intent = detectQueryIntent(rawQuery);

    // Check cache
    const cacheKey = `research:${query}:${framework}:${selectedSources.sort().join(',')}:${limit}:${intent}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...cached, from_cache: true }, null, 2),
          },
        ],
      };
    }

    const tasks = [];

    if (selectedSources.includes('stackoverflow')) {
      tasks.push(searchStackOverflow(query, framework, limit));
    }
    if (selectedSources.includes('github')) {
      tasks.push(searchGitHubIssues(query, framework, limit, intent));
    }
    if (selectedSources.includes('reddit')) {
      tasks.push(searchWebViaDDG(query, 'reddit.com', limit));
    }
    if (selectedSources.includes('web')) {
      // Adaptive query formulation:
      // If a bug, bias towards fixes and troubleshooting threads
      // If general, bias towards authoritative guides, architecture, and documentation
      const webQuery = intent === 'bug'
        ? `${query} ${framework} solution fix`
        : `${query} ${framework} guide documentation`;
      tasks.push(searchWebViaDDG(webQuery, '', limit));

      // For general topics, also run an extra concurrent task targeting official docs
      if (intent === 'general' && framework) {
        tasks.push(searchWebViaDDG(`${query} site:${encodeURIComponent(framework)}.org OR site:docs.${encodeURIComponent(framework)}.org OR site:developer.mozilla.org`, '', 2));
      }
    }

    const settled = await Promise.allSettled(tasks);
    const combinedResults = [];

    for (const res of settled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        combinedResults.push(...res.value);
      }
    }

    const payload = {
      query,
      intent,
      framework: framework || 'none specified',
      total_findings: combinedResults.length,
      findings: combinedResults,
    };

    setCache(cacheKey, payload);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  if (name === 'fetch_thread_solution') {
    const url = args?.url;
    if (!url) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: url is required.' }],
      };
    }

    const cleanContent = await extractThreadSolution(url);
    return {
      content: [
        {
          type: 'text',
          text: cleanContent,
        },
      ],
    };
  }

  if (name === 'find_commit_fix') {
    const query = args?.query || '';
    const repo = args?.repository || '';
    const limit = Math.min(Math.max(Number(args?.max_results) || 3, 1), 5);

    const fixes = await findCommitFix(query, repo, limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query,
              repository: repo || 'all public repositories',
              fixes_found: fixes.length,
              fixes,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

export {
  searchStackOverflow,
  searchGitHubIssues,
  findCommitFix,
  searchWebViaDDG,
  extractThreadSolution,
};

// -------------------------------------------------------------
// Server Start
// -------------------------------------------------------------
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  run().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  });
}

