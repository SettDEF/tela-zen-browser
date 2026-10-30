# Agent control + MCP bridge: what's weak (2026-09-25)

Slice: `src/zen/agent/`, `tools/zen-agent-mcp/server.mjs`, their tests.
Not covered: the rest of the browser.
Live probes ran through the real MCP bridge over stdio, on a throwaway profile.

## Ranked

1. **[high | S | low] Silent mode doesn't keep the agent in its own tabs.**
   The agent can read, screenshot and navigate any of the user's tabs by id.
   - WHERE: `ZenAgentActions.sys.mjs:24` `resolveTab` accepts any `tabId`.
     `ZenAgentTabs.sys.mjs:27` `idFor` gives every tab an id, and `listTabs`
     publishes those ids. Only `closeTab` (:163) checks `isAgentTab`. The
     bridge's instructions say "silent mode uses the agent's own tabs", and its
     `TABID` text tells Claude to take ids "from list_tabs".
   - EVIDENCE: live test in silent mode, on a user tab with `userContextId=0`:
     `read_page`, `screenshot` and `navigate` were ALLOWED and
     `close_agent_tab` was REFUSED (`not-agent-tab`). The user's tab ended up
     on iana.org.
   - WHY: the per-client container (`ZenAgentTabs.sys.mjs:60`) protects nothing
     while the user's logged-in tabs are one id away. The channel starts in
     silent mode on its own whenever the pref is on. Any process running as the
     user can read the token, which the code accepts as a courtesy boundary.
     The indicator covers the whole window and looks the same whether the agent
     is in its own tab or in yours. Attended mode can also reach background
     tabs by id. `agent_mcp_test.py` only starts attended mode, which is how
     this got through.

2. **[high | S | low] The agent surface has never been committed.**
   - WHERE: `src/zen/agent/`, `tools/zen-agent-mcp/`, `scripts/agent_*.py`
     are all untracked (`??`). 61 paths are dirty. The last commit is
     2026-09-09.
   - WHY: this host has already truncated files to zero bytes (ENOSPC, see
     tela CLAUDE.md). Tasks #66–#72 exist only in one working tree.

3. **[medium | S | low] `navigate` reports success when the load failed.**
   - WHERE: `ZenAgentActions.sys.mjs:332`. Any top-level `STATE_STOP` counts as
     landed, and the status is never checked.
   - EVIDENCE: live: navigating to `https://zen-agent-probe.invalid/` returned
     ok with `url: about:blank, title: New Tab`. `read_page` then returned an
     empty page, also as a success.
   - WHY: the agent concludes the site is blank when really it failed to
     resolve. 404, 500 and TLS failures were not tested.

4. **[medium | L | medium] `click`, `type` and `scroll` don't exist.**
   - WHERE: `ZenAgentActions.sys.mjs:85` returns `not-implemented`.
     `server.mjs:567` still exposes all three as tools.
   - WHY: the surface can read and navigate but can't act on a page. The three
     dead tools also take up context in every Claude Code session. The effort
     is L because this is where the real safety design sits: password fields,
     form submission, confirmation.

5. **[medium | S | low] All of github.com is guarded.**
   - WHERE: `ZenAgentPolicy.sys.mjs:18`.
   - WHY: the list was ported from the Qt-era guard against extension injection.
     The consumer is now Claude Code, whose most natural request is "read this
     PR", and that gets refused. The only way out is
     `allow-guarded-origins`, which unguards the banks too. This was a
     deliberate choice, so it needs revisiting, not fixing: guard the paths
     (`/login`, `/session`, `/settings`), or split the credential and
     financial lists.

6. **[low | S | low] `list_tabs` only sees the front window.**
   - WHERE: `ZenAgentActions.sys.mjs:105` uses `topWindow()`, while `byId`
     resolves tabs in any window.
   - EVIDENCE: from reading the code only.
   - WHY: after the user focuses another window, `status` counts agent tabs
     that `list_tabs` no longer shows.

## Looked at and fine
- The kill switch bumps the generation, aborts in-flight loads, closes the
  listener and deletes the token and socket. The latch stops auto-start.
  Every async verb re-checks the generation.
- The URL policy matches hosts exactly or on a dot-anchored suffix.
  `readPage` and `screenshot` check the scheme as well as the host, so
  `about:logins`, `about:config` and `file://` are refused. Redirects are
  re-checked where they land. `newAgentTab` uses the same gate as `navigate`.
- The socket is AF_UNIX with mode 0600, and the test asserts no TCP port.
  Unauthenticated sessions time out.
- Page text is labelled untrusted whatever the injection scan finds.

## Could not check
- Multi-window behaviour live (#6 comes from reading the code only).
- Other kinds of load failure (#3 was tested with DNS only).
- Whether the audit log is enough to reconstruct what happened in #1.
- Idle cost. Not measured; a listening Unix socket is presumably negligible.
