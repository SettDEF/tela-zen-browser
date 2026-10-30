/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";

const FILE_NAME = "zen-agent-log.json";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

/* Per-action record of what the agent did. Refusals are recorded exactly like
   successes: a permission model nobody can audit is a claim, not a control. */
export const ZenAgentLog = {
  _file: null,

  async init() {
    if (this._file) {
      return this._file;
    }
    this._file = new JSONFile({
      path: PathUtils.join(PathUtils.profileDir, FILE_NAME),
      dataPostProcessor: data => {
        if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
          return { entries: [] };
        }
        return data;
      },
    });
    await this._file.load();
    this._prune();
    return this._file;
  },

  get entries() {
    return this._file?.data?.entries ?? [];
  },

  /* outcome is "ok" | "refused" | "error". `code` carries the machine reason
     for the latter two, never prose: the pane owns the wording. */
  async record({ verb, url, host, outcome, code, mode, tabId, detail, client }) {
    await this.init();
    this._file.data.entries.push({
      at: Date.now(),
      verb,
      /* Which assistant did it. "What did it do" becomes "which one did it"
         as soon as more than one can connect. */
      client: client || "",
      url: url || "",
      host: host || "",
      outcome,
      code: code || "",
      mode: mode || "",
      tabId: tabId ?? null,
      detail: detail || "",
    });
    this._prune();
    this._file.saveSoon();
  },

  /* Time cutoff then a hard cap, the ZenPageCards._pruneActivity shape: the
     cutoff alone cannot outrun an agent writing faster than it retires. */
  _prune() {
    const entries = this._file?.data?.entries;
    if (!Array.isArray(entries)) {
      return;
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    let kept = entries.filter(entry => (entry?.at ?? 0) >= cutoff);
    if (kept.length > MAX_ENTRIES) {
      kept = kept.slice(kept.length - MAX_ENTRIES);
    }
    this._file.data.entries = kept;
  },

  async clear() {
    await this.init();
    this._file.data.entries = [];
    this._file.saveSoon();
  },

  /* Flush synchronously enough to survive the shutdown that follows a revoke;
     saveSoon alone can lose the last few actions on a fast quit. */
  async flush() {
    if (this._file?.dataReady) {
      await this._file._save();
    }
  },
};
