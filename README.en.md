# DSH × HALOFLUX — Live Session-Driven Desktop Wallpaper

[中文](README.md) | **English**

Wires [HALOFLUX](https://github.com/Ryder191/haloflux) — a single-file Canvas sci-fi visualizer —
to **DeepSeek Harness**'s real local session data. The ring's rotation speed, beam bursts and every
number on screen are driven by actual events: idle when you are away, bursting when tools run.

The local music player (QQ Music / Spotify…) and the **ChatGPT desktop app** state are wired into the
same frame, then the whole page is mounted as a **Lively Wallpaper** desktop wallpaper.

> ⚠️ HALOFLUX is licensed under **PolyForm Noncommercial** — **personal, non-commercial use only**.
> Details in [NOTICE.md](NOTICE.md). The on-screen credit is hidden by default; set `SHOW_CREDIT = true` in `bridge.js` to show it again.

![Live while tools run](docs/screenshots/demo.gif)

## Features

- **Driven by real data** — event rate → ring speed; every tool call → a real beam burst; errors → denser flashes
- **Idle standby** — after ~4 s without events the timeline drops to 10% speed instead of spinning forever
- **Human-readable panels** — current task / progress / tool calls / session desk / today's best / ChatGPT / event rate / tool mix
- **Usage & cost** — today's tokens, spend, balance, cache hit rate, peak/off-peak countdown (from the `dsh-cost-meter` ledger)
- **Local music** — read and control the system media session; the player panel is collapsible
- **Chinese UI** — MiSans for Chinese, JetBrains Mono for Latin/digits
- **Wallpaper-ready** — Lively / Wallpaper Engine project with auto-reconnect when the service restarts

![Panels](docs/screenshots/panels.png)

![Ring data band](docs/screenshots/ring.png)

![Local player](docs/screenshots/player.png)


## Typography

One stack everywhere: **JetBrains Mono (digits/Latin) → MiSans → HarmonyOS Sans SC → Microsoft YaHei**.

| Tier | Usage | Size | Weight | Color |
|---|---|---|---|---|
| Display | current-task verb, progress headline | 16px | 800 | `#ffffff` |
| Panel title | panel headers | 10px (mini 8.5px) | 800 | `#e8eaee` / `#9aa0aa` |
| Body | list rows, descriptions | 9.5px | 400 | `#b9bec7` |
| Emphasis | verbs, key values | 9.5px | 700 | `#ffffff` |
| Muted | timestamps, units, hints | 9.5px | 400 | `#8d939c` |
| Chart labels | tool distribution, ring cards | 9.5px | 700 | `#e8eaee` |
| Numerals | event rate, counters | 9.5–11px mono | 700 | `#ffffff` |
| Ring | data cards on the band (band-limited) | 9px / 6px | 800 / 500 | white 100% / 90% |

Rule: one size and weight per tier; verbs and values always bold+white; secondary info always muted.

All text (chart labels, counters, event-rate value) is rendered as **DOM**; canvas only draws the bars/heat graphics, so fonts can never drift between the panels and the charts.

## Quick start

```powershell
# 1. Node.js 20+ (the only runtime dependency; the server has zero npm packages)
winget install OpenJS.NodeJS.LTS

# 2. Unpack this project and run the installer (writes autostart + starts the server)
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-hud\install.ps1

# 3. Install Lively Wallpaper
winget install --id rocksdanister.LivelyWallpaper

# 4. Lively -> Add wallpaper -> URL -> http://127.0.0.1:7788/wall
```

Full prerequisites and troubleshooting: [INSTALL.md](INSTALL.md).

## Layout

| Path | Purpose |
|---|---|
| `dsh-hud/server.mjs` | Data service: incremental session decoding, SSE, media/external-AI/usage proxies |
| `dsh-hud/bridge.js` | Bridge injected into HALOFLUX: live linking, panels, localization, wallpaper mode |
| `dsh-hud/fix-wallpaper-screen.ps1` | Picks the right screen automatically (iPad/spacedesk first, else primary) |
| `dsh-hud/media.ps1` | System media session (prev/play/next) |
| `dsh-hud/external.ps1` | ChatGPT desktop state via UI Automation |
| `dsh-hud/wall-proj/` | Lively / Wallpaper Engine wallpaper project |
| `dsh-hud/install.ps1` | One-shot installer (autostart + start) |
| `haloflux/` | Original HALOFLUX visuals (untouched; the bridge is injected at runtime) |

## Architecture

```
~/.dsh/sessions/<workspace>/session-*.jsonl.zstd
        │ decoded incrementally every 500 ms (multi-frame zstd)
        ▼
dsh-hud/server.mjs  (127.0.0.1:7788)
        │ SSE /stream · JSON /state /usage /media /external
        ▼
haloflux/lab.html + runtime-injected bridge.js
        │ setParam() / onBeat() drive internal params
        ▼
Lively Wallpaper (WebView2) → desktop wallpaper
```

## Performance (measured on this machine, 3840×2160 / i9-14900KF)

| Scenario | CPU | RAM |
|---|---|---|
| Data service | ≈0.3% of one core | 60–110 MB |
| Wallpaper · idle | ≈4% of one core | ≈1.0–1.2 GB |
| Wallpaper · working | ≈30–41% of one core | ≈1.2–1.3 GB |

> Most of the RAM is the Lively/WebView2 baseline (any web wallpaper costs roughly the same).
> Tune `devicePixelRatio`, frame budget and `LOAD` in `bridge.js` to lower it further.

## License

- Visuals: HALOFLUX by Ryder191 — PolyForm Noncommercial (**no commercial use**)
- Integration scripts: MIT (see `LICENSE-MIT`); redistribution must stay non-commercial and keep attribution
