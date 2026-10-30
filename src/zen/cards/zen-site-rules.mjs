// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* The one per-site table: host -> label, accent, drawn icon mark, and the
 * path/detectors that say whether the site is busy. Three readers share it -
 * the content-process Activity reader (zen-activity-frame.js) and the
 * chrome-process icon resolver (ZenSiteIcons.mjs), each importing this same
 * chrome:// module into its own process rather than keeping its own copy.
 *
 * Pure data only. No Services, no prefs, no DOM - a pref-backed store (the
 * user's icon overrides) is chrome-only state and stays out of this file so
 * the content-process import never carries chrome concerns.
 *
 * `mark` is the icon drawn for a site and is absent where there is none -
 * CI/incident sites have no brand mark, only an accent. */

/* Ai2 keeps a visible "Show description for Stop Words" button, so a name
   only counts when the word opens or closes it. */
const CHAT_RUNNING = [
  { sel: 'button[data-testid="stop-button"]' },
  {
    sel:
      'button[aria-label*="stop" i], button[title*="stop" i],' +
      ' button[aria-label*="abbrech" i], button[title*="abbrech" i]',
    text: /^(?:stop|abbrech)|(?:stop|stoppen|abbrechen)$/i,
  },
];

// Every chat reads the same way; only name, colour, mark and path differ.
/* `kind` is the site's category, shown as a tag on the card - a different axis
   from `noun`, which names one item. Vocabulary lives in zen-general.ftl; add a
   kind there before using it or the tag renders blank. */
const CHAT = { noun: "chat", kind: "chat", busy: "Answering…", running: CHAT_RUNNING };

export const SITE_RULES = [
  // -- AI chats. The hosts FMHY lists. ------------------------------------
  {
    hosts: ["claude.ai"],
    label: "Claude",
    accent: "#d97757",
    mark: "claude",
    /* Chats and artifacts both live here, so the path admits both and `kinds`
       tells them apart on the row. */
    path: /^\/(chat|artifact|code\/artifact)\/./,
    kinds: [[/^\/(code\/)?artifact\//, "artifact"]],
    ...CHAT,
  },
  {
    hosts: ["chatgpt.com"],
    label: "ChatGPT",
    accent: "#10a37f",
    mark: "chatgpt",
    path: /^\/c\/./,
    ...CHAT,
  },
  {
    hosts: ["gemini.google.com"],
    label: "Gemini",
    accent: "#4285f4",
    mark: "gemini",
    path: /^\/app\/./,
    ...CHAT,
  },
  {
    hosts: ["aistudio.google.com"],
    label: "AI Studio",
    accent: "#4285f4",
    mark: "aistudio",
    path: /^\/(?:app\/)?prompts\/./,
    ...CHAT,
  },
  {
    hosts: ["grok.com"],
    label: "Grok",
    accent: "#8f8f8f",
    mark: "grok",
    path: /^\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["copilot.microsoft.com"],
    label: "Copilot",
    accent: "#0a7cff",
    mark: "copilot",
    path: /^\/chats?\/./,
    ...CHAT,
  },
  {
    hosts: ["chat.deepseek.com"],
    label: "DeepSeek",
    accent: "#4d6bfe",
    mark: "deepseek",
    path: /^\/a\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["chat.mistral.ai"],
    label: "Le Chat",
    accent: "#fa520f",
    mark: "mistral",
    path: /^\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["chat.qwen.ai"],
    label: "Qwen",
    accent: "#615ced",
    mark: "qwen",
    path: /^\/c\/./,
    ...CHAT,
  },
  {
    hosts: ["chat.z.ai"],
    label: "Z.ai",
    accent: "#3b82f6",
    mark: "zai",
    path: /^\/c\/./,
    ...CHAT,
  },
  {
    hosts: ["kimi.ai"],
    label: "Kimi",
    accent: "#0f7fff",
    mark: "kimi",
    path: /^\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["meta.ai"],
    label: "Meta AI",
    accent: "#0064e0",
    mark: "meta",
    path: /^\/c\/./,
    ...CHAT,
  },
  {
    hosts: ["perplexity.ai"],
    label: "Perplexity",
    kind: "search",
    accent: "#20808d",
    mark: "perplexity",
    path: /^\/search\/./,
    ...CHAT,
  },
  {
    hosts: ["chat.together.ai"],
    label: "Together",
    accent: "#0f6fff",
    mark: "together",
    path: /^\/chat\/./,
    ...CHAT,
  },
  // Every signed-in Lumo route is under /u/<account>/, the guest one is not.
  {
    hosts: ["lumo.proton.me"],
    label: "Lumo",
    accent: "#6d4aff",
    mark: "lumo",
    path: /^\/(?:u\/\d+\/)?c\/./,
    ...CHAT,
  },
  // Every path ends in "." - longcat.ai/chat is the empty composer, not a chat.
  {
    hosts: ["longcat.ai"],
    label: "LongCat",
    accent: "#ff6b35",
    mark: "longcat",
    path: /^\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["agent.minimax.io"],
    label: "MiniMax",
    accent: "#ff4d4f",
    mark: "minimax",
    path: /^\/chat\/./,
    ...CHAT,
  },
  {
    hosts: ["playground.allenai.org"],
    label: "Ai2",
    accent: "#0fcb8c",
    mark: "ai2",
    path: /^\/chat\/./,
    ...CHAT,
  },

  // -- Builds and CI ------------------------------------------------------
  // GitHub labels every run icon for screen readers; nothing else is stable.
  {
    hosts: ["github.com"],
    label: "GitHub",
    kind: "code",
    accent: "#8250df",
    noun: "run",
    busy: "Running…",
    path: /^\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/job\/\d+)?$/,
    running: {
      sel: "svg[aria-label], span[aria-label]",
      text: /^(?:currently running|in progress|queued|waiting|pending|expected)/i,
    },
    finished: {
      sel: "svg[aria-label], span[aria-label]",
      text: /^(?:completed successfully|failed|cancell?ed|skipped|timed out)/i,
    },
  },
  {
    hosts: ["gitlab.com"],
    label: "GitLab",
    kind: "code",
    accent: "#fc6d26",
    noun: "pipeline",
    busy: "Running…",
    path: /^\/.+\/-\/pipelines\/\d+$/,
    running: {
      sel: '[data-testid="ci-icon-text"]',
      text: /^(?:running|pending|created|preparing|waiting|scheduled)/i,
    },
    finished: {
      sel: '[data-testid="ci-icon-text"]',
      text: /^(?:passed|failed|cancell?ed|skipped|manual)/i,
    },
  },

  // -- Media still being processed ----------------------------------------
  // `idle`: a file page is about its transcodes even once they are done.
  {
    hosts: ["commons.wikimedia.org"],
    label: "Commons",
    kind: "media",
    accent: "#3366cc",
    noun: "encode",
    busy: "Encoding…",
    done: "Encoded",
    idle: true,
    running: {
      sel: "table.mw-filepage-transcodestatus td",
      text: /^(?:pending|transcoding|started|queued|in progress)/i,
    },
    finished: {
      sel: "table.mw-filepage-transcodestatus td",
      text: /^completed/i,
    },
  },

  // -- Service incidents --------------------------------------------------
  // One Statuspage markup, so the host list is the only per-service part.
  {
    hosts: [
      "githubstatus.com",
      "cloudflarestatus.com",
      "status.openai.com",
      "status.anthropic.com",
      "status.slack.com",
      "status.discord.com",
      "status.npmjs.org",
      "status.gitlab.com",
    ],
    label: "Status",
    kind: "status",
    accent: "#e0567c",
    noun: "incident",
    busy: "Incident open",
    done: "All clear",
    idle: true,
    running: { sel: ".page-status.status-minor, .page-status.status-major" },
    finished: { sel: ".page-status.status-none" },
    unread: { sel: ".unresolved-incident", tally: true },
  },
];
