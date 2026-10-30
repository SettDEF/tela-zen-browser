# What makes a browser safe

Research notes for tela-zen, from primary sources. Every claim here was read
out of the Firefox tree, an RFC, a Bugzilla entry or a published paper — not
from memory. Where a source could not be reached, or two sources disagree,
that is stated rather than smoothed over.

**Coverage.** Thirteen sections, in three groups. Sections 1-4 are the
storage lifecycle and the transport layer. Sections 5-7 are the engine:
process sandboxing, Fission, memory safety. Sections 8-11 are the content
layer: tracking protection, state partitioning, fingerprinting resistance,
permissions and extensions. Section 12 is the synthesis - why Tor is still
used given all of the above - and section 13 records what this browser's own
site-data feature actually delivers, measured rather than asserted.

Each research group left its own open-questions subsection rather than
merging into section 3, so nothing was smoothed over in the joining.

**Version scope.** Some behaviour differs materially between mozilla-central
and ESR 140. Where it does, both are given. tela-zen is built from a Firefox
154 base, so central is usually the relevant one — but the ESR deltas are
recorded because they change which flags exist at all.

---

## 1. Storage lifecycle: what "clear cookies" really leaves behind

The single most misleading phrase in browser privacy UI. `CLEAR_COOKIES` maps
to exactly one cleaner (`CookieCleaner`), which touches `Services.cookies` and
HTTP compression dictionaries. Nothing else.

Everything below survives a cookie clear unless separately requested:

| Vector | Cleared by | Per-site? |
|---|---|---|
| HTTP disk/memory cache | `CLEAR_NETWORK_CACHE` | yes |
| Service worker registrations | `CLEAR_DOM_QUOTA` | yes |
| Cache API, IndexedDB, localStorage, sessionStorage | `CLEAR_DOM_QUOTA` | yes |
| **OPFS** (Origin Private File System) | `CLEAR_DOM_QUOTA` | yes |
| Push subscriptions | `CLEAR_DOM_PUSH_NOTIFICATIONS` | yes |
| HSTS "supercookies" | `CLEAR_HSTS` | yes, but the OA pattern is dropped (`// TODO`) |
| EME / media plugin data | `CLEAR_EME` | yes; `deleteAll()` is a no-op |
| TLS session tickets | `CLEAR_TLS_TOKEN_CACHE` (central only) | yes in central |
| **Alt-Svc cache** | no flag — global observer only | **no** |
| **DNS cache** | **no flag at all** | **no** |
| Connection pool history | global only | **no** |
| Favicons | no flag; partially via `CLEAR_HISTORY` | partial |
| HTTP auth cache | `CLEAR_AUTH_CACHE` | **no** — falls through to `deleteAll()` |
| OCSP cache | no flag, no cleaner | **no** |

Three of those have no per-site path at all. If we ever offer "forget this
site", the copy must not imply the DNS cache, Alt-Svc cache or OCSP cache went
with it, because they did not.

### The right method for "forget this site"

`deleteDataFromSite(schemelessSite, oaPattern, isUserRequest, flags, cb)`.

