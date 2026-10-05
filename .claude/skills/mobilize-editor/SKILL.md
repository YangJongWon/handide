---
name: mobilize-editor
description: Set up, verify, repair and personalize handide, the `handide` command that serves the user's real VS Code to a phone as a mobile IDE (full-screen editor, floating menu button, file drawer, terminal drawer, full-screen AI) without forking it. Use when installing handide, after VS Code updates (to re-verify and fix the layer), when `npm run check` fails, when the user wants to change their mobile layout (menu, accessory keys, breakpoint), or when choosing how the companion extension is installed.
---

# mobilize-editor

`handide [folder]` (like `code .`) = the installed VS Code (untouched) → `code serve-web` on 127.0.0.1 → `proxy/server.mjs` (LAN HTTPS + QR, injects `layer/`, command bridge) → phone browser.

What each piece owns (keep it that way):

| Piece | Owns | Survives editor updates because |
|---|---|---|
| `profile/settings.json` | everything a VS Code setting can do (no activity/status bar, no editor tabs/title actions, no floating parts (`workbench.experimental.modernUI: false`), word wrap, `workbench.editor.useModal: off`, autosave, `terminal.integrated.commandsToSkipShell`) | settings are public API |
| `extension/` (companion) | `handide.view` (editor / terminalDock / terminal / ai / search / git) from **official, idempotent commands**; `handide.state`; the bridge client; moves Search/SCM into the maximizable panel | commands are API, but a few layout ones are internal (see `compat.mjs`) |
| `proxy/bridge.mjs` | command bridge: layer → proxy → extension (long-poll on a private 127.0.0.1 port + secret), and `/__handide/fs` directory listing for the drawer | own code |
| `layer/commands.json` | chord ↔ command mapping (fallback when the bridge is down); proxy generates the extension keybindings from it | single source of truth |
| `layer/selectors.json` | **every** VS Code internal DOM hook the layer or the check uses | the one file to fix after an update |
| `layer/mobile.js`, `layer/mobile.css` | the shell: floating button + menu sheet, file drawer + folder picker, terminal (bottom) and AI (right) drawers with a bar laid over the part's title strip, `syncViewFromLayout()` (closes whatever VS Code opens by itself), accessory keys (only while the soft keyboard is up), input sheet, viewport shim, theme sync, `settleView()` (finishes layouts from the DOM) | depend on DOM only through `selectors.json` + rules marked `[vscode-dom]` |
| `~/.handide/` (`$HANDIDE_HOME`) | per-user: mobile VS Code profile (`data/Machine/settings.json`), installed companion, `tls/` certificate, `token`, `layer.config.json` | user data |

Hard rules:
- Never modify the VS Code installation, `~/.vscode`, or the user's desktop VS Code settings. handide state lives in `~/.handide` (an older `<repo>/.handide-data` is reused if it exists).
- New DOM dependencies go into `layer/selectors.json`, never hard-coded elsewhere.
- Prefer, in order: a VS Code setting (`profile/settings.json`) → an official command (bridge / `extension/`) → CSS/JS on DOM.
- Verify on real Android (`--android`) after changes to input, keys, gestures, viewport or view logic; emulation has no soft keyboard.
- Do not report success without a passing `npm run check`.

Scripts (all in `scripts/`, run from the repo root):

| Command | Does |
|---|---|
| `npm run compat [-- --editor <cli>]` | static install check → JSON verdict; exit 0 compatible, 2 uncertain, 3 incompatible |
| `npm run check [-- --devices "Pixel 7,iPhone 14"] [-- --mode builtin]` | starts a **private** handide (`--local`, fresh data dir + sample workspace under `check-output/`), runs 23 checks per emulated device through the UI (taps, CDP swipes), writes `check-output/report.json` + a screenshot per step |
| `npm run check -- --android [serial]` | same checks in **real Chrome** on an emulator or USB phone: `adb input tap/swipe`, real soft keyboard; sets `adb reverse` itself |
| `node .claude/skills/mobilize-editor/scripts/inspect.mjs [--tab <view>] [--find "text"] [--eval "js"]` | phone-viewport DOM inspector for repairing selectors |

## Workflow A — install / first setup

1. Install: `npm install -g github:YangJongWon/handide`, or from this repo `npm install && npm link`. For the checks, Playwright's browser: `npx playwright install chromium` if missing.
2. `npm run compat`. Read the JSON.
   - `editor.cli` null → the user needs VS Code (Cursor/Windsurf cannot serve a web UI). Explain `editor.note`, stop.
   - `verdict: compatible` → keep `companion.mode: "extension"`.
   - `verdict: uncertain | incompatible` → ask the user with AskUserQuestion, using `choices` from the JSON verbatim (labels are Korean on purpose), explaining `reasons`. Then set `companion.mode` in `~/.handide/layer.config.json` to the chosen id (`extension` | `builtin`), or stop on `skip`.
