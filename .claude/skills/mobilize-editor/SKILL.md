---
name: mobilize-editor
description: Set up, verify, repair and personalize handide, the mobile layer that serves the user's real VS Code to a phone browser without forking it. Use when installing handide, after VS Code updates (to re-verify and fix the layer), when `npm run check` fails, when the user wants to change their mobile layout (tabs, accessory keys, breakpoint), or when choosing how the companion extension is installed.
---

# mobilize-editor

handide = the installed VS Code (untouched) → `code serve-web` → `proxy/server.mjs` (injects `layer/`) → phone browser.

What each piece owns (keep it that way):

| Piece | Owns | Survives editor updates because |
|---|---|---|
| `profile/settings.json` | everything a VS Code setting can do (hidden activity/status bar, word wrap, `workbench.editor.useModal: off`, autosave) | settings are public API |
| `extension/` (companion) | one full-screen area per tab via **official command IDs**; moves Explorer/Search/SCM into the maximizable panel | commands are API, but a few layout ones are internal (see `compat.mjs`) |
| `layer/commands.json` | chord ↔ command mapping; proxy generates the extension keybindings from it | single source of truth |
| `layer/selectors.json` | **every** VS Code internal DOM hook the layer or the check uses | the one file to fix after an update |
| `layer/mobile.css`, `layer/mobile.js` | bottom tabs, accessory keys, viewport shim, input sheet, theme sync, dialog fixes | depend on DOM only through `selectors.json` + rules marked `[vscode-dom]` |
| `layer.config.json` | the user's personal layout (tabs, keys, breakpoint, companion mode) | user data |

Hard rules:
- Verify on real Android (`--android`) after changes to input, keys, viewport or tab logic; emulation has no soft keyboard.
- Never modify the VS Code installation, `~/.vscode`, or the user's desktop VS Code settings. handide state lives in `.handide-data/` (created by the proxy).
- New DOM dependencies go into `layer/selectors.json`, never hard-coded elsewhere.
- Prefer, in order: a VS Code setting (`profile/settings.json`) → an official command (`layer/commands.json` / `extension/`) → CSS/JS on DOM.
- Do not report success without a passing `npm run check`.

Scripts (all in `scripts/`, run from the repo root):

| Command | Does |
|---|---|
| `npm run compat [-- --editor <cli>]` | static install check → JSON verdict; exit 0 compatible, 2 uncertain, 3 incompatible |
| `npm run check [-- --devices "Pixel 7,iPhone 14"] [-- --mode builtin]` | starts a **private** proxy (fresh data dir + sample workspace under `check-output/`), runs 15 checks per emulated device, writes `check-output/report.json` + screenshots per step |
| `npm run check -- --android [serial]` | same 15 checks in **real Chrome** on an emulator or USB phone: real touches (`adb input tap`), real soft keyboard. Catches what emulation cannot (keyboard resizing, terminal focus, input handling). Needs `adb`; sets `adb reverse` itself |
| `node .claude/skills/mobilize-editor/scripts/inspect.mjs [--tab files] [--find "text"] [--eval "js"]` | phone-viewport DOM inspector for repairing selectors |

## Workflow A — install / first setup

1. `npm install` (Playwright is a dev dependency; if its browser is missing: `npx playwright install chromium`).
2. `npm run compat`. Read the JSON.
   - `editor.cli` null → the user needs VS Code (Cursor/Windsurf cannot serve a web UI). Explain `editor.note`, stop.
   - `verdict: compatible` → keep `companion.mode: "extension"`.
   - `verdict: uncertain | incompatible` → ask the user with AskUserQuestion, using `choices` from the JSON verbatim (labels are Korean on purpose), explaining `reasons`. Then set `layer.config.json` → `companion.mode` to the chosen id (`extension` | `builtin`), or stop on `skip`.
