# handide

**Your real VS Code, as a phone IDE.** Run `handide` in any folder, scan the QR code with your phone, and edit that folder from the phone: a full-screen editor, a floating menu button, a file drawer, a terminal drawer and full-screen AI chat. It is the VS Code installed on your PC (not a fork), so your extensions — Claude Code, Copilot and the rest — keep working.

<p>
<img src="docs/editor.png" width="160" alt="Full-screen editor with the floating menu button">
<img src="docs/menu.png" width="160" alt="Menu sheet">
<img src="docs/drawer.png" width="160" alt="File drawer over the editor">
<img src="docs/terminal-dock.png" width="160" alt="Terminal drawer under the editor">
<img src="docs/ai.png" width="160" alt="AI chat full screen">
</p>

> **한국어 요약**
> `code .`처럼 아무 폴더에서 `handide`를 실행하면 그 폴더가 열리고, 터미널에 QR 코드가 뜹니다. 폰 카메라로 찍으면 PC의 VS Code가 **폰용 IDE 레이아웃**으로 열립니다: 코드만 보이는 전체 화면 에디터, 드래그로 옮길 수 있는 플로팅 버튼(→ 메뉴 시트), 파일 드로어(메뉴 또는 왼쪽 가장자리 스와이프, 폴더 변경 가능), 하단 터미널 드로어(아래로 쓸면 닫힘), 오른쪽 AI 드로어(오른쪽 가장자리 스와이프). 화면은 코드 하나뿐이고 별도 탭 화면은 없습니다. 키보드가 올라왔을 때만 뜨는 보조키(Esc·Tab·Ctrl·방향키)와 한글 입력 시트.
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

- **One screen**: the code. Everything else is a drawer over it (files from the left, AI from the right, terminal from the bottom); VS Code's own side bar or a layout it restores by itself is closed again.
- **Menu** (floating button, or ☰ on the accessory keys): the active file (tap it for quick open), save, and tiles for Files, Terminal, AI, Find file, Command palette, Save, Undo and Redo. Swipe down or tap outside to close. Drag the button to move it; it snaps to the nearest side and remembers where it was, and a dot on it means unsaved changes.
- **Files**: a drawer over the editor (menu, or swipe from the left edge; swipe left, tap outside or ✕ to close). Tap a file to open it. The folder button opens a folder picker to switch to any folder on the PC.
- **Code**: the editor alone, edge to edge. Word wrap on, no minimap, autosave after 1.5 s.
- **Terminal**: a drawer under the editor. Its grab bar has new terminal and kill buttons; swipe it down or tap ⌄ to close.
- **AI**: VS Code's chat as a drawer from the right (menu, or swipe from the right edge). Its bar starts a new chat; › , a swipe right on the bar or a swipe from the left edge closes it.
- **Accessory keys**: shown only while the soft keyboard is up. ☰ (menu), Esc, Tab, sticky Ctrl, arrows, undo, **가** (a native text box: any IME including Korean, inserted at the cursor), ⌄ hides the keyboard.

## Customize

`~/.handide/layer.config.json` (created on first run; reload the page to apply):

```json
{
  "menu": ["files", "terminal", "ai", "quickOpen", "palette", "save", "undo", "redo"],
  "accessoryKeys": ["esc", "tab", "ctrl", "left", "up", "down", "right", "undo", "input"],
  "breakpoint": 900,
  "companion": { "mode": "extension" }
}
```

`menu` can also hold `find`; `accessoryKeys` also `alt`, `shift`, `home`, `end`, `redo`, `save`, `find`, `quickOpen` and `palette` (☰ is always first). `companion.mode: "builtin"` runs without the companion extension (VS Code's default shortcuts; views open but not in the phone layout, and the drawer can't open files). Mobile VS Code settings live in `~/.handide/data/Machine/settings.json`.

## How it works

```
phone ──https──> handide ──> code serve-web (127.0.0.1 only) ──> your VS Code
                   ├─ injects the layer: floating button, menu, drawers, keys (layer/)
                   ├─ command bridge ⇄ companion extension (extension/): official VS Code
                   │    commands with arguments (open file, open folder, switch view)
                   └─ mobile profile + certificate + token in ~/.handide
```

`code serve-web` is VS Code's own "run in a browser" feature; handide never modifies VS Code or your desktop settings. Everything that depends on VS Code internals is listed in `layer/selectors.json`.

## Claude Code skill

The repo includes a Claude Code skill (`.claude/skills/mobilize-editor`): open the repo in Claude Code and ask it to set up handide, re-verify it after a VS Code update, fix what an update broke, or change your layout.

## Verify

```sh
npm run check                     # Pixel 7 + iPhone 14 emulation (18 checks each)
npm run check -- --mode builtin
npm run check -- --android        # real Chrome on an emulator or USB phone: real taps, swipes, soft keyboard
```

Each run uses a private data dir and sample workspace under `check-output/`, and writes `check-output/report.json` plus a screenshot per step.

Last verified: VS Code 1.138.0 (web server 1.139+) on Windows — emulated Pixel 7 / iPhone 14: 36/36 (companion) and 34/34 (builtin). Emulation has no soft keyboard, so the check shrinks the viewport the way one does. The full-screen layout has not yet been run on the Android emulator or a physical phone.

## Known limitations

- Not yet tested on a physical iPhone or Android phone.
- The folder must be trusted once per browser and folder.
- A few layout commands the companion uses are internal to VS Code; `npm run compat` flags untested versions and `npm run check` confirms them.
- `serve-web` can download a newer VS Code web server than your desktop version, so the phone may run a newer VS Code than the one you tested with.

## License

MIT
