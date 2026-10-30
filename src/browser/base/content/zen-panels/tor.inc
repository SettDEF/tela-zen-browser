# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Skeleton only; ZenTorPanel.mjs fills every dynamic row.
<panel id="zen-tor-panel"
       data-l10n-id="zen-tor-panel"
       type="arrow"
       orient="vertical"
       role="dialog"
       consumeoutsideclicks="true">
  <vbox id="zen-tor-panel-body">
    <hbox id="zen-tor-panel-header" align="center">
      <html:div id="zen-tor-panel-onion"/>
      <html:div id="zen-tor-panel-site"/>
    </hbox>

    <vbox id="zen-tor-panel-facts"/>

    <html:div id="zen-tor-panel-loading"
              class="zen-tor-panel-note"
              data-l10n-id="zen-tor-panel-circuit-loading"
              hidden="true"/>

    <vbox id="zen-tor-panel-circuit" hidden="true">
      <html:div class="zen-tor-panel-heading" data-l10n-id="zen-tor-panel-circuit-heading"/>
      <html:div id="zen-tor-panel-route">
        <html:div id="zen-tor-panel-route-track">
          <html:div id="zen-tor-panel-route-pulse"/>
        </html:div>
      </html:div>
      <html:div id="zen-tor-panel-chain-note" class="zen-tor-panel-note" hidden="true"/>
      <toolbarbutton id="zen-tor-panel-new-circuit"
                     class="subviewbutton zen-interactive-button zen-tor-panel-action"
                     data-l10n-id="zen-tor-panel-new-circuit"
                     hidden="true"/>
    </vbox>

    <vbox id="zen-tor-panel-nocircuit">
      <html:div class="zen-tor-panel-heading" data-l10n-id="zen-tor-panel-circuit-unknown-heading"/>
      <html:div id="zen-tor-panel-hint"
                class="zen-tor-panel-note"
                data-l10n-id="zen-tor-panel-circuit-unknown"/>
      <html:pre id="zen-tor-panel-torrc"/>
    </vbox>

    <vbox id="zen-tor-panel-actions">
      <toolbarbutton id="zen-tor-panel-toggle-space"
                     class="subviewbutton zen-tor-panel-action"/>
      <hbox id="zen-tor-panel-actions-row">
        <toolbarbutton id="zen-tor-panel-tor-window"
                       class="subviewbutton zen-interactive-button zen-tor-panel-action"
                       data-l10n-id="zen-tor-panel-tor-window"
                       flex="1"/>
        <toolbarbutton id="zen-tor-panel-settings"
                       class="subviewbutton zen-interactive-button zen-tor-panel-action"
                       data-l10n-id="zen-tor-panel-settings"
                       flex="1"/>
      </hbox>
    </vbox>
  </vbox>
</panel>
