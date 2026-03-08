import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";

const OUTPUT_DIR = join(import.meta.dirname, "..", "output");
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

function buildPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="Weekly AI-generated summaries of GitHub activity across the XRPL Ledger (XRPLF) organization. What shipped, what's in progress, and what to watch.">
<meta property="og:title" content="${title}">
<meta property="og:description" content="Weekly AI-generated summaries of GitHub activity across the XRPL Ledger (XRPLF) organization.">
<meta property="og:type" content="website">
<meta property="og:image" content="https://xrplbrew.com/og-image.png">
<meta property="og:url" content="https://xrplbrew.com">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="Weekly AI-generated summaries of XRPLF GitHub activity. What shipped, what's in progress, and what to watch.">
<meta name="twitter:image" content="https://xrplbrew.com/og-image.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>☕</text></svg>">
<style>
  :root { --bg: #0d1117; --fg: #c9d1d9; --fg-bright: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --border: #21262d; --card: #161b22; --card-hover: #1c2128; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.8; padding: 2rem 1.5rem; max-width: 780px; margin: 0 auto; font-size: 16px; -webkit-font-smoothing: antialiased; }
  h1 { font-size: 1.8rem; color: var(--fg-bright); margin: 2.5rem 0 1rem; padding-bottom: 0.6rem; border-bottom: 1px solid var(--border); letter-spacing: -0.02em; }
  h1 .date-subtitle { display: block; font-size: 1.15rem; font-weight: 400; color: var(--accent); margin-top: 0.3rem; }
  h1.site-title { font-size: 2.4rem; text-align: center; border: none; padding-bottom: 0; margin-bottom: 0.3rem; }
  h2 { font-size: 1.35rem; color: var(--accent); margin: 2.5rem 0 0.8rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border); letter-spacing: -0.01em; }
  h3 { font-size: 1.1rem; color: var(--fg-bright); margin: 1.8rem 0 0.5rem; }
  h4 { font-size: 1rem; color: var(--fg-bright); margin: 1.4rem 0 0.4rem; }
  p { margin: 0.8rem 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { color: var(--fg-bright); }
  code { background: var(--card); padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.88em; border: 1px solid var(--border); }
  ul, ol { padding-left: 1.5rem; margin: 0.8rem 0; }
  li { margin: 0.5rem 0; line-height: 1.7; }
  li p { margin: 0.3rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 1.2rem 0; font-size: 0.92em; }
  td { padding: 0.5rem 1rem; border: 1px solid var(--border); }
  tr:first-child td { font-weight: 600; color: var(--fg-bright); background: var(--card); }
  tr:nth-child(even) { background: rgba(22, 27, 34, 0.5); }
  blockquote { border-left: 3px solid var(--accent); padding: 0.6rem 1rem; color: var(--muted); margin: 1rem 0; background: rgba(22, 27, 34, 0.4); border-radius: 0 6px 6px 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
  .nav { margin-bottom: 2rem; font-size: 0.9rem; }
  .nav a { color: var(--muted); transition: color 0.2s; }
  .nav a:hover { color: var(--accent); text-decoration: none; }
  .tldr { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.2rem 1.5rem; margin: 1.2rem 0; font-size: 1.05em; line-height: 1.7; }
  .section-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.2rem 1.5rem; margin: 1rem 0; }
  footer { margin-top: 4rem; color: var(--muted); font-size: 0.82rem; border-top: 1px solid var(--border); padding-top: 1.2rem; text-align: center; line-height: 1.6; }
  .report-list { list-style: none; padding: 0; }
  .report-list li { margin: 0.6rem 0; }
  .report-list a { display: block; border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1.3rem; background: var(--card); transition: border-color 0.2s, background 0.2s; font-size: 1.05em; }
  .report-list a:hover { border-color: var(--accent); background: var(--card-hover); text-decoration: none; }
  .index-intro { text-align: center; color: var(--muted); max-width: 600px; margin: 0 auto; }
  .index-intro p { margin: 0.6rem 0; }
  .index-desc { font-size: 0.95em; line-height: 1.7; margin-top: 1.2rem; color: var(--fg); text-align: justify; }
  @media (max-width: 600px) { body { padding: 1rem; font-size: 15px; } h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; } .tldr { padding: 1rem; } }
</style>
</head>
<body>
${body}
<footer>
<p><strong>XRPL Monday Brew ☕</strong></p>
<p>AI-generated from reports <a href="https://github.com/XRPLF">XRPLF GitHub</a> repos using Claude &middot; Built by <a href="https://x.com/krkmu_">krkmu</a></p>
<p style="margin-top: 0.8rem; font-style: italic; opacity: 0.75;">Summaries are AI-generated. LLMs can hallucinate, misrepresent severity, or amplify facts beyond what the source data supports. Always verify claims against the linked PRs, issues, and official sources before acting on them.</p>
</footer>
</body>
</html>`;
}

// Build individual report pages
const reportLinks = [];
for (const file of summaries) {
  const md = readFileSync(join(OUTPUT_DIR, file), "utf-8");
  const slug = file.replace(".md", "");
  const html = markdownToHtml(md);
  const nav = `<div class="nav"><a href="index.html">&larr; All Reports</a></div>`;
  const page = buildPage(`XRPL Monday Brew ☕ — ${slug}`, nav + html);
  writeFileSync(join(SITE_DIR, `${slug}.html`), page, "utf-8");
  // Format date range: "Feb 28 – Mar 7, 2026"
  const [start, end] = slug.split("_");
  const fmt = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const year = end.slice(0, 4);
  const dateLabel = `${fmt(start)} – ${fmt(end)}, ${year}`;
  reportLinks.push({ slug, file, dateLabel });
  console.log(`  Built ${slug}.html`);
}

// Build index page
const indexBody = `
<h1 class="site-title">XRPL Monday Brew ☕</h1>
<div class="index-intro">
<p>Latest XRPL development news — AI-generated summaries of GitHub activity across the <a href="https://github.com/XRPLF">XRPLF</a> organization.</p>
<p class="index-desc">Ever wondered what's actually happening under the hood of XRPL? Who's merging what, which amendments are moving, what the core devs are cooking up? Grab your Monday coffee and catch up on a week's worth of development — no deep GitHub diving required. Whether you're a validator operator, a builder, or just crypto-curious, each brew breaks it down so you don't have to.</p>
</div>
<hr>
<ul class="report-list">
${reportLinks.map((r) => `<li><a href="${r.slug}.html">${r.dateLabel}</a></li>`).join("\n")}
</ul>
`;
writeFileSync(join(SITE_DIR, "index.html"), buildPage("XRPL Monday Brew ☕", indexBody), "utf-8");
console.log(`  Built index.html (${reportLinks.length} reports)`);
