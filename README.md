# handide

**Your real VS Code, as a phone IDE.** Run `handide` in any folder, scan the QR code with your phone, and edit that folder from the phone: file drawer, editor, docked terminal, full-screen AI chat. It is the VS Code installed on your PC (not a fork), so your extensions — Claude Code, Copilot and the rest — keep working.

<p>
<img src="docs/editor.png" width="200" alt="Editor with app bar, accessory keys and dock">
<img src="docs/drawer.png" width="200" alt="File drawer over the editor">
<img src="docs/terminal-dock.png" width="200" alt="Terminal docked under the editor">
<img src="docs/ai.png" width="200" alt="AI chat full screen">
</p>

> **한국어 요약**
> `code .`처럼 아무 폴더에서 `handide`를 실행하면 그 폴더가 열리고, 터미널에 QR 코드가 뜹니다. 폰 카메라로 찍으면 PC의 VS Code가 **폰용 IDE 레이아웃**으로 열립니다: 파일 드로어(☰ 또는 왼쪽 가장자리 스와이프, 폴더 변경 가능), 에디터, 하단 도킹/전체 화면 터미널, 전체 화면 AI, Git, 검색, 보조키(Esc·Tab·Ctrl·방향키)와 한글 입력 시트.
> 설치: `npm install -g github:YangJongWon/handide` → 프로젝트 폴더에서 `handide`. 터미널 QR이 잘 안 보이면 PC 브라우저에서 `http://localhost:9000/__handide/connect`를 열면 크게 보입니다. 처음 한 번 인증서 경고를 넘기고 폴더를 신뢰하면 됩니다.

## Install

Requirements: **VS Code** 1.100+ (the host; Cursor and other forks have no `serve-web` but can be installed alongside), **Node.js** 20+.

```sh
npm install -g github:YangJongWon/handide
```

Or from a clone: `git clone https://github.com/YangJongWon/handide.git && cd handide && npm install && npm link`.

## Run

```sh
cd ~/my-project
handide                 # opens the current folder
handide ~/other/folder  # or any folder
```

It prints a QR code and a link. Scan the QR code with the phone camera (same Wi-Fi), or open the link. If the QR code is hard to scan in your terminal, open **http://localhost:9000/__handide/connect** on the PC: it shows it large.

First visit on the phone:
1. A certificate warning: handide makes its own HTTPS certificate for your PC. Android Chrome → *Advanced* → *Proceed*; iPhone Safari → *Show Details* → *visit this website*.
2. VS Code asks whether you trust the folder → **Trust**. Until then VS Code keeps extensions off, including handide's companion (layout, file opening) and agent extensions.

The link carries an access token that is kept in `~/.handide/token`, so a link saved on the phone keeps working across restarts; `handide --new-token` replaces it. Share it only with your own devices.

Why HTTPS: VS Code's connection needs a browser *secure context* (HTTPS or localhost). Plain `http://192.168.x.x` would load the page but never connect; typing `http://` redirects to `https://`.

| Situation | How |
|---|---|
| Phone on the same Wi-Fi (default) | `handide` → scan the QR code |
| Away from home | `handide --local`, then `tailscale serve --bg 9000` → `https://<machine>.<tailnet>.ts.net/?tkn=<token>` (valid certificate, no warning) |
| Android phone over USB | `handide --local`, `adb reverse tcp:9000 tcp:9000`, open `http://localhost:9000/?tkn=<token>` |
| Your own certificate | `handide --cert cert.pem --key key.pem` |
| This PC only | `handide --local` |

`handide --help` lists all options.

## The phone layout

```
┌ ☰  file name ▾            🔍  ⋮ ┐   app bar: drawer, quick open, search, command palette
│                                 │
│  editor                         │
├──── terminal (docked) ──────────┤   optional; or full screen
├ Esc ⇥ Ctrl ← ↑ ↓ → ↶ 가 ⌘        ┤   accessory keys while typing
└ 파일   코드   터미널   AI   Git     ┘   dock
```

- **Files**: a drawer over the editor (☰, the Files button, or swipe from the left edge; swipe left, tap outside or ✕ to close). Tap a file to open it. The folder button opens a folder picker to switch to any folder on the PC.
- **Code**: the editor alone. Word wrap on, no minimap, autosave after 1.5 s.
- **Terminal**: first tap docks it under the editor, second tap makes it full screen, **Code** closes it. VS Code's own maximize / ✕ buttons on the terminal also work.
- **AI**: VS Code's chat (and agent extensions in it) full screen.
- **Git**, **Search**: full screen.
- **Accessory keys**: Esc, Tab, sticky Ctrl, arrows, undo, **가** (a native text box: any IME including Korean, inserted at the cursor), command palette. With the soft keyboard open the dock shrinks to icons and ⌄ hides the keyboard.

## Customize

`~/.handide/layer.config.json` (created on first run; reload the page to apply):

```json
{
  "dock": ["files", "code", "terminal", "ai", "git"],
  "accessoryKeys": ["esc", "tab", "ctrl", "left", "up", "down", "right", "undo", "input", "palette"],
  "breakpoint": 900,
  "companion": { "mode": "extension" }
}
```

`dock` can also hold `search`. `companion.mode: "builtin"` runs without the companion extension (VS Code's default shortcuts; views open but not in the phone layout, and the drawer can't open files). Mobile VS Code settings live in `~/.handide/data/Machine/settings.json`.

## How it works

```
phone ──https──> handide ──> code serve-web (127.0.0.1 only) ──> your VS Code
                   ├─ injects the layer: app bar, drawer, dock, keys (layer/)
                   ├─ command bridge ⇄ companion extension (extension/): official VS Code
                   │    commands with arguments (open file, open folder, switch view)
                   └─ mobile profile + certificate + token in ~/.handide
```

`code serve-web` is VS Code's own "run in a browser" feature; handide never modifies VS Code or your desktop settings. Everything that depends on VS Code internals is listed in `layer/selectors.json`.

## Claude Code skill

The repo includes a Claude Code skill (`.claude/skills/mobilize-editor`): open the repo in Claude Code and ask it to set up handide, re-verify it after a VS Code update, fix what an update broke, or change your layout.

## Verify

```sh
npm run check                     # Pixel 7 + iPhone 14 emulation (19 checks each)
npm run check -- --mode builtin
npm run check -- --android        # real Chrome on an emulator or USB phone: real taps, swipes, soft keyboard
```

Each run uses a private data dir and sample workspace under `check-output/`, and writes `check-output/report.json` plus a screenshot per step.

Last verified: VS Code 1.138.0 (web server 1.139+) on Windows — emulated Pixel 7 / iPhone 14: 38/38 (companion) and 36/36 (builtin). The new layout has not yet been run on the Android emulator or a physical phone.

## Known limitations

- Not yet tested on a physical iPhone or Android phone.
- The folder must be trusted once per browser and folder.
- A few layout commands the companion uses are internal to VS Code; `npm run compat` flags untested versions and `npm run check` confirms them.
- `serve-web` can download a newer VS Code web server than your desktop version, so the phone may run a newer VS Code than the one you tested with.

## License

MIT