3. `npm run check -- --mode <chosen mode>`. Must pass (see Workflow B on failure).
4. Tell the user to run `handide` in the folder they want (or `handide <folder>`). It listens on the LAN over HTTPS with a self-signed certificate (`proxy/tls.mjs`, regenerated when the PC's addresses change) and prints a **QR code + link** carrying the token (kept in `~/.handide/token`; `--new-token` replaces it); `http://` on the same port redirects to `https://`. `http://localhost:9000/__handide/connect` on the PC shows the QR code large (answers only the PC itself).
   First visit: accept the certificate warning once (Android Chrome: Advanced → Proceed; Safari: Show Details → visit this website), then **Trust** the folder — until then VS Code keeps the companion (views, file opening, bridge) and agent extensions off; the layer shows a notice with a "신뢰 설정" button.
   Why not plain http: VS Code's connection handshake needs Web Crypto, only available in a secure context. Away from home (`--no-remote` to skip; the checks always pass it):
   - Default: when Tailscale is signed in, handide runs `tailscale funnel --bg --https=443 <its port>` (`proxy/tailscale.mjs`): public fixed `https://<machine>.<tailnet>.ts.net`, nothing on the phone, guarded by the token. If Funnel is not allowed it falls back to `tailscale serve` (tailnet only). `--private` always uses serve. Both are removed on exit.
   - `--cloudflare` (`proxy/cloudflare.mjs`): Quick Tunnel, cloudflared from PATH/Program Files or downloaded into `<home>/bin`. It runs with its own HOME (`<home>/cloudflared-home`) because an existing `~/.cloudflared` makes the edge answer 404; the link is printed only after the new hostname answers (DNS takes ~5 s).
   - `handide remote [--private]`: one-time guided setup (install via winget/brew/install.sh, sign-in and the Funnel/HTTPS approval each open the browser; reruns skip finished steps and never touch an existing config on 443).
   - Funnel, serve and cloudflared all keep the original Host header and set X-Forwarded-Proto, so the proxy's host rewriting needs nothing extra. The connect page stays PC-only (Host must be localhost), and the bridge needs the token cookie. Other setups: `--local` + `adb reverse` (Android over USB), `--cert/--key`.

## Workflow B — VS Code updated, or `npm run check` fails

1. `npm run compat` and `npm run check`. Open `check-output/report.json`; look at the screenshot named after each failing step in `check-output/<device>/`. Note that `serve-web` may have downloaded a newer web server than the desktop VS Code.
2. Map the failure to its fix:

| Failing check | Likely cause | Fix |
|---|---|---|
| `layer-injected` | proxy/serve-web problem, or the workbench HTML changed | run `handide --local` manually, read its output; check `injectLayer()` in `proxy/server.mjs` still finds `</head>` / `</html>` and `vscode-workbench-web-configuration` |
| `selectors` | internal class renamed | `inspect.mjs` (and `--find`) → edit `layer/selectors.json` |
| `restricted-layout` | before trust (companion off) the primary/secondary side bar stayed next to the editor: a default toggle shortcut changed, or the layer stopped watching | `CLOSE_PART_KEYS` / `syncViewFromLayout()` in `mobile.js` (VS Code on iPhone uses Mac bindings) |
| `trust` | trust UI changed | `inspect.mjs --find "Restricted Mode" --find "Trust"` → update `scripts/lib/trust.mjs` and `banner` in `selectors.json` |
| `view:*` (extension mode) | a layout command ID changed, the companion or bridge did not start, or `settleView()` misreads the layout | `inspect.mjs --tab <view>`; check `/__handide/bridge/status` in the page (`connected`), the command IDs in `extension/extension.js` (Keyboard Shortcuts editor lists them), `VIEW_PARTS` / `settleView()` in `mobile.js`. If unfixable now, offer `builtin` mode |
| `view:*` (builtin mode) | a default shortcut changed | update `BUILTIN_VIEWS` in `layer/mobile.js` |
| `drawer` | bridge down, `vscode.open` changed, or `pageFolder()` can't read the folder | bridge status; `handide.state`; the workbench configuration's `folderUri` |
| `swipe` | gestures broken, or VS Code's gesture handler swallowing taps again | `installGestures()` / `onTap()` in `mobile.js` |
| `view:*` passes but the ← / ⌄ bar is missing or misplaced | a part's title strip was renamed | `partTitles` in `selectors.json`, `placeViewbar()` |
| `bars-layout` | VS Code stopped sizing from `window.innerHeight` / `visualViewport.height`, the body offset changed, or the floating button left the screen | `installViewportShim()` / `relayout()` / `fabBand()` in `mobile.js`, `body { padding-top }` in `mobile.css` |
| `theme-sync` | theme variables moved | `inspect.mjs --eval "getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-foreground')"`; update `THEME_VARS` |
| `agents` | the AI bar's extension list lacks Chat, a primary side bar extension did not show in the secondary side bar, or picking Chat did not show it | `extensionViews()` / `borrowViews()` / `showView` in `extension/extension.js` (`vscode.moveViews` into the `handide-ext` container); `partTitleLabels` / `partTitleActions` in `selectors.json` (the side bar title moved) |
| `extensions-manager` | "확장 관리" listed nothing, or an extension's details page did not open full screen | `installedExtensions()` in `extension/extension.js` (reads the server's `extensions.json`), `showInstalled()` in `layer/mobile.js`, `check.extensionEditor` in `selectors.json` |
| `terminal-paste` | the stand-in clipboard's `echo` did not write its file | `pasteToTerminal()` in `layer/mobile.js` (`workbench.action.terminal.sendSequence`) |
| `new-file` | the drawer's new folder / new file did not appear, reach the disk, or open | `createEntry()` in `layer/mobile.js`, `handide.create` in `extension/extension.js` |
| `voice` | the AI bar's 🎤 did not show listening, or the phrase from the stand-in recognizer missed the chat input | `toggleVoice()` / `insertVoiceText()` in `layer/mobile.js`, `chatInput` in `selectors.json` (the chat input editor moved) |
| `edit-korean` | text insertion path changed | the report shows `last paste: <element> <method>`; `pasteInto()` uses EditContext `textupdate` when present (a synthetic paste is accepted but ignored on Android Chrome), else a paste event |
| `accessory-keys` | synthetic keys ignored, or the keys no longer follow the keyboard (emulation shrinks the viewport to stand in for one) | `sendKey()` (keyCode/code), `check.cursor` selector; `updateKeys()` |
| `palette-fits` | quick input overflows | CSS in `mobile.css` for `quickInput` |
| `folder-change` | `vscode.openFolder` or the `?folder=` reload changed | bridge result of `vscode.openFolder`; `pageFolder()` |
| `no-layer-errors` | JS exception in the layer | message is in the report |

