/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Reads the live page for the agent. Local by default and by preference: the
 * document is already laid out, script has already run, and extracting here
 * hands nobody a list of what the user reads — which is the point of the Tor
 * routing and the per-site lifetimes elsewhere in this browser.
 *
 * THE PAGE IS ONLY EVER READ. Nothing here writes to the document. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

const MAX_CHARS = 200000;

/* Blocks that carry no article text. Dropped before the walk so a fallback
   extraction is not mostly chrome. */
const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS",
  "NAV", "ASIDE", "FOOTER", "HEADER", "FORM", "IFRAME", "OBJECT",
]);

/* Patterns that have historically been used to talk past a model reading a
   page. Reported, never acted on: this is a heuristic backstop, not a filter,
   and the parent labels the content untrusted regardless of what it finds. */
const INJECTION = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?/i,
  /you\s+are\s+(?:now|actually)\s+(?:a|an|in)\b/i,
  /^\s*(?:system|assistant)\s*:/im,
  /do\s+not\s+(?:tell|inform|mention this to)\s+(?:the\s+)?(?:user|operator)/i,
  /reveal\s+(?:your|the)\s+(?:system\s+prompt|instructions|configuration)/i,
  /(?:navigate|go)\s+to\s+\S+.*(?:and|then)\s+(?:enter|type|submit|send)/i,
];

function inline(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      out.push(child.nodeValue.replace(/\s+/g, " "));
      continue;
    }
    if (child.nodeType !== child.ELEMENT_NODE || SKIP.has(child.tagName)) {
      continue;
    }
    const tag = child.tagName;
    if (tag === "A" && child.getAttribute("href")) {
      const text = [];
      inline(child, text);
      const label = text.join("").trim();
      out.push(label ? `[${label}](${child.getAttribute("href")})` : "");
    } else if (tag === "CODE") {
      out.push("`" + child.textContent.replace(/\s+/g, " ").trim() + "`");
    } else if (tag === "STRONG" || tag === "B") {
      const text = [];
      inline(child, text);
      const label = text.join("").trim();
      out.push(label ? `**${label}**` : "");
    } else if (tag === "EM" || tag === "I") {
      const text = [];
      inline(child, text);
      const label = text.join("").trim();
      out.push(label ? `*${label}*` : "");
    } else if (tag === "BR") {
      out.push("\n");
    } else {
      inline(child, out);
    }
  }
}

function textOf(node) {
  const out = [];
  inline(node, out);
  return out.join("").replace(/[ \t]+/g, " ").trim();
}

/* Markdown rather than HTML: the same content costs roughly a fifth of the
   tokens, which is the difference between a page an agent can afford to read
   and one it cannot. */
function toMarkdown(root) {
  const lines = [];
  const walk = node => {
    for (const child of node.children) {
      const tag = child.tagName;
      if (SKIP.has(tag)) {
        continue;
      }
      if (/^H[1-6]$/.test(tag)) {
        const text = textOf(child);
        if (text) {
          lines.push("#".repeat(Number(tag[1])) + " " + text, "");
        }
      } else if (tag === "P") {
        const text = textOf(child);
        if (text) {
          lines.push(text, "");
        }
      } else if (tag === "PRE") {
        const code = child.textContent.replace(/\s+$/, "");
        if (code.trim()) {
          lines.push("```", code, "```", "");
        }
      } else if (tag === "BLOCKQUOTE") {
        for (const line of (textOf(child) || "").split("\n")) {
          if (line.trim()) {
            lines.push("> " + line.trim());
          }
        }
        lines.push("");
      } else if (tag === "UL" || tag === "OL") {
        let n = 1;
        for (const item of child.children) {
          if (item.tagName !== "LI") {
            continue;
          }
          const text = textOf(item);
          if (text) {
            lines.push((tag === "OL" ? `${n++}. ` : "- ") + text);
          }
        }
        lines.push("");
      } else if (tag === "TABLE") {
        for (const row of child.querySelectorAll("tr")) {
          const cells = [...row.children].map(c => textOf(c));
          if (cells.some(Boolean)) {
            lines.push("| " + cells.join(" | ") + " |");
          }
        }
        lines.push("");
      } else if (tag === "HR") {
        lines.push("---", "");
      } else if (child.children.length) {
        walk(child);
      } else {
        const text = textOf(child);
        if (text) {
          lines.push(text, "");
        }
      }
    }
  };
  walk(root);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export class ZenAgentChild extends JSWindowActorChild {
  async receiveMessage(message) {
    if (message.name !== "ZenAgent:ReadPage") {
      return null;
    }
    return this._read();
  }

  async _read() {
    const doc = this.document;
    if (!doc?.body) {
      return { ok: false, reason: "no-document" };
    }

    let markdown = "";
    let extractor = "readability";
    let title = doc.title || "";
    let byline = "";
    let siteName = "";

    let article = null;
    try {
      article = await lazy.ReaderMode.parseDocument(doc);
    } catch {
      article = null;
    }

    if (article?.content) {
      title = article.title || title;
      byline = article.byline || "";
      siteName = article.siteName || "";
      /* An inert document: created via createHTMLDocument it has no browsing
         context, so assigning the extracted markup neither runs script nor
         fetches a subresource. Reached through the actor's Xray view of the
         document, so a page cannot substitute its own implementation.
         (Cc is not available in a content-process actor sandbox, which rules
         out the XPCOM parser here.) */
      const inert = doc.implementation.createHTMLDocument("");
      inert.body.innerHTML = article.content;
      markdown = toMarkdown(inert.body);
    }

    /* Readability declines anything it does not judge an article — search
       results, dashboards, most apps — which is most of what an agent is
       pointed at, so the walk is the common path rather than a rare one. */
    if (!markdown) {
      extractor = "dom";
      markdown = toMarkdown(doc.body);
    }

    let truncated = false;
    if (markdown.length > MAX_CHARS) {
      markdown = markdown.slice(0, MAX_CHARS);
      truncated = true;
    }

    const flagged = [];
    for (const pattern of INJECTION) {
      const hit = markdown.match(pattern);
      if (hit) {
        flagged.push(hit[0].slice(0, 80));
      }
    }

    return {
      ok: true,
      title,
      byline,
      siteName,
      url: doc.documentURI || "",
      extractor,
      truncated,
      flagged,
      markdown,
    };
  }
}
