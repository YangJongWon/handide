<p align="center"><img src="https://raw.githubusercontent.com/YangJongWon/handide/main/docs/banner.jpg" width="100%" alt="handide: a phone showing code, framed by the corners of a QR code"></p>

# handide: VS Code on your phone

Press the phone button in the status bar, scan the QR code, and keep working on this project from your phone: your own VS Code, your extensions and your AI agents (Claude Code, Codex, …), with a touch layout made for a phone. Your files stay on your PC; the phone is just a screen.

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/YangJongWon/handide/main/docs/editor.png" width="160" alt="Full-screen editor"><br><sub>Code, edge to edge</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/YangJongWon/handide/main/docs/drawer.png" width="160" alt="File drawer"><br><sub>Files drawer</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/YangJongWon/handide/main/docs/terminal-dock.png" width="160" alt="Terminal drawer"><br><sub>Terminal drawer</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/YangJongWon/handide/main/docs/ai.png" width="160" alt="AI chat"><br><sub>AI chat</sub></td>
  </tr>
</table>

## Use

1. Open a folder in VS Code.
2. Press the **phone button** in the status bar (or run **handide: Open on Phone**).
3. Scan the QR code with the phone camera.

Your open files and cursor go along: the phone opens the same files, with the cursor where it was. Files with unsaved changes are saved first, if you agree, since the phone opens what is on disk. The phone takes them as soon as it shows this folder, so with the phone page already open, pressing the button and picking up the phone is enough.

Nothing else to install: [handide](https://github.com/YangJongWon/handide) comes inside this extension. The first press sets it up, and downloads Node.js from nodejs.org once if this PC has no Node.js 20 or newer. If you installed handide yourself (the Windows installer or npm), that one is used.

handide keeps running after VS Code closes, so the phone stays connected. **handide: Stop** in the Command Palette stops it.

- **Same Wi-Fi:** works right away. The first visit shows a certificate warning once, because handide makes its own certificate for your PC.
- **Away from home:** press **Set up access from anywhere** in the QR panel (or run **handide: Set Up Access from Anywhere**). It installs [Tailscale](https://tailscale.com) on this PC when it is missing and signs you in, in a terminal and the browser. The QR code then works on mobile data too, with nothing to install on the phone.

## Security

**The QR code is a key to this PC.** Its link carries an access token, and anyone who opens the link can use this PC through VS Code: read and change its files and run commands in its terminal.

- Scan it only with your own phone. Do not share the link, or a screenshot of the QR panel.
- With access from anywhere, the link works from the whole internet, and the token is its only lock.
- If the link got out, run **handide: Replace Access Token** (or press **Replace access token** in the QR panel). Every link handed out before stops working, and phones connect again with the new QR code.
- **handide: Stop** closes access entirely until you press the phone button again.

## Other PCs

With handide on several PCs signed in to the same Tailscale account, the **PCs** button opens a project of another PC where it lives (through Remote - SSH), or moves it to run on this PC.

## Settings

- `handide.port`: the port handide runs on (default `9000`).
