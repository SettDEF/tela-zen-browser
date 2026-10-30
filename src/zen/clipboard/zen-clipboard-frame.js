// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at http://mozilla.org/MPL/2.0/.

/* Content side of the clipboard toast: a copy inside a page never reaches the
   chrome, so it is reported from here. Only the fact of a copy is sent - never
   what was copied. */

/* eslint-env mozilla/frame-script */

addEventListener("copy", () => sendAsyncMessage("ZenClipboard:Copied", {}), true);
addEventListener("cut", () => sendAsyncMessage("ZenClipboard:Copied", {}), true);
