import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";

const OUTPUT_DIR = join(import.meta.dirname, "..", "output");
const DAILY_DIR = join(OUTPUT_DIR, "daily");
const SITE_DIR = join(import.meta.dirname, "..", "site");

mkdirSync(SITE_DIR, { recursive: true });

// Copy static assets
const STATIC_DIR = join(import.meta.dirname, "..", "static");
copyFileSync(join(STATIC_DIR, "og-image.png"), join(SITE_DIR, "og-image.png"));

// Find all summary markdown files (exclude _input files)
const summaries = readdirSync(OUTPUT_DIR)
  .filter((f) => f.endsWith(".md") && !f.includes("_input") && !f.startsWith("test"))
  .sort()
  .reverse();

function reorderSections(md) {
  // Strip Twitter section
  md = md.replace(/## TL;DR for X \(Twitter\)[\s\S]*?(?=\n## |\n---\n\*Summary|$)/, "");

  // Extract Plain English Summary, rename to Summary, move after TL;DR
  const plainMatch = md.match(/## Plain English Summary[\s\S]*?(?=\n---|\n## [^P]|$)/);
  if (plainMatch) {
    md = md.replace(plainMatch[0], "");
    const summary = plainMatch[0].replace("## Plain English Summary", "## Summary");
    md = md.replace(/(## (?:TL;DR|Headline)[\s\S]*?)\n---/, `$1\n\n${summary}\n---`);
  }

  // Replace footer disclaimer
  md = md.replace(
    /\*Summary AI-generated.*?\*/,
    ""
  );

  return md;
}

function markdownToHtml(md) {
  let html = reorderSections(md)
    // Headers
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+?):\s*(.+)$/gm, '<h1>$1<br><span class="date-subtitle">$2</span></h1>')
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Links — open external links in new tab
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Horizontal rules
    .replace(/^---+$/gm, "<hr>")
    // Tables
    .replace(/^\|(.+)\|$/gm, (match) => {
      const cells = match
        .split("|")
        .filter(Boolean)
        .map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) return ""; // separator row
      const tag = "td";
      return "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
    })
    // List items
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    // Blockquotes
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    // Paragraphs (lines not already wrapped)
    .replace(/^(?!<[hluotb]|<hr|<li|<blockquote|$)(.+)$/gm, "<p>$1</p>")
    // Wrap consecutive <li> in <ul>
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    // Wrap consecutive <tr> in <table>
    .replace(/(<tr>.*<\/tr>\n?)+/g, (match) => `<table>${match}</table>`)
    // Clean up empty lines
    .replace(/\n{3,}/g, "\n\n");

  // Wrap TL;DR content in a card
  html = html.replace(
    /(<h2>TL;DR<\/h2>)\s*([\s\S]*?)(?=<hr>|<h2>)/,
    (_, heading, content) => `${heading}\n<div class="tldr">${content.trim()}</div>\n`
  );

  // Wrap Summary paragraphs in a card
  html = html.replace(
    /(<h2>Summary<\/h2>)\s*([\s\S]*?)(?=<hr>|<h2>)/,
    (_, heading, content) => `${heading}\n<div class="section-card">${content.trim()}</div>\n`
  );

  return html;
}

function buildPage(title, body, { slug = "", description = "" } = {}) {
  const baseUrl = "https://xrplbrew.com";
  const pageUrl = slug ? `${baseUrl}/${slug}.html` : baseUrl;
  const desc = description || "AI-generated summaries of XRPL Ledger (XRPLF) GitHub activity — weekly deep-dives and daily espresso digests. What merged, what's in progress, and what to watch.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="${slug ? "article" : "website"}">
<meta property="og:image" content="${baseUrl}/og-image.png">
<meta property="og:url" content="${pageUrl}">
<meta property="og:site_name" content="XRPL Monday Brew">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@krkmu_">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${baseUrl}/og-image.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>☕</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #09090b;
    --bg-subtle: #0f0f12;
    --fg: #c8c8d0;
    --fg-bright: #fafafa;
    --muted: #71717a;
    --accent: #c4a882;
    --accent-dim: rgba(196, 168, 130, 0.12);
    --accent-blue: #60a5fa;
    --border: #1c1c22;
    --border-hover: #2a2a33;
    --card: #111114;
    --card-hover: #16161a;
    --radius: 10px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.75;
    padding: 3rem 1.5rem;
    max-width: 740px;
    margin: 0 auto;
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Fade-in animation */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-in { animation: fadeUp 0.5s ease-out both; }

  /* Typography */
  h1 {
    font-size: 1.65rem;
    font-weight: 700;
    color: var(--fg-bright);
    margin: 2.5rem 0 0.8rem;
    padding-bottom: 0.6rem;
    letter-spacing: -0.035em;
    border-bottom: none;
  }
  h1 .date-subtitle {
    display: block;
    font-size: 0.92rem;
    font-weight: 500;
    color: var(--accent);
    margin-top: 0.4rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  h1.site-title {
    font-size: 2rem;
    text-align: center;
    margin-bottom: 0.5rem;
    letter-spacing: -0.04em;
  }
  h2 {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--fg-bright);
    margin: 2.8rem 0 0.7rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
    letter-spacing: -0.02em;
  }
  h3 {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg-bright);
    margin: 2rem 0 0.4rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.82rem;
  }
  h4 { font-size: 0.92rem; font-weight: 600; color: var(--fg-bright); margin: 1.4rem 0 0.3rem; }
  p { margin: 0.7rem 0; }

  /* Links */
  a { color: var(--accent); text-decoration: none; transition: color 0.15s ease; }
  a:hover { color: var(--fg-bright); }

  strong { color: var(--fg-bright); font-weight: 600; }

  code {
    font-family: 'JetBrains Mono', monospace;
    background: var(--card);
    padding: 0.15rem 0.4rem;
    border-radius: 5px;
    font-size: 0.82em;
    border: 1px solid var(--border);
    color: var(--accent);
  }

  /* Lists */
  ul, ol { padding-left: 1.3rem; margin: 0.7rem 0; }
  li { margin: 0.45rem 0; line-height: 1.7; }
  li p { margin: 0.2rem 0; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 1.2rem 0; font-size: 0.88em; }
  td { padding: 0.55rem 0.9rem; border: 1px solid var(--border); }
  tr:first-child td { font-weight: 600; color: var(--fg-bright); background: var(--card); font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.03em; }
  tr:nth-child(even) { background: var(--bg-subtle); }

  blockquote {
    border-left: 2px solid var(--accent);
    padding: 0.5rem 1rem;
    color: var(--muted);
    margin: 1rem 0;
    background: var(--accent-dim);
    border-radius: 0 var(--radius) var(--radius) 0;
    font-size: 0.93em;
  }

  hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }

  /* Navigation */
  .nav { margin-bottom: 2.5rem; font-size: 0.85rem; }
  .nav a { color: var(--fg); transition: color 0.2s; }
  .nav a:hover { color: var(--accent); }

  /* Cards */
  .tldr {
    background: var(--accent-dim);
    border: 1px solid rgba(196, 168, 130, 0.18);
    border-radius: var(--radius);
    padding: 1.3rem 1.5rem;
    margin: 1.2rem 0;
    font-size: 1em;
    line-height: 1.75;
    color: var(--fg-bright);
  }
  .section-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.3rem 1.5rem;
    margin: 1rem 0;
  }

  /* Gen info */
  .gen-info {
    margin-top: 2.5rem;
    padding: 0.7rem 1rem;
    font-size: 0.78rem;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    text-align: center;
    font-style: italic;
  }

  /* Footer */
  footer {
    margin-top: 4rem;
    color: var(--muted);
    font-size: 0.78rem;
    border-top: 1px solid var(--border);
    padding-top: 1.5rem;
    text-align: center;
    line-height: 1.7;
  }
  footer { color: var(--fg); }
  footer a { color: var(--accent); }
  footer a:hover { color: var(--accent); }

  /* Report lists */
  .report-list { list-style: none; padding: 0; }
  .report-list li { margin: 0.5rem 0; }
  .report-list a {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.85rem 1.2rem;
    background: var(--card);
    transition: all 0.2s ease;
    font-size: 0.95em;
    font-weight: 500;
    color: var(--fg);
  }
  .report-list a:hover {
    border-color: var(--border-hover);
    background: var(--card-hover);
    color: var(--fg-bright);
    transform: translateX(3px);
  }
  .report-list a::before {
    margin-right: 0.7rem;
    font-size: 0.75em;
    opacity: 0.5;
  }
  .report-list:not(.espresso-list) a { border-left: 2px solid var(--accent-blue); }
  .report-list:not(.espresso-list) a:hover { border-left-color: var(--fg-bright); }
  .report-list:not(.espresso-list) a::before { content: "\\2192"; color: var(--accent-blue); }

  .espresso-list a { border-left: 2px solid var(--accent); }
  .espresso-list a:hover { border-left-color: var(--fg-bright); }
  .espresso-list a::before { content: "\\2192"; color: var(--accent); }

  .espresso-placeholder {
    color: var(--muted);
    font-style: italic;
    text-align: center;
    padding: 1.5rem;
    font-size: 0.9em;
  }

  /* Index page */
  .index-intro { text-align: center; max-width: 560px; margin: 0 auto; }
  .index-intro > p:first-child { color: var(--fg); font-size: 1.05em; line-height: 1.6; }
  .index-desc {
    font-size: 0.88em;
    line-height: 1.75;
    margin-top: 1.2rem;
    color: var(--fg);
    text-align: center;
  }

  /* Section labels */
  .section-label {
    display: inline-block;
    font-size: 1.05rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-bright);
    margin-bottom: 0.8rem;
  }

  /* Responsive */
  @media (max-width: 600px) {
    body { padding: 1.5rem 1rem; font-size: 14px; }
    h1 { font-size: 1.4rem; }
    h1.site-title { font-size: 1.7rem; }
    h2 { font-size: 1.05rem; }
    .tldr { padding: 1rem; }
    .report-list a { padding: 0.75rem 1rem; }
  }
