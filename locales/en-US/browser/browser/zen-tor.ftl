# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## The urlbar identity-box badge. Shown only for an actual .onion host, never
## for a clearnet site merely because the tab is routed - the panel already
## covers that. Same wording as the panel's own onion row.

zen-tor-identity-onion =
    .tooltiptext = The connection never leaves the Tor network, so there is no exit relay.
    .aria-label = Onion service · no exit

## The onion in the toolbar. Its tooltip is rewritten from the live routing
## state by ZenTor, so only the name belongs here.

zen-tor-status-button =
    .label = Tor status

## The onion panel. Every value is read from the browser or from Tor's control
## port; nothing about a circuit is written here as an example.

zen-tor-panel =
    .aria-label = Tor status
zen-tor-panel-no-site = No site in this tab

## One row each: label, short value, tooltip for the part that needs saying.

zen-tor-panel-label-connection = Connection
zen-tor-panel-label-proxy = Proxy
zen-tor-panel-label-instance = Instance
zen-tor-panel-label-bridges = Bridges
zen-tor-panel-label-site = Site
zen-tor-panel-label-container = Container
zen-tor-panel-label-hardening = Hardening
zen-tor-panel-label-control = Control port

zen-tor-panel-value-direct = Direct
zen-tor-panel-value-space = Tor space
zen-tor-panel-value-window = Tor window
zen-tor-panel-value-connecting = Tor · connecting
zen-tor-panel-value-down = Tor · proxy down
zen-tor-panel-value-proxy-ok = { $endpoint } · answering
zen-tor-panel-value-proxy-bad = { $endpoint } · no answer
zen-tor-panel-value-proxy-unchecked = { $endpoint } · not checked
zen-tor-panel-value-proxy-disabled = { $endpoint } · routing off
zen-tor-panel-value-onion = Onion service · no exit
zen-tor-panel-value-container-default = Default · shared
zen-tor-panel-value-container-window = Ephemeral · this window
zen-tor-panel-value-bootstrapping = Tor · bootstrapping { $percent }%
zen-tor-panel-value-on = On
zen-tor-panel-value-off = Off

zen-tor-panel-value-instance-own = This browser's tor
zen-tor-panel-value-instance-external = External daemon
zen-tor-panel-value-instance-failed = Own tor failed
zen-tor-panel-value-instance-failed-no-binary = No tor binary found
zen-tor-panel-value-instance-failed-data-dir = Data directory error
zen-tor-panel-value-instance-failed-spawn = Failed to start
zen-tor-panel-value-instance-failed-no-control-port = No control port
zen-tor-panel-value-instance-failed-bridges = Blocked by bridge config

zen-tor-panel-value-bridges-active = { $transports } · active
zen-tor-panel-value-bridges-pending = Configured · not started yet
zen-tor-panel-value-bridges-invalid = Line { $line } invalid
zen-tor-panel-value-bridges-missing-transport = { $transport } binary missing

zen-tor-panel-tip-direct =
    .title = This tab uses the ordinary connection.
zen-tor-panel-tip-space =
    .title = This tab is in a Tor space, whose container persists across restarts.
zen-tor-panel-tip-window =
    .title = This is a Tor window; its container is destroyed when the window closes.
zen-tor-panel-tip-proxy =
    .title = A routed tab fails to load rather than going direct if this stops answering.
zen-tor-panel-tip-proxy-own =
    .title = A tor this browser started, with its own data directory and control port. It is stopped when the browser exits.
zen-tor-panel-tip-proxy-disabled =
    .title = No new Tor container can be made while zen.tor.enabled is off. Containers already marked keep failing closed.
zen-tor-panel-tip-onion =
    .title = The connection never leaves the Tor network, so there is no exit relay.
zen-tor-panel-tip-container-default =
    .title = The default container is shared with every direct tab, so it cannot be routed on its own.
zen-tor-panel-tip-container-window =
    .title = A container made for this window and destroyed with it, so nothing here is kept.
zen-tor-panel-tip-hardening-on =
    .title = resistFingerprinting and letterboxing are on, browser-wide.
zen-tor-panel-tip-hardening-off =
    .title = Tor hides your address, not this browser’s fingerprint.
zen-tor-panel-tip-control-off =
    .title = zen.tor.control.enabled is off, so Tor is not asked for the circuit.
zen-tor-panel-tip-instance-own =
    .title = Started and run by this browser under its own data directory. Stopped when the browser exits.
zen-tor-panel-tip-instance-external =
    .title = Not this browser's own tor - whatever is answering at the configured proxy address.
zen-tor-panel-tip-instance-failed =
    .title = This browser's own tor did not start.
zen-tor-panel-tip-instance-failed-no-binary =
    .title = No tor executable was found at the usual paths, or the one pinned in zen.tor.daemon.path.
zen-tor-panel-tip-instance-failed-data-dir =
    .title = The tor data directory under the profile's tor folder could not be created or secured.
zen-tor-panel-tip-instance-failed-spawn =
    .title = The tor process failed to launch.
zen-tor-panel-tip-instance-failed-no-control-port =
    .title = Tor started but never wrote a control port. Check tor.log in the profile's tor folder.
zen-tor-panel-tip-instance-failed-bridges =
    .title = The bridge configuration is blocking startup - see the Bridges row.
zen-tor-panel-tip-bridges-active =
    .title = UseBridges is on; this browser's tor was started with the pasted bridge lines.
zen-tor-panel-tip-bridges-pending =
    .title = Bridges are configured but this browser's own tor has not tried them yet.
zen-tor-panel-tip-bridges-invalid =
    .title = That bridge line does not match the format tor expects for its transport.
zen-tor-panel-tip-bridges-missing-transport =
    .title = A pasted line names a pluggable transport this machine has no binary for.

## The circuit, when Tor's control port hands one over.

zen-tor-panel-circuit-heading = Circuit
zen-tor-panel-circuit-browser = You
zen-tor-panel-circuit-site-onion = Inside Tor
zen-tor-panel-circuit-guard = Guard
zen-tor-panel-circuit-relay = Relay
zen-tor-panel-circuit-exit = Exit
zen-tor-panel-circuit-rendezvous = Rendez.
zen-tor-panel-circuit-loading = Reading the circuit from Tor…
zen-tor-panel-circuit-unnamed = Unnamed relay
zen-tor-panel-circuit-relay-unknown-address = Address not in the consensus
zen-tor-panel-circuit-none = No open stream belongs to this site, so its circuit cannot be told.

## The circuit, when there is no control port to ask.

zen-tor-panel-circuit-unknown-heading = Circuit unknown
zen-tor-panel-circuit-unknown = Reached over SOCKS only. The path is known to Tor, not to this browser, so none is drawn. Tor would have to offer a control port:

## Actions.

zen-tor-panel-new-circuit =
    .label = New circuit for this site
zen-tor-panel-toggle-on =
    .label = Route this space through Tor
zen-tor-panel-toggle-off =
    .label = Stop routing this space
zen-tor-panel-tor-window =
    .label = Tor window
zen-tor-panel-settings =
    .label = Settings
