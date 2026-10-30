# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

zen-agent-status-button =
    .label = Agent control
    .tooltiptext = Whether an assistant is driving this browser

zen-agent-marker-attended = Agent is driving this tab
zen-agent-marker-silent = Agent is working in its own tab
zen-agent-marker-off = Agent control is off

# $client is the name the assistant identified itself with. Named as well as
# coloured: a per-assistant hue tells a colourblind reader nothing on its own.
zen-agent-marker-attended-named = { $client } is driving this tab
zen-agent-marker-silent-named = { $client } is working in its own tab

zen-agent-panel-title = Agent control
zen-agent-panel-state = State
zen-agent-panel-state-off = Off
zen-agent-panel-state-attended = Attended — driving the tab you are looking at
zen-agent-panel-state-silent = Silent — working in its own tab

zen-agent-panel-connections = Connected assistants
zen-agent-panel-client = { $client }
zen-agent-panel-tabs = Agent tabs
zen-agent-panel-show-tab = Switch to the agent's tab

zen-agent-panel-stop =
    .label = Stop the agent
    .tooltiptext = Revoke every handle immediately and stop anything in flight

zen-agent-panel-recent = Recent actions
zen-agent-panel-empty = Nothing yet.
zen-agent-panel-open-log = Show the full log

# $verb is a machine verb name, $host the site it touched.
zen-agent-log-entry-ok = { $client }: { $verb } · { $host }
zen-agent-log-entry-refused = { $client }: { $verb } refused · { $reason ->
    [origin-guarded] this site is protected
    [scheme-refused] that address is not allowed
    [read-only-session] the session is read-only
    [not-authenticated] not signed in to the channel
    [bad-token] wrong token
    [revoked] you stopped the agent
    [unknown-verb] unknown command
    [agent-disabled] agent control is off
    [not-implemented] not built yet
   *[other] { $reason }
  }

# The loading pill over a tab while an agent works in it. $client is the name
# the assistant identified itself with.
zen-agent-busy-navigate =
    .aria-label = Agent is opening a page in this tab
zen-agent-busy-navigate-named =
    .aria-label = { $client } is opening a page in this tab
zen-agent-busy-read =
    .aria-label = Agent is reading this page
zen-agent-busy-read-named =
    .aria-label = { $client } is reading this page
zen-agent-busy-screenshot =
    .aria-label = Agent is looking at this page
zen-agent-busy-screenshot-named =
    .aria-label = { $client } is looking at this page

## Agent panel while off.
zen-agent-panel-start-silent =
    .label = Start: own tab only
zen-agent-panel-start-attended =
    .label = Start: may use this tab
zen-agent-panel-disabled = Agent control is switched off in Settings.
zen-agent-panel-open-settings =
    .label = Open Settings
zen-agent-close-confirm = Agent is using it · Close?
