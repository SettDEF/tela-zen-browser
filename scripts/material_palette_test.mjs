// Checks the palette generator behind "Custom accent" (ZenMaterialPalette.fromSeed).
// Pure functions, so it runs in plain node:  node scripts/material_palette_test.mjs
import assert from "node:assert/strict";
import { ZenMaterialPalette as P } from "../src/browser/components/preferences/zen-material-palette.mjs";

const lum = hex => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

for (const [seed, dark] of [["#478fff", true], ["#2fbf71", true], ["#e8a33d", false], ["#ff3b30", true]]) {
  const p = P.fromSeed(seed, dark);
  const g = k => p.colors.get(k);
  check(`${seed} ${dark ? "dark" : "light"}: every role is a hex colour`, () => {
    assert.ok(p.colors.size >= 30);
    for (const [k, v] of p.colors) assert.match(v, /^#[0-9a-f]{6}$/, k);
  });
  check(`${seed}: the accent is the primary container`, () => assert.equal(g("primaryContainer"), seed));
  check(`${seed}: layers step the right way`, () => {
    const order = ["surfaceContainerLowest", "surfaceContainerLow", "surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest"].map(k => lum(g(k)));
    for (let i = 1; i < order.length; i++) assert.ok(dark ? order[i] > order[i - 1] : order[i] < order[i - 1], `layer ${i}`);
  });
  check(`${seed}: text reads on the surface`, () => assert.ok(Math.abs(lum(g("onSurface")) - lum(g("surface"))) > 0.6));
  check(`${seed}: the scheme flag matches`, () => assert.equal(p.darkmode, dark));
}
check("a malformed seed gives nothing", () => assert.equal(P.fromSeed("blue"), null));
console.log(`${checks.length}/${checks.length} passed`);
