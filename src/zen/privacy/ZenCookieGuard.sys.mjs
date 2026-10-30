/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Gecko treats any failed cookie write as corruption: it renames the jar to
// cookies.sqlite.bak and starts an empty one, and on a full disk that one stays
// empty. This copies each .bak somewhere a second wipe cannot overwrite it and,
// when the live jar has collapsed next to it, adds the missing cookies back.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

const PREF_HANDLED = "zen.cookies.guard.handled-mtime";
const RESCUE_DIR = "cookie-rescue";
const KEEP_RESCUES = 5;
// A wipe leaves under half the jar; anything milder is the user's own doing.
const COLLAPSE = 0.5;
const MIN_COOKIES = 50;
const MAX_AGE_MS = 14 * 86400e3;

function keyOf(host, name, path, suffix) {
  return `${host}\n${name}\n${path}\n${suffix}`;
}

export const ZenCookieGuard = {
  _started: false,

  async init() {
    if (this._started) {
      return;
    }
    this._started = true;
    // A rebuild during the session moves the jar aside right then.
    for (const topic of ["cookie-db-rebuilding", "cookie-db-closed"]) {
      Services.obs.addObserver(() => this._rescue().catch(console.error), topic);
    }
    try {
      await this._healIfWiped();
    } catch (ex) {
      console.error("ZenCookieGuard:", ex);
    }
  },

  get _bakPath() {
    return PathUtils.join(PathUtils.profileDir, "cookies.sqlite.bak");
  },

  /* Copies the current .bak to cookie-rescue/, once per distinct file. On a
     full disk the copy comes out short, so it is only kept once its size
     matches, and until then the .bak is read where it lies. */
  async _rescue() {
    let info;
    try {
      info = await IOUtils.stat(this._bakPath);
    } catch {
      return null;
    }
    const whole = async path => {
      try {
        return (await IOUtils.stat(path)).size === info.size;
      } catch {
        return false;
      }
    };
    const dir = PathUtils.join(PathUtils.profileDir, RESCUE_DIR);
    const dest = PathUtils.join(dir, `cookies-${info.lastModified}.sqlite`);
    if (!(await whole(dest))) {
      const part = dest + ".part";
      try {
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
        await IOUtils.copy(this._bakPath, part);
        if (!(await whole(part))) {
          throw new Error("short copy");
        }
        await IOUtils.move(part, dest);
      } catch {
        await IOUtils.remove(part, { ignoreAbsent: true }).catch(() => {});
        return { path: this._bakPath, mtime: info.lastModified };
      }
      const kept = (await IOUtils.getChildren(dir))
        .filter(f => f.endsWith(".sqlite"))
        .sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_RESCUES))) {
        for (const tail of ["", "-wal", "-shm"]) {
          await IOUtils.remove(old + tail, { ignoreAbsent: true });
        }
      }
    }
    return { path: dest, mtime: info.lastModified };
  },

  async _healIfWiped() {
    const rescued = await this._rescue();
    if (!rescued) {
      return;
    }
    const handled = Number(Services.prefs.getStringPref(PREF_HANDLED, "0"));
    if (rescued.mtime <= handled) {
      return;
    }
    Services.prefs.setStringPref(PREF_HANDLED, String(rescued.mtime));
    if (Date.now() - rescued.mtime > MAX_AGE_MS) {
      return;
    }

    const conn = await lazy.Sqlite.openConnection({
      path: rescued.path,
      readOnly: true,
    });
    let rows;
    try {
      rows = await conn.execute(
        `SELECT host, path, name, value, isSecure, isHttpOnly, expiry,
                originAttributes, sameSite, schemeMap, isPartitionedAttributeSet
         FROM moz_cookies WHERE expiry > :now`,
        { now: Date.now() }
      );
    } finally {
      await conn.close();
    }

    const live = Services.cookies.cookies;
    if (rows.length < MIN_COOKIES || live.length >= rows.length * COLLAPSE) {
      return;
    }
    const have = new Set(
      live.map(c =>
        keyOf(c.host, c.name, c.path, ChromeUtils.originAttributesToSuffix(c.originAttributes))
      )
    );

    let restored = 0;
    for (const row of rows) {
      const host = row.getResultByName("host");
      const name = row.getResultByName("name");
      const path = row.getResultByName("path");
      const suffix = row.getResultByName("originAttributes");
      if (have.has(keyOf(host, name, path, suffix)) || this._isShortLived(host)) {
        continue;
      }
      try {
        const oa = ChromeUtils.createOriginAttributesFromOrigin("https://x.invalid" + suffix);
        const result = Services.cookies.add(
          host,
          path,
          name,
          row.getResultByName("value"),
          !!row.getResultByName("isSecure"),
          !!row.getResultByName("isHttpOnly"),
          false,
          row.getResultByName("expiry"),
          oa,
          row.getResultByName("sameSite"),
          row.getResultByName("schemeMap"),
          !!row.getResultByName("isPartitionedAttributeSet")
        );
        if (result?.result === Ci.nsICookieValidation.eOK || result == null) {
          restored++;
        }
      } catch {}
    }
    console.warn(
      `ZenCookieGuard: the cookie jar was reset (${live.length} left of ${rows.length}); restored ${restored} from ${rescued.path}`
    );
    Services.obs.notifyObservers(null, "zen-cookies-restored", String(restored));
  },

  /* Sites set to session or tab lifetime must not come back as persistent. */
  _isShortLived(host) {
    try {
      const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(
        "https://" + host.replace(/^\./, "")
      );
      return (
        Services.perms.testPermissionFromPrincipal(principal, "cookie") ===
          Ci.nsICookiePermission.ACCESS_SESSION ||
        Services.perms.testPermissionFromPrincipal(principal, "zen-clear-on-tab-close") ===
          Services.perms.ALLOW_ACTION
      );
    } catch {
      return false;
    }
  },
};