- `deleteDataFromBaseDomain` **does not exist** — renamed in
  [bug 1915419](https://bugzilla.mozilla.org/show_bug.cgi?id=1915419) (FF132).
  The anti-tracking docs page still documents the old name and is stale.
- `deleteDataFromHost` is exact-host and **deprecated in the IDL**.
- `deleteDataFromPrincipal` is one origin (scheme+host+port) and over-clears
  sloppily: `CookieCleaner` falls back to host+OA wildcard matching.
- The site form is schemeless (covers http/https), includes subdomains via
  `Services.eTLD.hasRootDomain`, and takes an `OriginAttributesPattern` so it
  reaches every container.
- It also clears **other sites' data partitioned under this site** — the third
  branch of `hasSite()`, matching `partitionKeyPattern: { baseDomain: site }`.

### Shutdown clearing

`sanitizeOnShutdown()` reads **only** `privacy.clearOnShutdown_v2.*`. The
legacy `privacy.clearOnShutdown.*` branch survives solely as migration input
(and is still written by old checkboxes for Sync). The effective shutdown set
is `{cache, browsingHistoryAndDownloads, cookiesAndStorage, siteSettings,
formdata}`.

Two traps:

- `privacy.clearOnShutdown_v2.downloads` is referenced by a Sync pref but has
  no default and is not a `Sanitizer.items` key — **dead**.
- `privacy.clearHistory.*` and `privacy.clearSiteData.*` are UI-state prefs
  only; the dialog builds its clear list from **checkbox ids**, not from those
  prefs.

`persist-data-on-shutdown` — the permission that lets a user keep one site's
login through a shutdown clear — is **central only**
([bug 1767271](https://bugzilla.mozilla.org/show_bug.cgi?id=1767271), FF154).
ESR 140 has no such thing.

### Bits are full

`nsIClearDataService`'s bitfield is exhausted. `CLEAR_BFCACHE` shares bit 1
with `CLEAR_NETWORK_CACHE` with an apologetic FIXME; `CLEAR_PASSWORDS` and
`CLEAR_SESSION_HISTORY` were deleted in FF132 to make room. Do not assume a
flag exists because its name is obvious.

---

## 2. Transport: what the network still sees

### HTTPS-First is on by default; HTTPS-Only is not

- **HTTPS-Only** (Fx 83, opt-in): upgrade everything, and on failure **stop**
  with an interstitial.
- **HTTPS-First** (default for everyone since **Fx 136**,
  [bug 1921221](https://bugzilla.mozilla.org/show_bug.cgi?id=1921221)):
  upgrade, and on failure **silently fall back to HTTP**, no UI.

The distinction matters for any claim we make. HTTPS-First is a best-effort
optimisation, not a guarantee; only HTTPS-Only refuses to load insecurely.
Mozilla's stated reason for the switch: HTTPS-Only reached under 1% adoption
because it was opt-in and its warnings were intimidating.

Exceptions are stored in `nsIPermissionManager` under the type
`https-only-load-insecure`, with a distinct value for the silent HTTPS-First
downgrade versus a user-granted exception.

Since **Fx 127** passive mixed content (images, audio, video) is
**upgraded or blocked, never downgraded** — and the padlock warning triangle
was removed as a consequence.

### HSTS is a tracking vector, and Firefox's answer is partitioning

[RFC 6797](https://www.rfc-editor.org/rfc/rfc6797) §14.6 admits the bootstrap
hole: the first contact with an unknown host is unprotected. Preload closes
it; Firefox derives its list from Chromium's but **re-verifies live** and
**ignores the `preload` directive**, requiring `max-age >= 10886400` (18
weeks) observed on the wire. The shipped list expires 18 weeks after
generation.

HSTS state is per-host and readable by timing — the **Sniffly** attack
(Yan Zhu, 2015). Firefox's tracking bug
([1218778](https://bugzilla.mozilla.org/show_bug.cgi?id=1218778)) is **still
open and unassigned**. The shipped mitigation is generic: since **Fx 85** the
HSTS cache is partitioned by top-level site, along with the HTTP, image,
favicon, OCSP, style, font, DNS, HTTP-auth, Alt-Svc and TLS certificate
caches. That kills the cross-site supercookie use; it does not close
same-partition history sniffing.

### DoH moves trust, it does not remove it

Encrypted DNS protects only the stub→recursive hop. The recursive resolver
still speaks Do53 upstream and **learns every query you make**. That is what
Mozilla's TRR policy exists to constrain — ≤24h retention, QNAME
minimisation, EDNS(0) padding, no default filtering, published block lists,
annual transparency reports.

`network.trr.mode` values **1 and 4 are dead** — the IDL marks them
`MODE_RESERVED1` / `MODE_RESERVED4`. Note the tree's comments contradict the
wiki and the implementer's blog about what they used to mean; trust the IDL.

The canary domain `use-application-dns.net` disables DoH on NXDOMAIN — but
**only for users who got DoH as a rollout default**, never for a user who
turned it on themselves.

### ECH is an RFC now, and its weak point is the public name

`draft-ietf-tls-esni` became **[RFC 9849](https://www.rfc-editor.org/rfc/rfc9849.html),
Standards Track, 2026**. Anything calling ECH a draft is out of date.

Enabled by default in Firefox **119** (not 118 — the 118 release notes contain
no ECH bullet).

The structural weakness is that the outer ClientHello carries `public_name` in
cleartext. Cloudflare uses one shared name, `cloudflare-ech.com`, for every
ECH site — which is exactly what **Russia blocked from 2024-11-06**, forcing
site owners to opt *out* of ECH to stay reachable. A single shared public name
is a single chokepoint.

ECH also requires the HTTPS RR lookup to be encrypted, or the hostname leaks
in DNS milliseconds before the handshake that was meant to hide it.

### What an observer still sees with DoH + TLS 1.3 + ECH

**The destination IP, and it is very identifying.** Patil & Borisov (ANRW '19)
crawled the Alexa top 1M:

- **47.6%** of IPs map to exactly one domain; median anonymity set **2**.
- **68%** of IPs are unique to a single site.
- The union of IPs a page loads — the Page Load Fingerprint — is **unique for
  95.7%** of sites (903,199 of 944,094).

Their conclusion is the important one: protecting domain metadata "will
require not only protocol changes that remove the overt domain information but
also changes to web hosting infrastructure". CDN consolidation is the actual
privacy mechanism; ECH is only the enabler.

**And traffic analysis recovers names anyway.** Trevisan et al. (ACM TOIT
2022) recover domains from encrypted flows with **F1 > 0.8 for ~80% of
domains**, and conclude DoH and ECH "could give users a false sense of
protection". Siby et al. (NDSS 2020) attack the DoH channel itself using
n-grams of TLS record lengths, with **124× less data** than attacks on HTTPS
flows, and find standardised DNS padding ineffective. Sirinam et al. (CCS
2018) get **>98%** closed-world accuracy against undefended Tor and **>90%**
against WTF-PAD — if that works through Tor's fixed-size cells and constant
rate padding, plain TLS with ECH, which pads nothing, is strictly easier.

This is the single most important finding for how we describe our own
features: **encrypting names does not hide which site you visited from someone
watching your link.** That is a large part of the answer to "why is Tor still
used".

### Certificate revocation used to leak the hostname; CRLite fixed it

A live OCSP fetch goes to the CA over plaintext HTTP and reveals issuer +
serial, which maps back to the site — defeating ECH entirely. Stapling fixes
it at the protocol level. **CRLite** fixes it structurally: enumerate certs
from Certificate Transparency, download every CRL 4×/day, compress into
cascading Bloom filters (~6.7 GB of serials → ~1.3 MB), so there is no
per-connection query at all. Enabled for all desktop users in **Fx 137**;
Mozilla **disables OCSP for domain-validated certs in Fx 142**. Median TLS
handshake dropped 56.4 ms → 39.9 ms.

---

## 3. Open questions

Recorded deliberately — an open question stated plainly beats a confident
sentence we cannot support.

- No firefox-source-docs page exists for `toolkit/components/cleardata`; the
  anti-tracking data-sanitization page is stale (documents the removed
  `deleteByBaseDomain` and the pre-`_v2` prefs).
- Whether HTTP/3 keeps a resumption store separate from `SSLTokensCache`.
- Whether anything clears the OCSP cache at all.
- `network.trr.mode` 1/4: no removal bug found, and the tree contradicts the
  wiki on what they meant.
- `network.dns.http3_echconfig.enabled` vs `.enable` — two Mozilla sources
  disagree on the trailing `d`.
- `security.pki.crlite_mode` values 0 and 3 are asserted by secondary sources
  only.
- `support.mozilla.org` cannot be fetched by our tooling (JS shell), so all
  SUMO-derived claims above are second-hand via search extracts.

---

## 4. What this implies for tela-zen

The design conclusion, recorded so the build follows the research rather than
the other way round. Implemented as of `ZenSiteDataLifetime.sys.mjs` and the
Privacy pane; section 13 records what that actually delivers.

1. **Drive `nsIClearDataService`, do not reimplement it.** Use
   `deleteDataFromSite`, and be honest that DNS, Alt-Svc, OCSP and the auth
   cache have no per-site path.
2. **Never say "clears cookies" when we mean cookies.** Name what actually
   goes, and what stays. Every measurement above says users' intuition here is
   wrong.
3. **Do not claim network-level privacy from anything short of Tor.** DoH,
   HTTPS-First and ECH together still leave the destination IP and a traffic
   shape that identifies the site with high accuracy. Our Tor integration is
   the only thing in this browser that addresses a network adversary, and even
   it is subject to website fingerprinting.
4. **Prefer the shutdown-exception model over bespoke per-site lists** where
   central offers it (`persist-data-on-shutdown`), and check ESR deltas before
   relying on a flag.

---

## 5. Process sandboxing: the Linux content-process seccomp-bpf policy

Covers: what syscalls a content process can make on Linux, the six sandbox
levels, user-namespace/chroot mechanics, the file broker (what a compromised
content process can still read/write), which process types get no seccomp-bpf
policy at all, and what `MOZ_DISABLE_CONTENT_SANDBOX` actually turns off. Read
directly from `security/sandbox/linux/*`, `security/sandbox/linux/broker/*`,
`security/sandbox/linux/launch/SandboxLaunch.cpp`, `dom/docs/ipc/process_model.md`
and `browser/app/profile/firefox.js`.

### Levels are Linux-specific integers, not a shared scale

`security.sandbox.content.level` means something different per OS (comment at
`browser/app/profile/firefox.js:1663`). On Linux (default **6**, set at
`firefox.js:1679`):

| Level | Effect |
|---|---|
| 0 | no sandbox |
| 1 | removed; clamped to 2 |
| 2 | seccomp-bpf + write-only file broker |
| 3 | + read file brokering |
| 4 | + network/socket restrictions + chroot |
| 5 | + blocks GL/DRI/display-server access (sets `MOZ_HEADLESS` for the child) |
| 6 | + default-deny for `ioctl` |

The socket process has its own, unrelated 0–2 scale
(`security.sandbox.socket.process.level`, default 2: "default-deny for
ioctl"). Two different integers with the same name pattern, no shared meaning
— do not assume a level number carries over between process types.

Below level 2, filesystem access is **not brokered at all**: `GetContentPolicy`
in `SandboxBrokerPolicyFactory.cpp:826` special-cases `level <= 2` to strip
every deny rule and grant `AddTree(rdonly, "/")` — global read access. The
level-2/3 split is entirely about reads; level 2 already has the write broker.

### The file broker: what a compromised content process can still read

`SandboxBrokerPolicyFactory.cpp` builds the allowed-path table. At the default
level (6), a content process can still:

- read-only: `/etc`, `/usr/share`, `/usr/local/share`, `/usr/lib{,32,64}`,
  every `ldconfig` cache path, X11/Wayland font directories, `$XDG_CONFIG_HOME`,
  `$XDG_DATA_HOME/fonts`, `~/.fonts.conf`, `~/.Xauthority`, `/proc/<pid>/{maps,stat,status}`
  of itself, `/dev/{urandom,random}`, `/proc/cpuinfo`, `/proc/meminfo`.
- read-only, **inside the profile**: `<profile>/chrome` and (via `AddFutureDir`,
  so newly-created files are covered too) `<profile>/extensions`. Nothing else
  in the profile is reachable — no cookies DB, no places.sqlite, no saved
  logins, directly. (`SandboxBrokerPolicyFactory.cpp:717-745`)
- write: a **per-pid** slice of `/dev/shm` (`AddSharedMemoryPaths`, keyed by
  pid so processes can't interfere with each other's or PulseAudio's shared
  memory), the DConf shm path under `$XDG_RUNTIME_DIR/dconf` (bug 1321134),
  GPU device nodes (`/dev/dri`, `/dev/nvidia*`), `/dev/null`. ALSA (`/dev/snd`)
  and PulseAudio's `/dev/shm` tree are only opened below level 4.
- distro/user overrides: `security.sandbox.content.write_path_whitelist` and
  `.read_path_whitelist`, both empty by default.

`file://` content processes (`aFileProcess=true`) get the same level-2-or-below
treatment as a permanent exception — `RemoveAllDenyRules()` unconditionally —
which is why `prealloc` processes are barred from ever being repurposed as
`file` processes (`dom/docs/ipc/process_model.md`, Preallocated Content
section): a preallocated process can't be un-widened after the fact.

### Namespaces, chroot, and the syscalls themselves

User namespaces are required for anything beyond the seccomp-bpf filter itself
— chroot and the per-process net/IPC namespaces all sit behind
`CLONE_NEWUSER`. `SandboxInfo::CanCreateUserNamespace()`
(`SandboxInfo.cpp:111`) doesn't trust `/proc/self/ns/user`'s mere existence;
it actually forks a child, has it `unshare(CLONE_NEWUSER)` then
`unshare(CLONE_NEWPID)`, and checks the child's exit code — because an
AppArmor policy can permit `CLONE_NEWUSER` while blocking everything useful
you'd do with it afterward (bug 1434528), and a newer AppArmor feature can
even allow the unshare of NEWUSER+NEWPID/NEWNET together but still block
follow-on capability use (bug 1884347). The result is cached in
`MOZ_ASSUME_USER_NS` so child processes skip the fork-and-test.

`SandboxLaunch.cpp:358-390`: for `GeckoProcessType_Content`, chroot and
`CLONE_NEWNET` are only requested at level ≥4; whether the network namespace
is actually applied at level 4 (vs. deferred to level 5) further depends on
`IsGraphicsOkWithoutNetwork()` — i.e. whether the local display stack needs a
network socket to function. Socket, GMP, and RDD/Utility processes chroot at
level ≥1 of *their own* level pref, each adding different namespace flags
(`CLONE_NEWIPC` for socket/GMP/Utility, `CLONE_NEWNET` for GMP/RDD/Utility) —
the namespace set is process-type-specific, not inherited from content.

The seccomp-bpf policy itself (`SandboxFilter.cpp`, 2421 lines) is a large
allow/trap/error switch over syscall numbers, evaluated per `EvaluateSyscall`
override per process-type policy class (`ContentSandboxPolicy`,
`RDDSandboxPolicy`, `SocketProcessSandboxPolicy`, `UtilitySandboxPolicy`, all
subclassing `SandboxPolicyCommon`). Representative specifics:

- `getppid()` is trapped and hard-coded to return 0 (`GetPPidTrap`,
  `SandboxFilter.cpp:1433`) — a content process cannot even learn its own
  parent pid, "to see what breaks when we introduce the pid namespace" (bug
  1151624).
- `ioctl` gets a real allowlist below level 6 (`kTtyIoctls` gate at
  `SandboxFilter.cpp:1598`) and is otherwise default-denied at level 6.
- `SYS_SOCKET`/`SYS_CONNECT` are unconditionally allowed **below level 4**
  and go through `SandboxPolicyCommon`'s (brokered) evaluation at level ≥4.
  `SHMGET`/SysV IPC calls are denied unless `MOZ_SANDBOX_ALLOW_SYSV` is set,
  with an explicit comment that SysV IPC "follows the Unix same-uid policy and
  can't be restricted/brokered like file access" — an acknowledged gap papered
  over by simply not needing SysV IPC, rather than by containing it.
- RDD's `EvaluateSocketCall` (`SandboxFilter.cpp:2012`) denies `SYS_SOCKET`
  outright with `EACCES` specifically because EGL hardware-decode probing
  tries to reach a Wayland (or sometimes X11) socket even when nothing is
  there to connect to — "X11 is blocked now" per bug 1884449.

### What a compromised content process (level 6, the shipping default) can still reach

Directly: its own per-pid `/dev/shm` slice, `/dev/dri` and `/dev/nvidia*` GPU
device nodes, DConf's shared-memory segment, read access to system fonts/libs
and to its own profile's `chrome/` and `extensions/` directories, and whatever
the IPC channel to the parent process exposes (which is the real remaining
attack surface — the seccomp-bpf policy does not, and cannot, constrain what
the *parent* process does in response to a message from a compromised child).
It cannot: read cookies/history/passwords/other profile files directly, reach
the network without going through the brokered path, touch GL/DRI at level 5+
(`MOZ_HEADLESS` is forced), or issue most `ioctl`s. Escalation therefore has
to go through either an IPC-handling bug in the privileged parent, or pivoting
into a process type with a weaker or absent sandbox — GPU and VR.

### GPU and VR processes have no seccomp-bpf policy on Linux at all

`security/sandbox/linux/SandboxFilter.cpp` defines policy classes for content,
RDD, socket, GMP, and utility — there is no `GpuSandboxPolicy` or
`VrSandboxPolicy` anywhere in the Linux sandbox source. This matches
`dom/docs/ipc/process_model.md`, which states outright `:sandboxed?: no` for
both, citing open bugs (1347710 for GPU, 1430043 for VR) tracking future
sandboxing "on windows" specifically — Linux isn't even mentioned as a target
yet. A compromised GPU process — reachable via a driver bug from any content
process doing WebGL/canvas/video — runs with no syscall filtering whatsoever.
This is a materially different posture from a network-facing content-process
compromise, and it is the actual weak point in the process story, not the
content sandbox itself.

### `MOZ_DISABLE_CONTENT_SANDBOX` disables the file broker too, not just seccomp

`SandboxInfo::SandboxInfo()` (`SandboxInfo.cpp:209`) checks the env var once,
at static-init time, before the pref service exists — setting it clears
`kEnabledForContent` for the whole process lifetime, prefs cannot override it.
`SetContentProcessSandbox()` (`Sandbox.cpp:702`) then returns `false`
immediately when that flag is unset: it closes the inherited broker file
descriptor and **never calls `SetCurrentProcessSandbox`** — meaning the
seccomp-bpf filter is never installed *and* the file broker that mediates
"level 2+" filesystem access is never attached. The env var doesn't lower the
level; it removes both layers, leaving the content process with the same
filesystem and syscall access as the parent process. (`browser_browserGlue_sandboxDisabledNotification.js`
confirms the UI surfaces a persistent warning when `security.sandbox.content.level`
is set to 0, which is the pref-level equivalent for testing distros' broken
configs — a different code path from the env var, but the same end state.)

### vs. Chromium (secondary source — no Chromium tree available here)

From public Chromium sandboxing documentation, not read locally: Chromium's
Linux sandbox is also seccomp-bpf plus namespaces, structured as two
independently-toggleable layers (a "setuid/namespace" layer establishing the
pid/network/mount namespace jail, and a BPF layer for syscall filtering), and
Chromium **does** apply a seccomp-bpf policy to its GPU process (a looser one
than the renderer's, but a policy exists). Firefox's GPU process, per the
primary source above, currently has none on any platform. This is a real,
citable difference, but should be described as "as of this Firefox 154 tree
compared with published Chromium docs," since the Chromium side wasn't
verified against Chromium source in this pass.

---

## 6. Site isolation (Fission): what "isolated" means and what it doesn't cover

Covers: how Fission keys processes by site (not origin), what COOP+COEP adds
on top, Spectre/Meltdown as the documented motivating threat — including the
non-obvious fact that Firefox turns *off* its in-JS-engine Spectre mitigations
inside Fission-isolated processes — and the known, in-tree-documented gaps.
Read from `dom/ipc/ProcessIsolation.cpp`, `caps/ContentPrincipal.cpp`,
`caps/BasePrincipal.cpp`, `dom/docs/ipc/process_model.md`,
`docs/overview/gecko.md`, `modules/libpref/docs/index.md`,
`dom/ipc/ContentChild.cpp`, and `modules/libpref/init/StaticPrefList.yaml`.

### The isolation key is "site" (scheme + eTLD+1), not origin

`ContentPrincipal::GetSiteOriginNoSuffix` (`caps/ContentPrincipal.cpp:412`):
for `http`/`https` it takes the full origin, strips the port, and replaces the
host with `nsIEffectiveTLDService::GetBaseDomainFromHost` — i.e. scheme plus
registrable domain. For every other scheme the "site" **is** the full origin
unchanged. Consequences that follow directly from the code:

- `https://a.example.com` and `https://b.example.com` are the **same site**
  and, under the default strategy, land in the **same** `webIsolated=` process
  — Fission isolates cross-site, not cross-origin, by design. Two subdomains
  of the same registrable domain share a process and are not protected from
  each other by Fission (they still get separate `BrowsingContext`s and
  script-security same-origin checks; they just aren't process-separated).
- `http://example.com` and `https://example.com` are **different sites**
  (different scheme) and get different `webIsolated=` process pools.
- IP-literal and single-label hosts (`localhost`) fail `GetBaseDomainFromHost`
  and fall back to the untruncated host as the "site" — effectively per-host
  isolation for those, not per-domain.

### Default strategy is `IsolateEverything`, not `IsolateHighValue`

`fission.webContentIsolationStrategy` defaults to `1` = `IsolateEverything`
(`StaticPrefList.yaml:6796`; no override found in `firefox.js`). Enum defined
in `dom/ipc/ProcessIsolation.cpp:58-73`:

- `0 IsolateNothing` — everything in the shared `web` pool (pre-Fission-like).
- `1 IsolateEverything` — every site with a determinable site-origin gets its
  own `webIsolated=$SITE` process pool; only content whose site-origin can't
  be determined (e.g. user-navigated `data:` URIs) falls back to shared `web`.
  **This is the shipping default.**
- `2 IsolateHighValue` — only isolates sites carrying a `highValue*`
  permission grant. The doc comment notes this is overridden on Android via
  Nimbus (Fenix) or hardcoded to `2` in Android Components' default settings
  — i.e. Android ships the weaker strategy by policy, not by this pref's
  stated default.

`highValue` permissions are granted by two triggers and both **expire after
30 days** (`fission.highValue.coop.expiration` / `.login.expiration`, both
2592000s): a site that sent a correctly-configured COOP header, or a site the
login-detection service saw a successful login on
(`fission.highValue.login.monitor`, forced on for Android regardless of
strategy — so Android tracks "logged in" sites for isolation purposes even
though it isolates almost nothing else by default).

### Spectre/Meltdown is the explicitly documented motivation — and Firefox turns off its own JS mitigations where Fission applies

`docs/overview/gecko.md`, verbatim: "In 2021, as part of the mitigations for
the Spectre and Meltdown processor vulnerabilities, Firefox's process model
changed to enforce a model where each content process only loads and executes
instructions from a single site (this was Project 'Fission')." Process
isolation is described as *the* Spectre mitigation, not *a* layer alongside
others.

That framing is borne out by a genuinely surprising piece of code:
`ContentChild.cpp:2793`, `RecvSetXPCOMProcessAttributes` —

```cpp
// Turn off Spectre mitigations in isolated web content processes.
if (StaticPrefs::javascript_options_spectre_disable_for_isolated_content() &&
    StaticPrefs::browser_opaqueResponseBlocking() &&
    (remoteTypePrefix == FISSION_WEB_REMOTE_TYPE ||
     remoteTypePrefix == SERVICEWORKER_REMOTE_TYPE ||
     remoteTypePrefix == WITH_COOP_COEP_REMOTE_TYPE ||
     aRemoteType == PRIVILEGEDABOUT_REMOTE_TYPE ||
     aRemoteType == PRIVILEGEDMOZILLA_REMOTE_TYPE)) {
  JS::DisableSpectreMitigationsAfterInit();
}
```

Both gating prefs default **true on desktop** (`javascript.options.spectre.disable_for_isolated_content`
default `true`; `browser.opaqueResponseBlocking` default `true` on desktop,
**`false` on Android** — `StaticPrefList.yaml:2211`, `:10175`). So on desktop,
by default, `webIsolated=`, `webServiceWorker=`, `webCOOP+COEP=`,
`privilegedabout`, and `privilegedmozilla` processes run with the JS engine's
own Spectre array-bounds-masking and related JIT mitigations **disabled**,
because process-level site isolation is considered sufficient there and the
JIT mitigations cost performance. Android keeps the JS-level mitigations on
inside those same process types (via the `opaqueResponseBlocking` gate being
off), consistent with Android defaulting to the weaker `IsolateHighValue`
strategy where more content shares a process and JS-level defense-in-depth
still matters more.

A second Spectre-driven design decision, independent of Fission proper:
`modules/libpref/docs/index.md` documents pref "Sanitization" — prefs
matching a denylist (or dynamically-named string prefs) are stripped before a
value ever reaches a content process, explicitly "to protect private user
data that may be stored in preferences from a Spectre adversary." This is
Firefox treating *its own preference values* as readable-via-speculation by
a compromised-but-still-sandboxed content process — a tacit admission that
process isolation contains a Spectre read primitive to the process, not that
it eliminates the primitive.

### Documented gaps: what Fission explicitly does not isolate

- **Extension subframes.** `dom/docs/ipc/process_model.md`, WebExtensions
  section: "`moz-extension://` subframes are currently loaded in the same
  process as the parent document, rather than in the `extension` content
  process, due to existing permissions behaviour granting content scripts the
  ability to access the content of extension subframe content. This may
  change in the future." An extension iframe embedded in a hostile page does
  not get Fission's process boundary.
- **Undeterminable-origin content** (chiefly user-triggered `data:` URI
  navigations) falls back to the shared `web` pool by construction of
  strategy `1` — sharing a process with unrelated sites.
  `IsolateNothing`/no-Fission installs never isolate at all; e10s-only (no
  Fission) is still a supported, weaker configuration.
- **Two isolated-process concepts with confusingly overlapping names.** The
  `webIsolated=` remote type (Fission's per-site isolation) and the
  `webCOOP+COEP=` remote type (cross-origin-isolation for `SharedArrayBuffer`)
  are different mechanisms, but the code's own comment
  (`dom/docs/ipc/process_model.md`, COOP+COEP section) flags that
  `window.crossOriginIsolated` was named after Fission's "Isolated Web
  Content" was already the established term — "Unfortunately that may be
  confused with Fission's 'Isolated Web Content' processes." `about:processes`
  labels the latter `(pid, cross-origin isolated)` to disambiguate at the UI
  level, but the underlying vocabulary collision is real and admitted, not
  fixed.
- **Same-site subdomains are not protected from each other**, as derived
  above from the site-vs-origin key — this is inherent to the "site" concept
  used by Fission (and matches the WHATWG/HTML "obtain a site" algorithm's
  intent), not a Firefox-specific shortfall, but it means Fission's isolation
  boundary is coarser than same-origin policy.
- **bfcache state is kept in the parent process** by default
  (`fission.bfcacheInParent`, `StaticPrefList.yaml:6758`, default `true`) —
  meaning back/forward-cached document state for an isolated site is held
  somewhere other than that site's own process, a deliberate architectural
  choice not called out as a security boundary either way in the comments
  read; flagged here as unexamined rather than asserted safe or unsafe.

---

## 7. Engine memory safety: how much of Gecko is actually Rust, and what that bought

Covers: an actual line-count measurement of this tree (not a quoted figure),
where Gecko's own Rust concentrates, the RLBox/wasm2c sandboxing of six C
libraries that were *not* rewritten, and Mozilla's own published data on what
share of a real component's security bugs were memory-safety bugs. Counted
directly against the checked-out tree with `find`/`wc`; RLBox config read from
`security/rlbox/moz.build`, `toolkit/moz.configure`,
`third_party/rlbox_wasm2c_sandbox`; bug-share claim read from Mozilla Hacks
(a primary Mozilla source, not a third party) since no such measurement exists
in-tree.

### Measuring the split honestly means deciding what counts as "Gecko"

Whole-tree line counts, this checkout, `obj-x86_64-pc-linux-gnu/` (build
output) excluded:

| Scope | Rust | C/C++ family (`.cpp .cc .c .h .hpp .mm`) |
|---|---|---|
| Excluding all of `third_party/` | 512,368 | 11,363,597 |
| `third_party/rust/` only (621 vendored crates) | 5,271,225 | — |

Naively excluding `third_party/` puts Rust at **4.3%** of the counted lines.
That number is misleading in both directions at once:

- It **undercounts** Rust, because several of Mozilla's own oxidation
  projects — `encoding_rs`, `mp4parse`/`mp4parse_capi` (the MP4 demuxer),
  the `neqo` QUIC/HTTP3 stack, `cubeb`/`audioipc` audio, `url`/`urlpattern` —
  ship as **vendored crates under `third_party/rust/`**, pulled from
  Mozilla-owned upstream repos via `mach vendor rust`, not as in-tree source.
  `media/mp4parse-rust/` in this checkout, for instance, contains only a
  `moz.build`, a header, and a README — the actual parser lives in
  `third_party/rust/mp4parse{,_capi}`. Excluding `third_party/` entirely drops
  these from the Rust count even though Mozilla wrote them specifically to
  replace C/C++ parsers.
- It **overcounts** the C/C++ side, because the non-`third_party` C figure is
  dominated by large, separately-maintained libraries that happen not to live
  under `third_party/`: `security/nss` alone is **875,985 lines of C** (NSS —
  its own project, predates Gecko, maintained independently), and
  `gfx/cairo` is **216,647 lines of C**. Neither is "browser engine logic" in
  the sense the question is asking about.

Net: there is no single honest ratio here without picking a scope, and this
research did not find one Mozilla publishes as a tree-wide, dated figure —
recorded as an open question below rather than asserted.

### Where Gecko's *own* Rust actually is: two subsystems, not a rewrite-in-general

Breaking the non-`third_party` 512,368 Rust lines down by top-level directory:
`servo/` (the Stylo CSS/style engine, ported from the Servo project) is
**171,161 lines**; `gfx/wr` (WebRender, the GPU renderer) is **140,622
lines**. Together, **311,783 lines — 61% of all non-vendored Rust in the
tree** — is these two components. The remainder is spread thin: `toolkit/`
61,126, `security/` 23,281, `intl/` 29,800, `netwerk/` 11,285, `dom/` 9,826,
`xpcom/rust/` 6,175. "Gecko is partly Rust" is materially a statement about
style resolution and rendering, not a general property of the codebase — most
directories (layout, DOM bindings, networking logic proper) are still
overwhelmingly C++.

### RLBox/wasm2c: six libraries sandboxed, not rewritten, and it's still shipping

`toolkit/moz.configure:2822`, `wasm_sandboxing_libraries()`, enabled by
default on every little-endian target (i.e. virtually every real build) via
`default_wasm_sandboxing_libraries`:

**graphite, ogg, hunspell, expat, woff2, soundtouch** — font shaping, media
demuxing, spell-check dictionaries, XML parsing, font decompression, and
audio pitch/tempo, respectively. All six are wired through
`security/rlbox/moz.build`, gated per-library by `MOZ_WASM_SANDBOXING_<NAME>`
config flags that this configure script sets true by default.

Mechanism (`security/rlbox/rlbox.mozbuild`, `third_party/rlbox_wasm2c_sandbox`,
`third_party/wasm2c`): the library is compiled to WebAssembly, `wasm2c`
transpiles that back into plain C, and *that* gets compiled into libxul like
any other translation unit. Memory accesses inside the sandboxed library are
bounds-checked against a private linear-memory region rather than the
process's real address space. Where supported (clang/gcc, x86_64, not
Windows, not ASAN/TSAN builds), a "Segue" optimization
(`WASM_RT_ALLOW_SEGUE`) uses the `fsgsbase` instruction and a spare x86
segment register to make that bounds check close to free — this is the same
technique the original Firefox 95 (2021) Mozilla Hacks post on RLBox
described, still present and still the default mechanism in this Firefox
154-era tree, not superseded by something else.

This is a narrower guarantee than a process sandbox or a Rust rewrite: code
inside the wasm2c sandbox still runs **inside the content (or media) process**
— what it isolates is that one library's memory from the rest of that
process, not that process from the system. A spatial memory-safety bug in,
say, `graphite` can no longer corrupt unrelated content-process state or gift
an attacker a foothold beyond the library's own sandboxed heap; it can still
produce wrong (tainted) output that the caller must not trust blindly — the
RLBox model requires the embedder to explicitly validate/copy values crossing
the boundary, and a caller that skips that step reintroduces the same class of
bug one level up.

### Mozilla's own published number for what fraction of security bugs are memory-safety

The only primary, dated, Mozilla-authored measurement found for this claim:
["Implications of Rewriting a Browser Component in
Rust"](https://hacks.mozilla.org/2019/02/rewriting-a-browser-component-in-rust/)
(Mozilla Hacks, Feb 2019), analysing every security bug ever filed against
Firefox's style component since its 2002 introduction, in the context of the
Stylo rewrite:

- **69** total security bugs recorded against the component over its
  lifetime; only **43 of 69** had received an official Mozilla security
  severity classification at the time of the analysis.
- **51 of 69 (73.9%)** were bugs "involving memory, bounds, null/uninitialized
  variables, or integer overflow" — the authors' stated definition of what
  Rust would have prevented.
- Of the **34** bugs rated critical or high severity, **32** were
  memory-related — i.e. essentially all of the worst bugs in this one
  component, over its whole life, were memory-safety bugs.

The post's own caveats, kept rather than smoothed over: Rust "explicitly does
not address" logic/correctness bugs, and during the actual Stylo port
engineers "accidentally reintroduced a critical security bug" because a logic
check was overlooked after some test automation was disabled to move faster —
their stated conclusion is that "code review, testing, and fuzzing still
remain essential" even with Rust's guarantees. This is a single-component,
2019-dated figure, not a whole-browser or current-year number — treated here
as exactly that, not extrapolated.

### Open questions (engine layer)

- No tree-wide, dated Mozilla figure for "what share of *all* Firefox
  security bugs are memory-safety bugs" was found — only the 2019
  style-component analysis (69 bugs, one component). Whether a newer or
  broader Mozilla-published number exists was not confirmed.
- Chromium's Linux sandbox comparison in §5 is from public Chromium docs, not
  a Chromium source tree read in this session — the specific claim that
  Chromium's GPU process carries *some* seccomp-bpf policy where Firefox's
  carries none should be re-verified against Chromium source before being
  stated as settled.
- Whether `fission.bfcacheInParent` (parent-process-held bfcache state for an
  isolated site, default on) has any documented security rationale — none was
  found in the prefs comment or elsewhere in this pass; flagged, not resolved.
- Whether GPU/VR sandboxing has since landed on Linux specifically (bugs
  1347710/1430043 are cited as open in `dom/docs/ipc/process_model.md`, dated
  to this checkout, but that doc's currency wasn't independently checked
  against Bugzilla bug status).
- The Rust-vs-C++ ratio in §7 depends entirely on scope choices (see table);
  no attempt was made to find or reconstruct whatever internal methodology, if
  any, Mozilla itself uses when it states Rust-share figures publicly.
- Whether `graphite`/`ogg` RLBox wiring (their `moz.build` files reference
  `*StructsForRLBox.h` headers but don't call `RLBoxLibrary()` directly
  themselves — the template call lives in `security/rlbox/moz.build`) is
  fully equivalent in coverage to `hunspell`/`expat`/`woff2`'s more visible
  per-library gating, or whether there's a scope difference between them —
  the build wiring was traced far enough to confirm all six are built and
  enabled by default, not far enough to confirm identical coverage depth.

## 8. Tracking protection and filter lists

### What Standard mode actually turns on

ETP's three tiers are not three independent configs. "Standard" is simply
**whatever `StaticPrefList.yaml` already defaults to**, plus a handful of
overrides `browser/app/profile/firefox.js` applies outside the category
system. "Strict" is the same baseline with every code in
`browser.contentblocking.features.strict` applied on top. This is enforced by
`browser/components/protections/ContentBlockingPrefs.sys.mjs`: its `standard`
`CATEGORY_PREFS` table maps every relevant pref to `null` — literally "expect
the default, whatever that is" — while `strict` maps the same prefs to values
computed by walking the `features.strict` string
(`docs/_addons/etp_matrix.py` documents this generation and is itself
auto-published to firefox-source-docs from the same two files, so the mapping
below is traceable to a single source of truth, not two).

Reading `modules/libpref/init/StaticPrefList.yaml` directly, Standard's real
defaults are less protective than most people assume:

| Pref | Standard default | Strict adds |
|---|---|---|
| `privacy.trackingprotection.enabled` (tracker **content** blocking, normal windows) | **false** | true (`tp`) |
| `privacy.trackingprotection.pbmode.enabled` | true | — |
| `privacy.trackingprotection.socialtracking.enabled` | **false** | true (`stp`) |
| `privacy.trackingprotection.emailtracking.enabled` (normal) | **false** | true (`emailTP`) |
| `privacy.trackingprotection.emailtracking.pbmode.enabled` | true | — |
| `privacy.trackingprotection.fingerprinting.enabled` | **true** (overridden by `firefox.js:2529`, default in the yaml is false) | — |
| `privacy.trackingprotection.cryptomining.enabled` | **true** (`firefox.js:2532`) | — |
| `privacy.trackingprotection.harmfuladdon.enabled` | **true** (`firefox.js:2526`) | — |
| `privacy.fingerprintingProtection` (normal) | false | true (`fpp`) |
| `network.cookie.cookieBehavior` | **5** (dFPI, `firefox.js:2517`) | 5, unchanged |
| `privacy.bounceTrackingProtection.mode` | **3 = dry-run** (see below) | **1 = enforced** (`btp`) |
| Level 2 (content-category) list | off | on (`lvl2`) |
| Strict referrer policy | off | on (`rp`,`rpTop`) |
| Query-param stripping | off | on (`qps`,`qpsPBM`) |

So in Standard mode, the thing actually blocking trackers in normal windows
is **not** the Disconnect content-blocking list at all — `tp` is off — it is
cookie-jar partitioning (§9) plus the always-on fingerprinting/cryptomining/
harmful-addon lists. Full tracker-content blocking by domain only turns on
(a) in private windows, or (b) everywhere, under Strict.

### Bounce Tracking Protection defaults to simulating, not purging

`privacy.bounceTrackingProtection.mode` is `uint32_t` with four values
(`nsIBounceTrackingProtection.idl`): `0` disabled, `1` `MODE_ENABLED` (real
purging), `2` `MODE_ENABLED_STANDBY` (collect signals, don't classify/purge),
`3` `MODE_ENABLED_DRY_RUN` (classify and log as if purging, purge nothing,
still send telemetry). The StaticPrefList default is **`1` on Nightly, `3`
everywhere else** — meaning release Standard-mode users get BTP's
classification and warning-console-messages, but no actual data deletion.
`ContentBlockingPrefs.sys.mjs` treats `MODE_ENABLED_DRY_RUN` explicitly as
"the off state" for UI purposes (comment at the `-btp` case), and only the
Strict category's `btp` code flips it to `MODE_ENABLED`. BTP's own meta-bug,
[1839915](https://bugzilla.mozilla.org/show_bug.cgi?id=1839915), is still
open with 23 dependencies. Mechanically: bounce-tracker candidates need a
short-lived-redirect intermediary hop; sites the user directly interacted
with in the last 45 days (`bounceTrackingActivationLifetimeSec` = 3,888,000s)
are exempt; classified trackers get a 1h grace period
(`bounceTrackingGracePeriodSec` = 3600) before purge, checked hourly.

### The Disconnect list: what it is and its structural limits

Firefox's tracking lists are Disconnect's `disconnect-blacklist.json` and
`disconnect-entitylist.json`, distributed via a service called **Shavar**
(`toolkit/components/antitracking/docs/tracking-lists/index.md`) and, as of
"the final stages" (dated August 2024 in that same doc), migrating to Remote
Settings. Category mapping is explicit: **Tracking** = Advertising +
Analytics + Social + Content + Disconnect categories (Level 1 list excludes
Content; Level 2, Strict-only, includes it); **Cryptomining** = the
Cryptomining category; **Fingerprinting blocking** (`fp`) = only domains in
*both* `FingerprintingInvasive` *and* one of the tracking categories —
Firefox does not consume the broader `FingerprintingGeneral` category at all.
The entity list exists so that first-party-owned third-party subresources
(e.g. a CDN owned by the same company as the site) aren't blocked as if
foreign.

Updates land every 2–3 months as PRs against
[shavar-prod-lists](https://github.com/mozilla-services/shavar-prod-lists),
manually reviewed and merged by Mozilla staff — this is a **curated,
reactive, domain-blocklist model**, structurally different from what a
network filter engine like uBlock Origin's does:

- **It is not heuristic.** A brand-new tracker domain is invisible until
  Disconnect adds it and Mozilla ships an update — a multi-week-to-multi-month
  gap, unlike a first-seen-behavior heuristic.
- **No CNAME-cloaking defense was found anywhere in this tree.** `CNAME`
  appears only in low-level DNS resolver code
  (`netwerk/dns/*`), never in `toolkit/components/antitracking/` or
  `netwerk/url-classifier/` for classification purposes. Public reporting
  states this plainly: Firefox's native ETP has no CNAME-uncloaking, while
  uBlock Origin *on Firefox* does — via a privileged DNS-resolution API the
  extension platform exposes only to Firefox, which is why "Firefox +
  uBlock Origin" is called out as the only combination that reliably catches
  CNAME-cloaked first-party-disguised trackers. This claim is from secondary
  sources (NextDNS's cloaking blocklist README, a WebKit blog post on the
  same class of attack, and third-party writeups of uBO's Firefox-only
  `uncloak` behavior), not a Mozilla document — flagged accordingly.
- **It is not an ad blocker.** The Disconnect categories are about tracking
  and fingerprinting/cryptomining infrastructure, not general advertising
  content. ETP alone does not block most ads the way EasyList-class filter
  lists do; a Firefox user who wants ad blocking, not just tracker
  partitioning, still needs an extension.
- **First-party tracking is out of scope by definition** — the classifier
  only ever evaluates third-party requests (`UrlClassifierFeatureTrackingProtection.cpp`),
  so analytics code the site itself serves from its own origin is invisible
  to it, cloaked or not.

### cookieBehavior 5 partitions everyone, not just trackers

`nsICookieService.idl` defines six values: `0` accept all, `1` reject foreign,
`2` reject all, `3` limit foreign (allow only if the eTLD already has a
first-party cookie), `4` `REJECT_TRACKER` (block only tracker cookies), `5`
`BEHAVIOR_PARTITION_FOREIGN`. Firefox ships **5**, not 4, as both the Standard
and Strict default (`firefox.js:2517,2520`). The distinction matters: 4 would
only block cookies from domains on the Disconnect list; 5 partitions the
cookie jar of *every* third party, tracker or not, into a separate bucket per
top-level site (mechanism in §9). This is why Firefox markets this
specifically as Total Cookie Protection rather than "tracker cookie
blocking" — it protects against trackers *not on any list* too, at the cost
of not fully blocking anything (a partitioned tracker still runs, still sets
a cookie, it just can't correlate that cookie across sites).

Two related knobs stayed off by default in this tree:
`network.cookie.cookieBehavior.optInPartitioning` (`false`, both normal and
`.pbmode`) — the "3pcd" block-by-default-with-explicit-opt-in model some
sites are being migrated toward — is not part of either Standard or Strict's
feature string at all right now; it exists but is unused by the category
system. `network.cookie.CHIPS.enabled` (`true` by default) is unrelated and
separate: it lets a site voluntarily set a `Partitioned` cookie itself,
independent of `cookieBehavior`.

### Storage-access heuristics are the intentional holes

Total Cookie Protection is deliberately punctured for webcompat.
`ContentBlockingNotifier::StorageAccessPermissionGrantedReason` enumerates
four ways a third party gets a **real, unpartitioned** storage-access grant:
`eStorageAccessAPI` (the site calls `document.requestStorageAccess()`
explicitly), `eOpener` (a same-site-family opened window), `eOpenerAfterUserInteraction`
(the opened window received a user interaction), and
`ePrivilegeStorageAccessForOriginAPI`. Two more heuristics sit outside that
enum entirely: `DynamicFpiRedirectHeuristic` (grants access to a site
involved in a recent redirect chain,
`toolkit/components/antitracking/DynamicFpiRedirectHeuristic.cpp`) and
`DynamicFpiNavigationHeuristic` — its own header describes it as looking
for "something that is a lot like a redirect auth flow where you interact
with the intervening page," explicitly reusing BTP's "extended navigation"
concept to *grant* access rather than purge. Individual heuristics are
pref-gated (`privacy.restrict3rdpartystorage.heuristic_window_open`,
`.heuristic_opened_window_after_interaction`,
`.heuristic_exclude_third_party_trackers` — this file did not establish their
default values; flagged as open question). Net effect: a determined tracker
that participates in login/redirect flows, or gets a user click in a popped
window, has multiple sanctioned paths back to the unpartitioned jar — this is
not a bug, it is documented product behavior, and it is the honest answer to
"does TCP actually stop cross-site tracking."

---

## 9. State partitioning as a mechanism

### Two unrelated features that sound like the same thing

`privacy.firstparty.isolate` (legacy FPI, Tor-Uplift era, default **false**,
`RelaxedAtomicBool`) and dynamic FPI (dFPI, what `cookieBehavior=5` drives)
are separate code paths that happen to write into the same struct
(`OriginAttributes`, `caps/OriginAttributes.h`/`.cpp`). Old FPI sets
`mFirstPartyDomain` — but only when `privacy.firstparty.isolate` is true
*and* the load is a top-level document
(`OriginAttributes::SetFirstPartyDomain`, gated on `!aForced`). dFPI sets a
different field, `mPartitionKey`, via `SetPartitionKey`, which is always
called with `aForced = true` — it does not check the old FPI pref or
top-level-ness at all. The two can coexist (`operator==` compares both
fields) but a build shipping dFPI (every Firefox since cookieBehavior 5
became default) gets partitioning with old FPI left off; enabling old FPI on
top adds double-keying by exact first-party domain on top of the
site-partitioned key, a strictly stronger and much more webcompat-hostile
setting almost nobody runs.

### The partitionKey format

From `caps/OriginAttributes.cpp`'s `MakeTopLevelInfo` (comment: "If you
change the serialization of the partition-key, please update
StoragePrincipalHelper.cpp too" — the format is treated as a stable, relied-
upon on-disk contract):

```
(scheme,site)      e.g. (https,example.com)
(scheme,site,f)    "f" = foreignByAncestorContext
```

`site` is `nsIEffectiveTLDService::GetBaseDomain` — the eTLD+1, not the exact
host — gated by `privacy.dynamic_firstparty.use_site` (default **true**).
`foreignByAncestorContext` (the trailing `,f`) is set when a resource is
third-party to the top window strictly *because* of nesting through an
intermediate ancestor, even though the resource's own document is loaded in
a context where `IsThirdPartyChannel` and `IsThirdPartyContextToTopWindow`
disagree — i.e. it distinguishes "framed by a same-site page that is itself
framed cross-site" from ordinary top-level third-party loading, and gets a
distinct partition bucket for it
(`CookieJarSettings::UpdatePartitionKeyForDocumentLoadedByChannel`).
`moz-extension:` principals are explicitly exempted from ever getting a
`mFirstPartyDomain` (comment: "guarantee their storage integrity when
switching FPI on and off") — extension storage is unpartitioned by design,
which is the mechanism behind `browser.storage.local` behaving the same
regardless of which site's tab is active.

### Four principals, not two

`toolkit/components/antitracking/StoragePrincipalHelper.h` documents the
model precisely (and cites the standard it implements:
https://privacycg.github.io/storage-partitioning/):

- **Regular Principal** — no `partitionKey`. Used for network loading.
- **Partitioned Principal** — regular + `partitionKey` set to the top-level
  site. Always partitioned regardless of storage-access grants.
- **Storage Access Principal** — dynamic: equals the Partitioned Principal
  by default, but *becomes* the Regular Principal the moment storage access
  is granted (any of the heuristics in §8). This is what most storage APIs
  and, per the header's own guidance table, **caches** ("network cache,
  HSTS, image cache, etc.") are told to use.
- **Foreign Partitioned Principal** — dFPI-only; partitioned if third-party,
  regular if first-party, and unlike the Storage Access Principal it does
  **not** change when storage access is granted.

The header states outright that caches are not yet on the stronger
guarantee: *"Cache, not directly visible by content (network cache, HSTS,
image cache, etc): Use the Storage Access Principal (in the future we will
use the Partitioned Principal, but this part is not done yet)."* Practically:
a storage-access grant to a third party doesn't just unlock its cookies and
localStorage — because caches ride the same Storage Access Principal, the
same grant also unpartitions whatever cache bucket that principal maps to.
This is a live TODO in the source, not settled behavior.

### Known unpartitioned holes

Section 1 of this document already establishes (from the storage-lifecycle
angle) that the DNS cache, Alt-Svc cache, OCSP cache, HTTP auth cache and
connection-pool history have **no per-site clearing path at all**; from the
partitioning angle the same caches are the ones StoragePrincipalHelper.h
flags as running on the weaker, storage-access-permeable principal rather
than the always-partitioned one. The two problems compound: a cache that
isn't partitioned by top-level site to begin with is also not something
"forget this site" can retroactively fix.

---

## 10. Fingerprinting resistance

### Three tiers, not one switch

There are three independently-defaulted layers, confirmed directly in
`modules/libpref/init/StaticPrefList.yaml`:

| Pref | Normal-window default | PBM default |
|---|---|---|
| `privacy.resistFingerprinting` (RFP) | false | false (`.pbmode`) |
| `privacy.fingerprintingProtection` (FPP) | false | **true** (`.pbmode`) |
| `privacy.baselineFingerprintingProtection` (bFPP) | **true**, browser-wide, no separate pbmode pref | — |

The comment on `privacy.baselineFingerprintingProtection` in the yaml is
unambiguous: *"Enable/Disable fingerprinting protections that are enabled in
Enhanced Tracking Protection Standard mode... bFPP cannot be enabled in only
PBM, it is either enabled browser-wide or disabled browser-wide."* This means
**every Firefox user, in every window, with every ETP setting at Standard and
RFP/FPP both untouched, already has a small fixed set of fingerprinting
countermeasures active by default** — and separately, every private window
gets the larger FPP set on top, also without the user opening a settings
page. This is a materially different story than "fingerprinting resistance
is a Tor-Browser/opt-in-only feature," and it should shape how tela-zen
describes its own baseline versus what it adds.

The actual target sets are compiled in from two `.inc` files
(`nsRFPService.cpp:141-162`):

- **bFPP** (`RFPTargetsDefaultBaseline.inc`, desktop): `EfficientCanvasRandomization`,
  `ScreenAvailToResolution`, `MaxTouchPointsCollapse`. Three items, always on.
- **FPP** (`RFPTargetsDefault.inc`, desktop): the three above, plus
  `CanvasRandomization`, `FontVisibilityLangPack`, `JSMathFdlibm`,
  `NavigatorHWConcurrencyTiered` — released in this build; Nightly also adds
  the full `WebGLRendererConstant`/`WebGLVendorRandomize`/`WebGLVendorConstant`/
  `WebGLVendorSanitize` set (comment: "Randomize overrides Constant which
  overrides Sanitize... include them all so relaxing one still enforces the
  others").

Strict ETP's `fpp`/`fppPrivate` codes turn FPP on for normal windows too
(§8's table). Full RFP is the only tier that is opt-in everywhere, always.

### What RFP covers when it's on

`RFPTargets.inc` enumerates 81 named targets plus two special values
(`IsAlwaysEnabledForPrecompute`, and `AllTargets` for an override list). The
surface is far broader than "canvas noise": touch/pointer/keyboard event
details, screen orientation, speech synthesis, seven distinct CSS
media-feature leaks (`prefers-color-scheme`, `prefers-reduced-motion`,
`prefers-contrast`, `prefers-reduced-transparency`, `inverted-colors`,
`video-dynamic-range`, `resolution`, `color`/`color-gamut`,
`device-height`/`device-width`), canvas extraction (randomization +
third-party block + pre-user-input block + extraction prompt, four separate
targets), WebGL render capability/info/randomization/vendor spoofing,
`navigator.*` spoofing (appVersion, buildID, hwConcurrency, oscpu, platform,
userAgent, plus whether PDF.js is disabled), window/screen geometry rounding
(outer size, screen XY, inner-screen XY, pixel depth, screen rect/avail-rect,
device-pixel-ratio, general window-size rounding), video-element frame
counters and playback quality, gamepad, media devices/capabilities, audio
sample rate, network-connection info, font-visibility (base-system,
lang-pack, and CSS generic-family resolution separately), device sensors,
frame rate, AudioContext, WebGPU limits/fallback-adapter/subgroup sizes,
locale (both the JS-exposed value and a user prompt), WebCodecs, and IME
composition styling. The call graph documented in
`toolkit/components/resistfingerprinting/docs/implementation.md` funnels all
of this through a small number of chokepoints (`Document::ShouldResistFingerprinting`
being the fast/correct one; two variants explicitly marked *dangerous*
because they skip the system-principal/PBM/webextension/about-page checks
further up the call stack).

### Timer coarsening: two different guarantees

`privacy.resistFingerprinting.reduceTimerPrecision.microseconds` (general
Spectre-era mitigation, independent of RFP) defaults to **1000µs (1ms)**,
with jittering on by default
(`reduceTimerPrecision.jitter` = true). When RFP itself is the caller
(`RTPCallerType::ResistFingerprinting`), `nsRFPService::TimerResolution`
floors the value at `RFP_TIME_ATOM_MS * 1000` where `RFP_TIME_ATOM_MS =
16.667` (a 60Hz frame interval, the comment says so explicitly) — i.e. RFP
coarsens high-resolution timers to whichever is larger, 16.667ms or the
configured pref, deliberately aligned to a frame boundary rather than an
arbitrary round number. Separately, *even with timer-precision reduction
entirely off*, every timestamp is unconditionally clamped to 20 microseconds
(`RFP_TIMER_UNCONDITIONAL_VALUE`) "to avoid leaking nano-second precision" —
a floor nobody can disable via prefs.

### Letterboxing may not be wired to RFP the way people assume

`privacy.resistFingerprinting.letterboxing` (window-size bucketing with a
CSS-painted colored bar, `toolkit/components/resistfingerprinting/content/letterboxing.css`,
driven by `RFPHelper.sys.mjs`) is a **separate pref from `resistFingerprinting`
itself**, and in this checkout it has no compiled-in default anywhere: not in
`StaticPrefList.yaml`, not in `firefox.js`, not in `modules/libpref/init/all.js`
— the only place the string appears is `RFPHelper.sys.mjs`, which reads it as
`Services.prefs.getBoolPref(kPrefLetterboxing, false)`, i.e. **false unless
something outside this tree sets it**. `_handleResistFingerprintingChanged()`
— the observer that fires when `privacy.resistFingerprinting` itself changes
— does not touch the letterboxing pref at all. So, on the evidence in this
tree, flipping RFP on does not by itself turn on letterboxing; they are wired
as independent toggles, contrary to the common assumption that letterboxing
is bundled into RFP. This may be set by a distribution default, GeckoView
config, or Nimbus rollout not present in this checkout — flagged as an open
question rather than asserted as release behavior, because it would be an
easy thing to get backwards.

### Why RFP stays opt-in, and the anonymity-set argument

The usability cost is legible directly from the target list above: spoofed
timezone/locale, disabled dark-mode detection, hardware-concurrency lies,
WebGL vendor/renderer spoofing — all things real sites use for legitimate
adaptation, not just fingerprinting, so RFP has a materially higher
webcompat cost than FPP/bFPP. That is presumably why Mozilla ships the
narrow, low-breakage bFPP/FPP subsets to 100% of users and reserves the full
target list for opt-in.

The deeper, more interesting tradeoff — not verifiable from source, this is
a reasoning/measurement argument, not a code fact — is that RFP's spoofed
values are only as anonymizing as the population running RFP is large and
uniform. A user who turns RFP on presents an internally-consistent but
*rare* fingerprint (UTC timezone, en-US locale mismatch flags, hardcoded
hardware-concurrency tier) that can itself be a distinguishing signal to a
fingerprinter checking "is this the RFP profile" — uniform *within* the RFP
population, conspicuous *outside* it. The measurement literature disagrees
sharply on how big the underlying problem is even without RFP in the
picture:

- **Panopticlick** (Eckersley, EFF, 2010): of ~470,161 fingerprints, **83.6%**
  were unique; **94.2%** with Flash or Java enabled.
- **AmIUnique** (Laperdrix et al., 2016): of 118,934 fingerprints, **89.4%**
  unique overall (90% desktop, 81% mobile).
- **"Hiding in the Crowd"** (Gómez-Boix et al., WWW 2018, 2M+ fingerprints
  collected from a large French website using the same 17 attributes as
  AmIUnique): only **33.6%** unique — a large disagreement with the two
  prior studies, attributed to a broader, less power-user-skewed sampled
  population.

These three do not reconcile cleanly and are left contested rather than
averaged: the population sampled changes the answer by a factor of ~2.5,
which is itself evidence for the anonymity-set argument above — uniqueness
is not solely a property of the browser, it is a property of browser-within-
population.

---

## 11. Permissions and the extension attack surface

### What a host permission actually grants

A `host_permissions` (MV3) / `permissions` (MV2) match gives an extension:
content-script injection rights on matching pages (subject to the
restrictions below), `fetch()`/XHR to that origin without the page's CORS
policy applying to the extension's own privileged context, and whatever the
extension's declared API permissions expose scoped to that host (cookies,
webRequest visibility, etc.). It is a broad grant — this is the surface every
extension review process exists to police.

### activeTab is not a persistent host permission

`toolkit/components/extensions/ExtensionPermissions.sys.mjs` (~line 679-730)
computes access per-URL and explicitly distinguishes `activeTab` from a real
origin grant: if the extension declares `activeTab` and lacks a matching
`optionalOrigins`/`allowedOrigins` entry, the function returns
`{ whenClicked: true, temporaryAccess }` rather than `{ alwaysOn: true }`.
`activeTab` is only meaningful for MV3 extensions generally, or MV2
extensions that have a browser-action UI (`policy.manifestVersion >= 3 ||
policy.extension?.hasBrowserActionUI`) — the click-to-grant model doesn't
exist for a background-only MV2 extension with no action button. This
matches the platform's public design intent (temporary, tab-scoped,
non-persistent) and is confirmed here at the code level, not just from docs.

### Two different domain-exclusion mechanisms, one hard and one soft

Two independent lists stop extensions from touching sensitive origins,
enforced in `toolkit/components/extensions/ExtensionPolicyService.cpp` and
`WebExtensionPolicy.cpp`:

- **`extensions.webextensions.restrictedDomains`** (hardcoded in
  `modules/libpref/init/all.js:3136`) — 11 Mozilla-operated domains:
  `accounts-static.cdn.mozilla.net`, `accounts.firefox.com`,
  `addons.cdn.mozilla.net`, `addons.mozilla.org`, `api.accounts.firefox.com`,
  `content.cdn.mozilla.net`, `discovery.addons.mozilla.org`,
  `oauth.accounts.firefox.com`, `profile.accounts.firefox.com`,
  `support.mozilla.org`, `sync.services.mozilla.com`. No bypass flag was
  found for this list in `WebExtensionPolicy.cpp` — it protects Mozilla's
  own infrastructure (AMO, Sync, Firefox Accounts) unconditionally.
- **`extensions.quarantinedDomains.list`** (`extensions.quarantinedDomains.enabled`
  = true by default, but the *list itself ships empty* — `""` in
  `modules/libpref/init/all.js:3140` — populated at runtime via Remote
  Settings, not compiled into the tree) — a general-purpose,
  site-operator-facing mechanism (intended for banks, enterprise SaaS, etc.)
  that any extension can be exempted from individually: `WebExtensionPolicy`
  carries a settable `mIgnoreQuarantine` flag, true automatically for
  privileged extensions (`aInit.mIsPrivileged || aInit.mIgnoreQuarantine`,
  `WebExtensionPolicy.cpp:223`) and settable at runtime otherwise (the
  "Run this extension on sites with restrictions" toggle in `about:addons`,
  inferred from `SetIgnoreQuarantine`'s shape — not directly confirmed at
  the UI layer in this pass).

Content-script injection into `about:`/`chrome://`/`resource://` pages is
blocked by scheme restriction rather than either domain list; this is
established WebExtensions-platform behavior but was not independently
re-verified against `MatchPattern` code in this pass.

### Signing is a build-config decision, not a platform constant

`xpinstall.signatures.required` defaults to **false** in the base
`modules/libpref/init/all.js:3126` — meaning the raw Gecko platform does not
require signed extensions — and is forced to **true** specifically for
Firefox Desktop by `browser/app/profile/firefox.js:74`. Any downstream build
(this repo included) inherits whichever of these two files it actually
applies; the enforcement is an application-level override, not something
baked into `xpinstall`/AMOs's own protocol. Public reporting (not verified
against Mozilla source in this pass) describes the review pipeline as
"publish first, review second" since a 2017 process change: uploaded
extensions pass an automated linter and go live on AMO immediately, with
human review following asynchronously — a change explicitly linked in
contemporary reporting (gHacks, Mozilla Discourse) to the 2018–2019 waves of
cryptomining and spam add-ons that got through automated checks.

### The historical record is not reassuring, and it's recent

From secondary/journalism sources, explicitly not Mozilla primary
documents:

- **2020**: Mozilla banned 197 add-ons found running malicious code, phoning
  home to a remote server, exfiltrating user data, or obfuscating their
  source specifically to evade review.
- **December 2025 – January 2026**: security researchers (Koi Security,
  LayerX) disclosed three campaigns run by a group tracked as "DarkSpectre" —
  **ShadyPanda** (~4 million affected devices across browsers) and
  **GhostPoster** (malicious JavaScript steganographically hidden inside PNG
  icon files shipped with the extension; 17 compromised Firefox extensions
  identified, 840,000+ combined installs, some active since 2020 — roughly
  five years undetected). Mozilla, Microsoft and Google all removed the
  identified extensions from their stores on disclosure; removal disables
  the extension going forward but — per the reporting — does not retroactively
  undo whatever was already exfiltrated, and users who never update or check
  `about:addons` may not learn their extension was pulled.

This is squarely an argument for minimizing the trusted extension surface by
default (least-privilege permissions, no blanket `<all_urls>` grants where a
narrower one works) rather than relying on AMO review as a backstop — the
record shows multi-year gaps between compromise and detection are real, not
hypothetical.

### Gecko's own permission-prompt persistence model

`netwerk/base/nsIPermissionManager.idl` defines five expiry types:
`EXPIRE_NEVER = 0`, `EXPIRE_SESSION = 1`, `EXPIRE_TIME = 2`,
`EXPIRE_POLICY = 3`, `EXPIRE_SESSION_TAB = 4`. `browser/modules/SitePermissions.sys.mjs`
sets the *base* default scope for any new grant to `SCOPE_PERSISTENT`
(`EXPIRE_NEVER`) unless the caller explicitly passes `SCOPE_SESSION` or
`SCOPE_TEMPORARY` — and geolocation, notifications (`desktop-notification`),
camera and microphone are all registered in that file's permission table
with no scope override, meaning a plain "Allow" from one of those prompts is
persistent by default at the permission-manager level. (Whether the
in-prompt "remember this decision" UI defaults its checkbox to on or off for
camera/microphone specifically was not located in this pass — flagged as an
open question rather than asserted.) Two very new entries in the same table,
`loopback-network` and `local-network`, are gated behind
`SitePermissions.localNetworkAccessPermissionsEnabled` and connect directly
to §8's `lna`/`network.lna.blocking` Strict-ETP feature: the same Local
Network Access protection (blocking public sites from reaching RFC1918/
loopback/link-local addresses) is enforced at two different layers — a
network-level block for the general case, and a permission-prompt opt-in
for sites that have a legitimate reason to reach the local network.

---

### Open questions (content layer)

- Default state of `privacy.restrict3rdpartystorage.heuristic_window_open`,
  `.heuristic_opened_window_after_interaction`, and
  `.heuristic_exclude_third_party_trackers` — these gate whether the opener
  storage-access heuristic even runs, and whether it excludes known trackers,
  but their defaults were not located in `StaticPrefList.yaml` in this pass.
- Whether `privacy.resistFingerprinting.letterboxing` is set to `true` by
  some mechanism outside this checkout (distribution ini, Nimbus rollout,
  GeckoView default) — the in-tree evidence says it defaults false and is
  wired independently of `privacy.resistFingerprinting`, which contradicts
  the common assumption that RFP always implies letterboxing. Needs a
  release-build `about:config` check to confirm what ships, not just what's
  compiled in.
- The claim that Firefox's ETP has no CNAME-cloaking defense, and that
  uBlock Origin on Firefox specifically does via a privileged DNS API, rests
  on secondary sources (NextDNS, WebKit's blog, third-party uBO writeups),
  not a Mozilla document. The absence of `CNAME` in
  `toolkit/components/antitracking/` and `netwerk/url-classifier/` supports
  the first half directly; the second half (uBO's mechanism) was not
  independently verified against uBlock Origin's own source in this pass.
- Default checkbox state ("remember this decision") for the camera/
  microphone permission-prompt UI — `SitePermissions.sys.mjs` establishes
  `SCOPE_PERSISTENT` as the base default when no scope is specified, but the
  actual prompt call site that decides which scope to pass for
  camera/microphone was not located in this pass.
- Whether content-script injection into `about:`/`chrome://`/`resource://`
  is enforced the same way (scheme restriction on `MatchPattern`) as
  publicly documented for WebExtensions generally, or whether this tree has
  its own variation — not independently re-verified against `MatchPattern.cpp`
  in this pass.
- Precise default behavior of `network.cookie.cookieBehavior.optInPartitioning`
  ("3pcd") rollout plans — the pref exists and defaults false, and is not
  part of either Standard or Strict's feature string in this tree's
  `firefox.js`, but no bug or Nimbus experiment describing its intended
  rollout path was checked.

---

## 12. Why Tor is still used

This is the synthesis section, and it is a judgement, not a source citation.
Everything it leans on is above.

The question is a fair one. A modern Firefox already does encrypted DNS,
TLS 1.3, Encrypted Client Hello, HTTPS-First, cookie-jar partitioning for
every site, a shipped tracker blocklist in strict mode, and a private window
that throws the whole jar away. A VPN moves the connection to somebody else's
address. What is left for Tor to do?

**The answer is that every one of those defences is aimed at a different
adversary than the one Tor is aimed at, and the two sets do not overlap
anywhere.**

There are four adversaries worth naming separately, because a protection
against one buys nothing against the others:

| Adversary | What they see | What actually helps |
|---|---|---|
| The site, later | Cookies, storage, cache, fingerprint | Clearing (§1), partitioning (§9), RFP (§10) |
| Third parties on the page | Cross-site identifiers | dFPI/TCP (§9), ETP blocklists (§8) |
| Whoever carries your packets | Every site you visit, when, and how much | Only Tor |
| The site, about who you are | Your IP address | Tor, or a VPN, with caveats |

Rows one and two are what this browser's own settings address. Rows three and
four are what Tor addresses. Nothing in rows one and two moves rows three and
four at all, and it is the confusion between them that makes people think
encrypted DNS is a privacy feature in the sense they mean.

### The network row is not closed by encryption, and the numbers are not close

§2 has the measurements. Recapitulated because this is the load-bearing point:

- The destination IP is in the clear no matter what. **68%** of IPs in the
  Alexa 1M map to exactly one site; the union of IPs a page loads is unique
  for **95.7%** of sites.
- Traffic analysis recovers the domain from an encrypted flow at **F1 > 0.8
  for about 80% of domains** (Trevisan et al., 2022), and the authors say in
  as many words that DoH and ECH "could give users a false sense of
  protection".
- Website-fingerprinting attacks reach **>98%** closed-world accuracy against
  *undefended Tor* (Sirinam et al., 2018). Tor pads to fixed-size cells;
  ordinary TLS pads nothing. Whatever works through Tor works better without
  it.

So the honest statement is not "ECH mostly hides the site". It is: **the
protocol stack hides the name and leaves the identity**. A shared CDN address
is what actually hides a site, and that is a property of the site's hosting
choice, not of the browser.

### A VPN moves the observer; it does not remove one

A VPN replaces "your ISP sees every site" with "your VPN provider sees every
site". That is a real change when the ISP is the adversary — a hostile
network, a country with retention law, a landlord's router — and it is worth
having for that. It is not a reduction in *how much* is observable; it is a
change in *who* observes it. The provider is a single party that can log,
can be compelled, and has a commercial incentive to say it does not log
without a way for anyone to check.

Tor's difference is structural rather than a matter of degree, and it comes
down to one property: **no single relay knows both who you are and where you
are going.** The entry guard knows your address and not the destination; the
exit knows the destination and not your address. That is not a stronger
promise from a better-behaved company. It is an arrangement in which there is
no party to make the promise. Traffic analysis by someone who watches both
ends still defeats it, and Tor's own design documents say so — the threat
model is explicitly not a global passive adversary.

### A private window is about the person next to you

`PrivateBrowsingUtils` gives a separate cookie jar that is discarded when the
last private window closes. Against someone who later uses the same computer,
that works. Against the site, the network, or a tracker, a private window
changes almost nothing: the same IP, the same TLS fingerprint, largely the
same browser fingerprint (though FPP *is* on by default in private windows,
per §10 — a real difference, and a narrow one).

The gap between what "private browsing" sounds like and what it is remains
the single most common misunderstanding in browser privacy. Our own UI must
not add a second one.

### What this means for tela-zen's Tor integration, concretely

1. **Tor is the only feature in this browser that addresses a network
   adversary.** Site-data lifetimes, clearing, partitioning, ETP and
   fingerprinting resistance all address the site and its third parties.
   Copy anywhere in the product must keep those two columns apart.
2. **Routing a space through Tor and calling it private is not enough.** The
   fingerprinting surface (§10) and the extension surface (§11) are the same
   in a Tor space as anywhere else unless something changes them, and this
   browser is not the Tor Browser: it does not ship Tor Browser's patched
   Gecko, its uniform window sizing, or its user population. A tela-zen Tor
   space hides the network path and leaves an unusually identifiable browser
   at the end of it. That is a real, useful, partial protection and it must
   be described as exactly that.
3. **The anonymity-set argument (§10) cuts against us specifically.** Tor
   Browser's users look like each other. tela-zen's Tor users look like
   tela-zen users, of whom there are very few. Turning on RFP inside a Tor
   space narrows the set to "tela-zen users with RFP on", which may be worse
   than not being fingerprint-resistant at all in a large population. This is
   contested and not measurable from here; it is recorded rather than acted
   on.

### Open question

The honest gap in this section: nobody has measured how much a
non-Tor-Browser browser over Tor actually loses relative to Tor Browser. The
Tor Project's position is that you should use Tor Browser and nothing else,
which is the safe advice and also conveniently unfalsifiable. We have not
found a study that quantifies the delta.

---

## 13. What tela-zen's site-data lifetimes actually deliver

Implemented in `src/zen/privacy/ZenSiteDataLifetime.sys.mjs`, exposed by the
Privacy pane. Recorded here because "what a clear leaves" is the whole point
of section 1, and a feature that clears things must be held to it.

### The three lifetimes, and how each is enforced

None of the enforcement is ours except the third. That is deliberate — the
sanitizer is the thing that already handles containers, exceptions and the
shutdown blocker correctly.

| Lifetime | Stored as | Enforced by |
|---|---|---|
| `keep` | `persist-data-on-shutdown=ALLOW` | `Sanitizer.sys.mjs`, `isShutdownExceptionApplicable()` |
| `session` | `cookie=ACCESS_SESSION` | `sanitizeOnShutdown()`'s session-permission branch |
| `tab` | the above plus `zen-clear-on-tab-close=ALLOW` | ours, on last-tab-close |

Two source facts make this work and are worth writing down because they are
not obvious:

- `CookieCommons.cpp:259` — an `ACCESS_SESSION` cookie permission sets
  `isSession` on the cookie, so those cookies never reach `cookies.sqlite` at
  all. Nothing has to clear them.
- `Sanitizer.sys.mjs` runs its `cookie=ACCESS_SESSION` branch **only inside
  `if (!Sanitizer.shouldSanitizeOnShutdown)`**. That reads like a bug and is
  not: when clear-on-shutdown *is* on, `cookiesAndStorage` clears everything
  by principal anyway, honouring the same exceptions. Both paths are covered,
  by different code.

### Verified, per storage type

Measured against a probe page on separate loopback sites (each of
`127.0.0.0/8` is a distinct site and a secure context, so service workers and
OPFS are available), writing one of every clearable storage type and reading
each back individually afterwards:

| | cookie | localStorage | IndexedDB | Cache API | service worker | OPFS |
|---|---|---|---|---|---|---|
| `tab`, last tab closed | gone | gone | gone | gone | gone | gone |
| `tab`, navigated away | gone | gone | gone | gone | gone | gone |
| `tab`, one of two tabs closed | kept | kept | kept | kept | kept | kept |
| `session`, clean shutdown | gone | gone | gone | gone | gone | gone |
| `session`, SIGKILL then restart | gone | gone | gone | gone | gone | gone |
| `keep`, alongside all of the above | kept | kept | kept | kept | kept | kept |

Also verified: rules survive a restart (they are permissions, in
`permissions.sqlite`); a clear reaches every container, but a tab open in
*any* container keeps the site alive; private windows are neither attached nor
counted, so a private tab neither triggers a clear nor prevents one.

### The crash gap, and what closes it

Cookies for a `session` site never touch the disk, but its localStorage,
IndexedDB and caches do, and it is the sanitizer at a *clean* shutdown that
removes them. A crash skips that entirely.

Firefox covers its own shutdown clear with `privacy.sanitize.pending`,
replayed on the next startup (`Sanitizer.onStartup`). The
`cookie=ACCESS_SESSION` branch it runs when clear-on-shutdown is off has **no
such record**. `zen.privacy.site-data.clean-shutdown` is that record: written
false at startup, true at `quit-application-granted`, and a false reading on
the next start clears every site holding a `session` or `tab` rule. Verified
above by SIGKILL.

### What it does not do, and will not

- **Automatic clears deliberately pass `isUserRequest = false`.**
  `AuthTokensCleaner` and `AuthCacheCleaner` have no per-site implementation
  and answer a user request by calling `deleteAll()` —
  `sdr.logoutAndTeardown()` and a `net:clear-active-logins` notification —
  which would log every *other* site out on every tab close. With the flag
  off they no-op. The cost is that a site's HTTP auth cache and NSS auth
  tokens are not cleared; that is the honest trade, and it matches §1's
  finding that those have no per-site path in the first place. The pane's
  per-site **Clear now** button (`forgetSite()`) passes `false` for the same
  reason, unlike Firefox's own Forget About This Site: a per-site button in
  this browser is not allowed to have a global effect.
- **DNS cache, Alt-Svc cache, OCSP cache, HTTP auth cache: not cleared.** §1.
  The pane says so in as many words.
- **The shutdown cache row ignores keep exceptions.** `Sanitizer.items.cache`
  clears globally, unlike `cookiesAndStorage`, which clears by principal. A
  kept site loses its cache at a shutdown clear. A cache can be refetched, so
  this is stated rather than worked around.
- **No network-level claim of any kind.** §12.

### The presets hook

`exportPosture()` / `applyPosture()` return and consume a versioned,
serialisable object — `{version, siteDataDefault, clearCaches, rules}` — so a
layout preset can carry a privacy posture the same way it carries
`LIVE_PREFS`. The hook point is `ZenLayoutPresetData.configOf()` /
`saveToSlot()` in `src/zen/compact-mode/ZenLayoutPresetData.mjs`: a preset's
config would gain a `privacy` key holding `exportPosture()`'s output, and
whatever applies a preset would call `applyPosture()` with it. Not wired —
that file belongs to the presets work and this is the shape it would take.

---

## 14. The agent control channel: why not Marionette, why a Unix socket

Recorded because the next person to look at this will see Marionette sitting
right there, already working, and reach for it.

### A channel whose primitive is arbitrary script evaluation cannot be scoped

Marionette is already in this tree and `scripts/regress.py` drives chrome
context through it every run. It is the wrong thing to leave on while
browsing, and not because of any fixable gap in it. Its useful verb is
`Marionette:ExecuteScript` in chrome context: **one verb that does
everything, in the parent process.** Any permission model layered on top of
that is unenforceable, because the holder simply evaluates around it. There
is no version of "refuse this origin" or "this session is read-only" that
survives an `eval` primitive. Marionette also has no per-action consent, no
audit trail and no origin scoping, and the port is first-come-first-served.

That is a structural argument, not a preference. It is the reason
`ZenAgentChannel` exists rather than a thin wrapper over the existing port.

### Unreachable from page content is structural on AF_UNIX, and a filter on TCP

`nsIServerSocket.initWithFilename(nsIFile, permissions, backlog)` is
scriptable and in-tree; the IDL's own comment names the profile directory as
the intended per-user rendezvous point. The channel binds there at mode
`0600`.

The reason this matters more than the file permissions: **page JavaScript can
reach `http://127.0.0.1:<port>`, and there is no URL scheme that addresses an
AF_UNIX path at all.** `fetch`, XHR, WebSocket and WebTransport all resolve
through necko's web-exposed protocol handlers, none of which map to a Unix
domain socket. So "content cannot speak to the agent channel" is a property
of the address family, not a filter that has to keep holding. A page that can
reach the agent channel is a full compromise, so the difference between a
guarantee and a mitigation is the whole question.

The counter-example is in this repo's own history: `/mnt/storage/dev/projects/tela-mcp`,
an abandoned prototype, used a localhost WebSocket on port 8765 and defended
it with an `Origin`-header allowlist plus a shared token. Its own source
comments worry about exactly this hazard. Anything reachable at a loopback
port is reachable from every page the browser renders.

### What the token is, and is not

The token in `<profile>/zen-agent.token` is written `0600` and rotated per
session. It is a **courtesy boundary, not a security one**: any process
running as this user can read it, exactly as it can connect to the socket. It
stops an unrelated program driving the browser by accident and lets the handle
be rotated without a restart. It does not defend against a compromised
same-user process, and the UI must never imply that it does.

### What the kill switch actually guarantees

`ZenAgentChannel.revoke()` bumps a generation counter, stops in-flight loads
via `browser.stop()`, releases agent tabs, de-authenticates every session,
closes the listener and deletes the socket and token. Every async
continuation re-checks the generation it began under, so a result arriving
after a revoke is dropped rather than delivered.

It stops the load and revokes the handle. **It cannot unsend bytes already on
the wire**, and the honesty rule from the Tor work says the UI may not claim
otherwise.
