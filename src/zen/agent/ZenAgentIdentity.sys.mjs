/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Which assistant is driving. One colour per client, derived from its name
 * rather than handed out from a registry, so it is stable across sessions and
 * nobody has to register.
 *
 * A client cannot choose its own colour: if it could, one could take another's
 * and the indicator would stop telling the user anything. The name is the only
 * input, and the same name always yields the same colour.
 */

const MAX_NAME = 40;

/* Fixed lightness and chroma, only the hue varies. That is what keeps every
   derived colour legible against both themes and under white pill text — a
   hash allowed to move L or C would eventually land on something invisible. */
const L = 0.52;
const C = 0.13;

/* An unnamed client gets a near-grey rather than a hue of its own: no claimed
   identity, no identity colour. */
const ANONYMOUS = `oklch(${L} 0.02 0)`;

/* Tor's markings sit at these OKLCH hues, measured from the shipped hex, and
   they share this accent's lightness and chroma almost exactly (Tor space is
   L=0.50 C=0.137 H=313 against our L=0.52 C=0.13). A name hashing near one
   would produce an agent badge indistinguishable from a Tor marking, on a tab
   that can carry both at once. Hues are skipped, not clamped: clamping would
   pile several names onto one edge. */
const RESERVED = [
  [12, 48],    // Tor unreachable, 30
  [55, 91],    // Tor window, 73
  [141, 177],  // Tor ok, 159
  [295, 331],  // Tor space and the onion node, 313
];

const OPEN = (() => {
  const gaps = [];
  let at = 0;
  for (const [lo, hi] of RESERVED) {
    if (lo > at) {
      gaps.push([at, lo]);
    }
    at = hi;
  }
  if (at < 360) {
    gaps.push([at, 360]);
  }
  return { gaps, span: gaps.reduce((n, [lo, hi]) => n + (hi - lo), 0) };
})();

/* Maps a hash onto the hues Tor does not use, keeping the derivation stable:
   the same name always lands on the same hue. */
function openHue(h) {
  let offset = h % OPEN.span;
  for (const [lo, hi] of OPEN.gaps) {
    if (offset < hi - lo) {
      return lo + offset;
    }
    offset -= hi - lo;
  }
  return OPEN.gaps[0][0];
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/* Firefox container colours are a fixed enum, so the derived hue is snapped to
   the nearest one. Without this the container stripe on the tab contradicts the
   badge beside it, which is a small lie in the same UI. */
const CONTAINER_HUES = [
  [25, "red"],
  [50, "orange"],
  [90, "yellow"],
  [140, "green"],
  [185, "turquoise"],
  [250, "blue"],
  [300, "purple"],
  [350, "pink"],
];

export const ZenAgentIdentity = {
  /* The name reaches the chrome from a local client, so it is bounded and
     stripped of control characters before it is ever displayed. It is only
     ever set as text or as a Fluent argument, never as markup. */
  clean(name) {
    if (typeof name !== "string") {
      return "";
    }
    return name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME);
  },

  accentFor(name) {
    const clean = this.clean(name);
    if (!clean) {
      return ANONYMOUS;
    }
    return `oklch(${L} ${C} ${openHue(hash(clean.toLowerCase()))})`;
  },

  hueFor(name) {
    const clean = this.clean(name);
    return clean ? openHue(hash(clean.toLowerCase())) : -1;
  },

  containerColourFor(name) {
    const hue = this.hueFor(name);
    if (hue < 0) {
      return "toolbar";
    }
    let best = CONTAINER_HUES[0];
    for (const entry of CONTAINER_HUES) {
      const d = Math.min(
        Math.abs(entry[0] - hue),
        360 - Math.abs(entry[0] - hue)
      );
      const bd = Math.min(
        Math.abs(best[0] - hue),
        360 - Math.abs(best[0] - hue)
      );
      if (d < bd) {
        best = entry;
      }
    }
    return best[1];
  },

  /* Two clients presenting the same name are the same identity as far as this
     is concerned: same colour, same label. Telling them apart is not something
     a name can do, and pretending otherwise would be the dishonest option. */
  describe(name) {
    const clean = this.clean(name);
    return {
      name: clean,
      accent: this.accentFor(clean),
      containerColour: this.containerColourFor(clean),
    };
  },
};