</style>
</head>
<body>
${body}
<footer>
<p><strong style="color: var(--fg-bright); font-weight: 600;">XRPL Monday Brew ☕</strong></p>
<p style="margin-top: 0.4rem;">AI-generated from <a href="https://github.com/XRPLF">XRPLF GitHub</a> repos using Claude &middot; Built by <a href="https://x.com/krkmu_">krkmu</a></p>
<p style="margin-top: 0.8rem; font-style: italic; opacity: 0.7; font-size: 0.72rem;">Summaries are AI-generated. LLMs can hallucinate, misrepresent severity, or amplify facts. Always verify against the linked PRs, issues, and official sources.</p>
</footer>
<script data-goatcounter="https://xrplbrew.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
<script>
document.querySelectorAll('.animate-in').forEach((el, i) => { el.style.animationDelay = i * 0.08 + 's'; });
</script>
</body>
</html>`;
}

// Build individual weekly report pages
const reportLinks = [];
for (const file of summaries) {
  const md = readFileSync(join(OUTPUT_DIR, file), "utf-8");
  const slug = file.replace(".md", "");
  const html = markdownToHtml(md);
  const metaMatch = md.match(/<!-- generated: (.+?) \| model: (.+?) -->/);
  const genDate = metaMatch ? new Date(metaMatch[1]).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : null;
  const genModel = metaMatch ? metaMatch[2] : null;
  const genInfo = genDate ? `<div class="gen-info">Generated on ${genDate} using ${genModel}</div>` : "";
  const nav = `<div class="nav"><a href="index.html">&larr; All reports</a></div>`;
  const trimmedHtml = genInfo ? html.replace(/(<hr>\s*(<p>.*?<\/p>\s*)?){2,}$/, "") : html;
  const [start, end] = slug.split("_");
  const fmt = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const year = end.slice(0, 4);
  const dateLabel = `${fmt(start)} – ${fmt(end)}, ${year}`;
  const weeklyDesc = `XRPLF GitHub activity for ${dateLabel} — what merged, what's in progress, and what to watch across rippled, xrpl.js, xrpl-py, and more.`;
  const page = buildPage(`XRPL Monday Brew ☕ — ${dateLabel}`, `<div class="animate-in">${nav}${trimmedHtml}${genInfo}</div>`, { slug, description: weeklyDesc });
  writeFileSync(join(SITE_DIR, `${slug}.html`), page, "utf-8");
  reportLinks.push({ slug, file, dateLabel });
  console.log(`  Built ${slug}.html`);
}