3. `npm run check -- --mode <chosen mode>`. Must pass (see Workflow B on failure).
4. Start for the phone: `npm start -- --folder <project>`. By default it listens on the LAN over HTTPS with a self-signed certificate (`proxy/tls.mjs`, kept in `.handide-data/tls`, regenerated when the PC's addresses change) and prints a **QR code + link** carrying the token; `http://` on the same port redirects to `https://`. Tell the user: scan the QR code, accept the certificate warning once (Android Chrome: Advanced → Proceed; Safari: Show Details → visit this website).
   Why not plain http: VS Code's connection handshake needs Web Crypto, only available in a secure context (HTTPS or localhost); `http://<LAN-IP>` loads but never connects.
   Other setups: `--local` (this PC only) + `tailscale serve --bg 9000` for a valid certificate from anywhere; `--local` + `adb reverse` for Android over USB; `--cert/--key` for their own certificate.
   The `?tkn=` token is the only auth; never expose the port on a public network.
5. Tell the user the one manual step: on first open, VS Code asks to trust the folder. Until they tap Trust, the companion extension (and Claude Code / Copilot) stays disabled; the layer shows a notice with a "신뢰 설정" button.

## Workflow B — VS Code updated, or `npm run check` fails

1. `npm run compat` and `npm run check`. Open `check-output/report.json`; look at the screenshot named after each failing step in `check-output/<device>/`.
2. Map the failure to its fix:

| Failing check | Likely cause | Fix |
|---|---|---|
| `layer-injected` | proxy/serve-web problem, or the workbench HTML changed | run `npm start` manually, read its output; check `injectLayer()` in `proxy/server.mjs` still finds `</head>` / `</html>` and `vscode-workbench-web-configuration` |
| `selectors` | internal class renamed | `inspect.mjs` (and `--find`) to find the new name → edit `layer/selectors.json` |
| `trust` | trust UI changed | `inspect.mjs --find "Restricted Mode" --find "Trust"` → update `scripts/lib/trust.mjs` and `banner` in `selectors.json` |
| `tab:*` (extension mode) | a layout command ID changed, the extension did not load, view IDs changed, or `settleTab()` in `mobile.js` (which maximizes the panel based on the DOM) needs adjusting | `inspect.mjs --tab <tab>`; check the command IDs in `extension/extension.js` still exist (the Keyboard Shortcuts editor lists every command ID; "Developer: Show Running Extensions" shows whether the companion is active); fix `PANEL_HOMES` / `showTab`. If unfixable now, offer `builtin` mode (Workflow A step 2 choices). |
| `tab:*` (builtin mode) | default shortcut changed | update `BUILTIN_TABS` in `layer/mobile.js` |
| `bars-layout` | VS Code stopped sizing from `window.innerHeight` / `visualViewport.height` | adjust `installViewportShim()` in `layer/mobile.js` |
| `theme-sync` | theme variables moved | `inspect.mjs --eval "getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-foreground')"`; update `THEME_VARS` / `syncTheme()` |
| `edit-korean` | text insertion path changed | the report shows `last paste: <element> <method>`. `pasteInto()` in `mobile.js` inserts via EditContext `textupdate` when the editor has one (a synthetic paste is accepted but ignored on Android Chrome), else via a paste event. Check `textInputs` in `selectors.json` |
| `accessory-keys` | synthetic keys ignored | check `sendKey()` (keyCode/code), `check.cursor` selector |
| `palette-fits` | quick input overflows | CSS in `mobile.css` for `quickInput` |
| `no-layer-errors` | JS exception in the layer | message is in the report |

3. Re-run `npm run check` (both modes if the change touched shared code) until it passes.
4. Update `layer/selectors.json` → `testedWith.version` to the editor version from the report, so `compat` stops reporting "untested".
5. Summarize for the user: what broke, what changed, the check result.

## Workflow C — personalize

Edit `layer.config.json` (served live; a page reload applies it, no restart):

- `tabs`: any order/subset of `code, files, search, git, terminal, chat`.
- `accessoryKeys`: any of `esc tab left up down right home end ctrl alt shift undo redo save find quickOpen palette input` (`input` = the Korean-safe input sheet, `ctrl/alt/shift` are sticky).
- `breakpoint`: width (px) below which the mobile layout activates (touch devices always get it).
- `companion.mode`: `extension` | `builtin`.

Adding a new action key means: an entry in `layer/commands.json` → `actions` (official command ID), a `KEY_DEFS` entry in `layer/mobile.js`, and `BUILTIN_ACTIONS` for builtin mode. Then `npm run check`.

Mobile-only VS Code settings go in `profile/settings.json`; on the next start the proxy adds new keys to the user's existing handide settings without overwriting their values (`--reset-profile` to overwrite).

## Workflow D — share

The shareable unit is this repo (layer + extension + profile + this skill). Someone else clones it, opens Claude Code in it, and asks to set up handide → Workflow A adapts to their editor version. Their `layer.config.json` is their personalization; changes to `selectors.json` after a VS Code update are worth sending back upstream so everyone's layer stays current.
