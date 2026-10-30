# Spike: embedding arti in libxul

Report only — nothing implemented. The question was whether to embed
[arti](https://gitlab.torproject.org/tpo/core/arti), the Tor Project's Rust
implementation, instead of driving the system `tor` binary as a subprocess.

**Recommendation: not now.** Keep the current approach. Revisit if
`arti-client` reaches 1.0, or if we ever need to ship to machines without tor
installed.

## Facts, as of 2026-09-02 (crates.io)

| Crate | Version | What it is |
|---|---|---|
| `arti` | **2.6.0** | the CLI/daemon binary |
| `arti-client` | **0.46.0** | the embeddable library — this is what we would link |
| `tor-hsclient` | 0.46.0 | onion service *client* support |
| `arti-rpc-client-core` | 0.46.0 | RPC interface, the rough equivalent of a control port |

`arti-client` pulls **44 required direct dependencies**, 29 of them `tor-*`
crates, before transitive closure. Development is clearly active — every crate
above released on the same day.

Note the version split: the **binary** is 2.6.0 but the **library** is 0.46.0.
The thing we would depend on is the pre-1.0 one, and its API is still moving.

## What we would gain

- **No external binary.** Today we require `/usr/bin/tor` to exist. On a machine
  without it, routing is simply unavailable.
- **No subprocess lifecycle.** The current implementation spawns tor, writes a
  torrc, reads a control-port file, authenticates with a cookie, and has to shut
  it down cleanly — with a known wrinkle that on `SIGTERM` tor lingers ~40s
  until `__OwningControllerProcess` notices we vanished.
- **Tighter integration.** Circuit information would come from an in-process API
  rather than by parsing `GETINFO` responses over a socket.

## What it would cost

- **A very large dependency tree inside libxul.** 44 direct crates, hundreds
  transitively. Firefox vendors and audits its Rust dependencies; adding this
  is a substantial supply-chain review, not a `Cargo.toml` line.
- **Build cost.** Touching the Rust side means a full engine rebuild, not the
  10-second `build:ui` the chrome work uses. That changes the whole iteration
  loop for anyone working on Tor features.
- **Binary size**, which we have not measured and which matters for a browser.
- **Pre-1.0 API churn.** `arti-client` at 0.46 will keep moving; each bump is a
  rebuild-and-revalidate cycle against a moving Firefox base we are already
  rebasing onto.

## Why the current approach is not the weak option

Everything the panel needs already works through the system binary, verified
against a live control port: circuit hops with nicknames and countries,
`SIGNAL NEWNYM`, `ONEHOP_TUNNEL` filtering, onion services, and per-stream
attribution. We run *our own instance* with our own torrc under the profile —
`SocksPort auto`, `ControlPort auto`, cookie auth — so we control the
configuration completely. It is the distro's binary, not a bundled one, which
was the distinction the user drew when they said not to bundle tor.

The single functional gap is "tor is not installed", and that is better solved
by detecting it and saying so than by absorbing hundreds of crates into libxul.

## What would change the answer

1. `arti-client` reaching **1.0** with a stable API.
2. Needing to ship where tor is not installable — a Windows or macOS build, or
   a distribution channel that cannot depend on a system package.
3. Wanting features the control port cannot express, where the in-process API
   genuinely does better.

Until one of those, the subprocess is the cheaper correct answer.