// Build daily espresso pages
const espressoLinks = [];
if (existsSync(DAILY_DIR)) {
  const dailyFiles = readdirSync(DAILY_DIR)
    .filter((f) => f.endsWith(".md") && !f.includes("_input"))
    .sort()
    .reverse();

  for (const file of dailyFiles) {
    const md = readFileSync(join(DAILY_DIR, file), "utf-8");
    const slug = `espresso-${file.replace(".md", "")}`;
    const html = markdownToHtml(md);
    const metaMatch = md.match(/<!-- generated: (.+?) \| model: (.+?) -->/);
    const genDate = metaMatch ? new Date(metaMatch[1]).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : null;
    const genModel = metaMatch && metaMatch[2] !== "none" ? metaMatch[2] : null;
    const genInfo = genDate && genModel ? `<div class="gen-info">Generated on ${genDate} using ${genModel}</div>` : "";
    const nav = `<div class="nav"><a href="index.html">&larr; All reports</a></div>`;
    const date = file.replace(".md", "");
    const dayLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    const espressoDesc = `Daily XRPLF development digest for ${dayLabel} — quick summary of PRs merged, issues opened, and discussions across XRPL repos.`;
    const page = buildPage(`Daily Espresso ☕ — ${dayLabel}`, `<div class="animate-in">${nav}${html}${genInfo}</div>`, { slug, description: espressoDesc });
    writeFileSync(join(SITE_DIR, `${slug}.html`), page, "utf-8");
    espressoLinks.push({ slug, date, dayLabel });
    console.log(`  Built ${slug}.html`);
  }
}

