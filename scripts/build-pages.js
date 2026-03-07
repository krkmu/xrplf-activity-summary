import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const OUTPUT_DIR = join(import.meta.dirname, "..", "output");
const SITE_DIR = join(import.meta.dirname, "..", "site");

mkdirSync(SITE_DIR, { recursive: true });

// Find all summary markdown files (exclude _input files)
const summaries = readdirSync(OUTPUT_DIR)
  .filter((f) => f.endsWith(".md") && !f.includes("_input") && !f.startsWith("test"))
  .sort()
  .reverse();

function reorderSections(md) {
  // Strip Twitter section
  md = md.replace(/## TL;DR for X \(Twitter\)[\s\S]*?(?=\n## |\n---\n\*Summary|$)/, "");

  // Extract Plain English Summary, rename to Summary, move after Headline
  const plainMatch = md.match(/## Plain English Summary[\s\S]*?(?=\n---|\n## [^P]|$)/);
  if (plainMatch) {
    md = md.replace(plainMatch[0], "");
    const summary = plainMatch[0].replace("## Plain English Summary", "## Summary");
    // Insert after Headline section
    md = md.replace(/(## Headline[\s\S]*?)\n---/, `$1\n\n${summary}\n---`);
  }

  // Replace footer disclaimer
  md = md.replace(
    /\*Summary AI-generated.*?\*/,
    ""
  );

  return md;
}

function markdownToHtml(md) {
  return reorderSections(md)
    // Headers
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
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
}

function buildPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --border: #30363d; --card: #161b22; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin-top: 2rem; margin-bottom: 0.5rem; color: var(--accent); }
  h3 { font-size: 1.1rem; margin-top: 1.5rem; margin-bottom: 0.3rem; }
  p { margin: 0.5rem 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: var(--card); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
  ul { padding-left: 1.5rem; margin: 0.5rem 0; }
  li { margin: 0.3rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  td { padding: 0.4rem 0.8rem; border: 1px solid var(--border); }
  tr:nth-child(even) { background: var(--card); }
  blockquote { border-left: 3px solid var(--accent); padding-left: 1rem; color: var(--muted); margin: 0.5rem 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
  .nav { margin-bottom: 2rem; }
  .nav a { margin-right: 1rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--border); padding-top: 1rem; text-align: center; }
</style>
</head>
<body>
${body}
<footer>
<p>XRPL Monday Brew ☕ &middot; AI-generated using Claude (${process.env.CLAUDE_MODEL || "claude-sonnet-4-6"}) from <a href="https://github.com/XRPLF">XRPLF GitHub</a> repos data &middot; Proposed by <a href="https://x.com/krkmu_">krkmu</a></p>
<p style="margin-top: 0.5rem;">Disclaimer: Summaries are AI-generated. LLMs can hallucinate, misrepresent severity, or amplify facts beyond what the source data supports. Always verify claims against the linked PRs, issues, and official sources before acting on them.</p>
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
  reportLinks.push({ slug, file });
  console.log(`  Built ${slug}.html`);
}

// Build index page
const indexBody = `
<h1>XRPL Monday Brew ☕</h1>
<p>Latest development news — AI-generated summaries of GitHub activity across the <a href="https://github.com/XRPLF">XRPLF</a> organization.</p>
<p style="margin-top: 1rem;">Ever wondered what's actually happening under the hood of XRPL? Who's merging what, which amendments are moving, what the core devs are cooking up? Grab your Monday coffee and catch up on a week's worth of development — no deep GitHub diving required. Whether you're a validator operator, a builder, or just crypto-curious, each brew breaks it down so you don't have to.</p>
<hr>
<ul>
${reportLinks.map((r) => `<li><a href="${r.slug}.html">${r.slug}</a></li>`).join("\n")}
</ul>
`;
writeFileSync(join(SITE_DIR, "index.html"), buildPage("XRPL Monday Brew ☕", indexBody), "utf-8");
console.log(`  Built index.html (${reportLinks.length} reports)`);