3. Re-run `npm run check` (both modes if the change touched shared code; `--android` for input/gesture/viewport changes) until it passes.
4. Update `layer/selectors.json` → `testedWith.version`, so `compat` stops reporting "untested".
5. Summarize for the user: what broke, what changed, the check result.

## Workflow C — personalize

Edit `~/.handide/layer.config.json` (served live; a page reload applies it):

- `menu`: tiles of the menu sheet, any order/subset of `files terminal ai quickOpen palette save undo redo find`. The code is the only screen: files, terminal and AI are drawers, and there are no separate tab screens (the user asked for this explicitly; do not add Git/Search/other full-screen views back).
- `accessoryKeys`: any of `esc tab left up down right home end ctrl alt shift undo redo save find quickOpen palette input` (`input` = the Korean-safe input sheet, `ctrl/alt/shift` are sticky). ☰ (menu) is always first and ⌄ (hide keyboard) last; the row shows only while the soft keyboard is up.
- `breakpoint`: width (px) below which the mobile layout activates (touch devices always get it).
- `companion.mode`: `extension` | `builtin`.

A new action key or tile: an entry in `layer/commands.json` → `actions` (official command ID; `key` only if it must work without the bridge), a `KEY_DEFS` / `MENU_DEFS` entry in `layer/mobile.js`, and `BUILTIN_ACTIONS` for builtin mode. A new view: `VIEW_PARTS` + `MENU_DEFS` (+ `VIEW_BARS` for its header) in `mobile.js`, `showView()` in `extension/extension.js`, a `tabs` chord in `commands.json`. Then `npm run check`.

Mobile-only VS Code settings go in `profile/settings.json`; on the next start handide adds new keys to the user's settings without overwriting their values, and replaces handide's own old defaults listed in `UPGRADES` (`proxy/server.mjs`). `--reset-profile` overwrites everything.

## Workflow D — share

The shareable unit is this repo (command + layer + extension + profile + this skill), installable with `npm install -g github:YangJongWon/handide`. Someone else clones it, opens Claude Code in it, and asks to set up handide → Workflow A adapts to their editor version. Their `~/.handide/layer.config.json` is their personalization; changes to `selectors.json` after a VS Code update are worth sending back upstream.