// Build espresso section HTML
const latestWeeklyDate = reportLinks.length > 0 ? reportLinks[0].slug.split("_")[1] : null;
let espressoSection = "";
if (espressoLinks.length > 0) {
  espressoSection = `
<div class="animate-in">
<p class="section-label">Daily Espresso</p>
<p style="color: var(--fg); margin-bottom: 1rem; font-size: 0.88em;">Quick daily digests — Tuesday through Friday, between each weekly brew.</p>
<ul class="report-list espresso-list">
${espressoLinks.map((e) => `<li><a href="${e.slug}.html">${e.dayLabel}</a></li>`).join("\n")}
</ul>
</div>`;
} else if (latestWeeklyDate) {
  espressoSection = `
<div class="animate-in">
<p class="section-label">Daily Espresso</p>
<p class="espresso-placeholder">The weekly brew is fresh — espresso service resumes Tuesday.</p>
</div>`;
}

// Build index page
const indexBody = `
<div class="animate-in">
<h1 class="site-title">XRPL Monday Brew ☕</h1>
<div class="index-intro">
<p>AI-generated summaries of development activity across the <a href="https://github.com/XRPLF">XRPLF</a> organization.</p>
<p class="index-desc">What's merging, which amendments are moving, what the core devs are building. Weekly deep-dives on Mondays, quick espresso shots Tuesday through Friday.</p>
</div>
</div>
<hr>
${espressoSection}
${espressoLinks.length > 0 ? "<hr>" : ""}
<div class="animate-in">
<p class="section-label">Weekly Brews</p>
<ul class="report-list">
${reportLinks.map((r) => `<li><a href="${r.slug}.html">${r.dateLabel}</a></li>`).join("\n")}
</ul>
</div>
`;
writeFileSync(join(SITE_DIR, "index.html"), buildPage("XRPL Monday Brew ☕", indexBody), "utf-8");
console.log(`  Built index.html (${reportLinks.length} weekly, ${espressoLinks.length} daily)`);
