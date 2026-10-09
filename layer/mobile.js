// handide mobile layer. Injected by the proxy into the real VS Code web UI.
//
// A full-screen code editor with everything else one gesture away:
//
//   ┌ editor (VS Code), full screen ─────────────┐
//   │                                       (◉)  │  floating button (draggable) → menu sheet
//   ├─ terminal: bottom drawer (VS Code panel) ──┤  grab bar: swipe down / ⌄ closes
//   └─ accessory keys, only while typing ────────┘
//   Files = left drawer (menu, or swipe from the left edge).
//   AI = right drawer (menu, or swipe from the right edge): VS Code's secondary side bar.
//   There are no other screens: the code is the only "tab".
//
// It never touches VS Code internals. It talks to VS Code through
//  - the command bridge (proxy ↔ companion extension): official commands with
//    arguments, e.g. vscode.open / vscode.openFolder / handide.view,
//  - key chords bound by the companion extension (fallback when the bridge is down),
//  - the DOM only to read layout state (selectors.json) and to insert text.
const BASE = '/__handide/';

// ---------------------------------------------------------------- i18n
//
// The layer's own strings. English is the default; the gear in the menu sheet picks
// another language and remembers it. (VS Code's own display language is a separate
// thing: Command Palette → Configure Display Language.)
const LANGS = { en: 'English', ko: '한국어', ja: '日本語', zh: '中文' };
const STRINGS = {
	en: {
		'key.input': 'A',
		'menu.editor': 'Code',
		'menu.files': 'Files',
		'menu.terminal': 'Terminal',
		'menu.ai': 'AI · Extensions',
		'menu.extensions': 'Extensions',
		'menu.quickOpen': 'Go to File',
		'menu.palette': 'Command',
		'menu.save': 'Save',
		'menu.undo': 'Undo',
		'menu.redo': 'Redo',
		'menu.find': 'Find',
		'view.terminal': 'Terminal',
		'view.ai': 'AI · Extensions',
		'action.copy': 'Copy',
		'action.paste': 'Paste',
		'action.newTerminal': 'New Terminal',
		'action.killTerminal': 'Kill Terminal',
		'action.attach': 'Attach Image',
		'action.voice': 'Voice Input',
		'action.cancel': 'Cancel',
		'action.insert': 'Insert',
		'action.reconnect': 'Reconnect',
		'action.back': '‹ Back',
		'img.needExt': 'The handide extension is needed to save an image.',
		'img.tooBig': 'Only images up to 15MB can be attached.',
		'img.saving': 'Saving the image…',
		'img.saveFailed': 'The image could not be saved.',
		'img.reference': 'Please check this screenshot: {1}',
		'img.inserted': '{1} saved and inserted',
		'img.saved': 'Saved to {1}. Paste it into the agent input box.',
		'img.failed': 'The image could not be attached: {1}',
		'img.tapToCopy': 'Tap to copy the path',
		'img.copied': 'Copied. Paste it into the agent input box.',
		'sheet.terminal': 'Long-press here to paste → send to the terminal',
		'sheet.placeholder': 'Type here (any language) → insert',
		'need.create': 'Creating a file needs the handide extension (check that the folder is trusted).',
		'need.open': 'Opening a file needs the handide extension (check that the folder is trusted).',
		'need.folder': 'Changing the folder needs the handide extension.',
		'prompt.newFolder': 'New folder name (inside {1}/)',
		'prompt.newFile': 'New file name (inside {1}/)',
		'create.failed': 'Could not create it: {1} (it already exists, or the name is not valid)',
		'folder.unreadable': 'This folder cannot be read.',
		'folder.opening': 'Opening the folder… the page will reload.',
		'drawer.selectFolder': 'Select folder',
		'drawer.parent': 'Parent folder',
		'drawer.noSubfolders': 'No subfolders here.',
		'drawer.openHere': 'Open this folder',
		'drawer.noFolder': 'No folder',
		'drawer.empty': 'No folder is open.',
		'drawer.waiting': 'Waiting for the handide extension. Check that the folder is trusted.',
		'drawer.openFolder': 'Open folder',
		'drawer.more': '… {1} more',
		'word.drives': 'Drives',
		'aria.uploadImage': 'Upload image',
		'aria.newFile': 'New file',
		'aria.newFolder': 'New folder',
		'aria.changeFolder': 'Change folder',
		'aria.refresh': 'Refresh',
		'aria.close': 'Close',
		'aria.save': 'Save',
		'aria.settings': 'Settings',
		'aria.menu': 'Menu',
		'aria.files': 'Files',
		'aria.agents': 'Agents',
		'aria.quickOpen': 'Quick open file',
		'aria.pickAgent': 'Pick an agent',
		'aria.hideKeyboard': 'Hide the keyboard',
		'aria.manageExt': 'Manage {1}',
		'aria.settingsExt': 'Settings for {1}',
		'count.views': '{1}',
		'clip.empty': 'The clipboard is empty.',
		'clip.copiedSelection': 'The selection was copied.',
		'clip.iframeCopy': 'Use the copy button, or long-press, in the extension result.',
		'clip.iframePaste': 'Long-press the extension input box, then choose paste.',
		'clip.pasted': 'Pasted.',
		'ext.listFailed': 'The extension list could not be loaded.',
		'ext.manageList': 'Manage extensions ›',
		'ext.manageHint': 'Disable · uninstall · settings · install',
		'ext.install': '＋ Install extension',
		'ext.installHint': 'Find by name in the marketplace',
		'ext.disabled': 'Disabled · {1}',
		'ext.none': 'No installed extensions.',
		'ext.openSettingsFailed': 'The extension settings could not be opened.',
		'ext.openManageFailed': 'The extension management page could not be opened.',
		'ext.manage': 'Manage',
		'ext.settings': 'Settings',
		'voice.unsupported': 'This browser has no speech recognition. Use the microphone button on the keyboard.',
		'voice.micDenied': 'The microphone needs permission. Allow the microphone for this site in your browser settings.',
		'voice.error': 'Speech recognition error: {1}',
		'voice.startFailed': 'Speech recognition could not be started: {1}',
		'voice.copied': 'Copied: long-press the input box to paste\n{1}',
		'voice.listening': 'Listening… your words go into the input box',
		'notice.insecure': 'VS Code connects only over HTTPS or localhost (this page is http). Open the QR code or link handide shows on the PC.',
		'link.open': 'Open link',
		'preview.browser': 'Open in browser',
		'notice.offline': 'The connection was lost. It is checked again automatically once the network is back.',
		'trust.notice': 'Trust this folder so that views, file opening and agent extensions work.',
		'trust.manage': 'Manage trust',
		'settings.language': 'Language',
		'settings.title': 'Settings',
		'devices.label': 'PCs',
		'devices.offline': 'Offline',
		'devices.switching': 'Opening {1}…',
		'devices.unreachable': '{1} is offline. Start handide on that PC.',
	},
	ko: {
		'key.input': '가',
		'menu.editor': '코드',
		'menu.files': '파일',
		'menu.terminal': '터미널',
		'menu.ai': 'AI·확장',
		'menu.extensions': '확장 관리',
		'menu.quickOpen': '파일 찾기',
		'menu.palette': '명령',
		'menu.save': '저장',
		'menu.undo': '실행 취소',
		'menu.redo': '다시 실행',
		'menu.find': '찾기',
		'view.terminal': '터미널',
		'view.ai': 'AI·확장',
		'action.copy': '복사',
		'action.paste': '붙여넣기',
		'action.newTerminal': '새 터미널',
		'action.killTerminal': '터미널 종료',
		'action.attach': '이미지 첨부',
		'action.voice': '음성 입력',
		'action.cancel': '취소',
		'action.insert': '삽입',
		'action.reconnect': '다시 연결',
		'action.back': '‹ 뒤로',
		'img.needExt': '이미지를 저장하려면 handide 확장이 필요합니다.',
		'img.tooBig': '이미지는 15MB 이하만 첨부할 수 있습니다.',
		'img.saving': '이미지를 저장하는 중…',
		'img.saveFailed': '이미지를 저장하지 못했습니다.',
		'img.reference': '이 스크린샷을 확인해 주세요: {1}',
		'img.inserted': '{1} 저장 및 입력 완료',
		'img.saved': '{1}에 저장했습니다. 에이전트 입력창에 붙여넣으세요.',
		'img.failed': '이미지 첨부 실패: {1}',
		'img.tapToCopy': '탭해서 경로 복사',
		'img.copied': '복사했습니다. 에이전트 입력창에 붙여넣으세요.',
		'sheet.terminal': '여기에 길게 눌러 붙여넣기 → 터미널로 보내기',
		'sheet.placeholder': '여기에 입력 (한글 OK) → 삽입',
		'need.create': '파일을 만들려면 handide 확장이 필요합니다 (폴더 신뢰 확인).',
		'need.open': '파일을 열려면 handide 확장이 필요합니다 (폴더 신뢰 확인).',
		'need.folder': '폴더를 바꾸려면 handide 확장이 필요합니다.',
		'prompt.newFolder': '새 폴더 이름 ({1}/ 안에)',
		'prompt.newFile': '새 파일 이름 ({1}/ 안에)',
		'create.failed': '만들지 못했습니다: {1} (이미 있거나 이름이 잘못됨)',
		'folder.unreadable': '폴더를 읽을 수 없습니다.',
		'folder.opening': '폴더를 여는 중… 페이지가 다시 로드됩니다.',
		'drawer.selectFolder': '폴더 선택',
		'drawer.parent': '상위 폴더',
		'drawer.noSubfolders': '하위 폴더가 없습니다.',
		'drawer.openHere': '이 폴더 열기',
		'drawer.noFolder': '폴더 없음',
		'drawer.empty': '열린 폴더가 없습니다.',
		'drawer.waiting': 'handide 확장을 기다리는 중입니다. 폴더를 신뢰했는지 확인하세요.',
		'drawer.openFolder': '폴더 열기',
		'drawer.more': '… {1}개 더 있음',
		'word.drives': '드라이브',
		'aria.uploadImage': '이미지 업로드',
		'aria.newFile': '새 파일',
		'aria.newFolder': '새 폴더',
		'aria.changeFolder': '폴더 변경',
		'aria.refresh': '새로고침',
		'aria.close': '닫기',
		'aria.save': '저장',
		'aria.settings': '환경설정',
		'aria.menu': '메뉴',
		'aria.files': '파일',
		'aria.agents': '에이전트',
		'aria.quickOpen': '파일 빠른 열기',
		'aria.pickAgent': '에이전트 선택',
		'aria.hideKeyboard': '키보드 내리기',
		'aria.manageExt': '{1} 관리',
		'aria.settingsExt': '{1} 설정',
		'count.views': '{1}개',
		'clip.empty': '클립보드가 비어 있습니다.',
		'clip.copiedSelection': '선택한 내용을 복사했습니다.',
		'clip.iframeCopy': '확장 결과의 복사 버튼이나 길게 누르기를 사용해 주세요.',
		'clip.iframePaste': '확장 입력창을 길게 누른 뒤 붙여넣기를 선택하세요.',
		'clip.pasted': '붙여넣었습니다.',
		'ext.listFailed': '확장 목록을 가져오지 못했습니다.',
		'ext.manageList': '확장 관리 ›',
		'ext.manageHint': '사용 안 함·제거·설정·설치',
		'ext.install': '＋ 확장 설치',
		'ext.installHint': '마켓플레이스에서 이름으로 찾기',
		'ext.disabled': '사용 안 함 · {1}',
		'ext.none': '설치된 확장이 없습니다.',
		'ext.openSettingsFailed': '확장 설정을 열지 못했습니다.',
		'ext.openManageFailed': '확장 관리 화면을 열지 못했습니다.',
		'ext.manage': '관리',
		'ext.settings': '설정',
		'voice.unsupported': '이 브라우저는 음성 인식을 지원하지 않습니다. 키보드의 마이크 버튼을 쓰세요.',
		'voice.micDenied': '마이크 권한이 필요합니다. 브라우저 설정에서 이 사이트의 마이크를 허용하세요.',
		'voice.error': '음성 인식 오류: {1}',
		'voice.startFailed': '음성 인식을 시작하지 못했습니다: {1}',
		'voice.copied': '복사됨: 입력창을 길게 눌러 붙여넣으세요\n{1}',
		'voice.listening': '듣는 중… 말하면 입력창에 들어갑니다',
		'notice.insecure': 'HTTPS나 localhost로 접속해야 VS Code가 연결됩니다 (현재 http). PC에서 handide가 띄운 QR이나 링크로 여세요.',
		'link.open': '링크 열기',
		'preview.browser': '브라우저로 열기',
		'notice.offline': '연결이 끊겼습니다. 네트워크가 돌아오면 자동으로 다시 확인합니다.',
		'trust.notice': '이 폴더를 신뢰해야 화면 전환, 파일 열기, 에이전트 확장이 동작합니다.',
		'trust.manage': '신뢰 설정',
		'settings.language': '언어',
		'settings.title': '설정',
		'devices.label': 'PC',
		'devices.offline': '꺼짐',
		'devices.switching': '{1} 여는 중…',
		'devices.unreachable': '{1}이(가) 꺼져 있습니다. 그 PC에서 handide를 실행하세요.',
	},
	ja: {
		'key.input': 'あ',
		'menu.editor': 'コード',
		'menu.files': 'ファイル',
		'menu.terminal': 'ターミナル',
		'menu.ai': 'AI・拡張機能',
		'menu.extensions': '拡張機能管理',
		'menu.quickOpen': 'ファイルへ移動',
		'menu.palette': 'コマンド',
		'menu.save': '保存',
		'menu.undo': '元に戻す',
		'menu.redo': 'やり直す',
		'menu.find': '検索',
		'view.terminal': 'ターミナル',
		'view.ai': 'AI・拡張機能',
		'action.copy': 'コピー',
		'action.paste': '貼り付け',
		'action.newTerminal': '新しいターミナル',
		'action.killTerminal': 'ターミナルを終了',
		'action.attach': '画像を添付',
		'action.voice': '音声入力',
		'action.cancel': 'キャンセル',
		'action.insert': '挿入',
		'action.reconnect': '再接続',
		'action.back': '‹ 戻る',
		'img.needExt': '画像を保存するには handide 拡張機能が必要です。',
		'img.tooBig': '添付できる画像は 15MB までです。',
		'img.saving': '画像を保存しています…',
		'img.saveFailed': '画像を保存できませんでした。',
		'img.reference': 'このスクリーンショットを確認してください: {1}',
		'img.inserted': '{1} を保存して入力しました',
		'img.saved': '{1} に保存しました。エージェントの入力欄に貼り付けてください。',
		'img.failed': '画像を添付できませんでした: {1}',
		'img.tapToCopy': 'タップしてパスをコピー',
		'img.copied': 'コピーしました。エージェントの入力欄に貼り付けてください。',
		'sheet.terminal': 'ここを長押しで貼り付け → ターミナルへ送信',
		'sheet.placeholder': 'ここに入力（日本語可）→ 挿入',
		'need.create': 'ファイルを作成するには handide 拡張機能が必要です（フォルダが信頼されているか確認してください）。',
		'need.open': 'ファイルを開くには handide 拡張機能が必要です（フォルダが信頼されているか確認してください）。',
		'need.folder': 'フォルダを変更するには handide 拡張機能が必要です。',
		'prompt.newFolder': '新しいフォルダ名（{1}/ 内）',
		'prompt.newFile': '新しいファイル名（{1}/ 内）',
		'create.failed': '作成できませんでした: {1}（すでに存在するか、名前が正しくありません）',
		'folder.unreadable': 'フォルダを読み取れません。',
		'folder.opening': 'フォルダを開いています… ページが再読み込みされます。',
		'drawer.selectFolder': 'フォルダを選択',
		'drawer.parent': '親フォルダ',
		'drawer.noSubfolders': 'サブフォルダはありません。',
		'drawer.openHere': 'このフォルダを開く',
		'drawer.noFolder': 'フォルダなし',
		'drawer.empty': '開いているフォルダがありません。',
		'drawer.waiting': 'handide 拡張機能を待っています。フォルダが信頼されているか確認してください。',
		'drawer.openFolder': 'フォルダを開く',
		'drawer.more': '… 他に {1} 件',
		'word.drives': 'ドライブ',
		'aria.uploadImage': '画像をアップロード',
		'aria.newFile': '新しいファイル',
		'aria.newFolder': '新しいフォルダ',
		'aria.changeFolder': 'フォルダを変更',
		'aria.refresh': '再読み込み',
		'aria.close': '閉じる',
		'aria.save': '保存',
		'aria.settings': '設定',
		'aria.menu': 'メニュー',
		'aria.files': 'ファイル',
		'aria.agents': 'エージェント',
		'aria.quickOpen': 'クイックオープン',
		'aria.pickAgent': 'エージェントを選択',
		'aria.hideKeyboard': 'キーボードを閉じる',
		'aria.manageExt': '{1} を管理',
		'aria.settingsExt': '{1} の設定',
		'count.views': '{1} 件',
		'clip.empty': 'クリップボードが空です。',
		'clip.copiedSelection': '選択範囲をコピーしました。',
		'clip.iframeCopy': '拡張機能の結果では、コピーボタンか長押しを使ってください。',
		'clip.iframePaste': '拡張機能の入力欄を長押しして、貼り付けを選んでください。',
		'clip.pasted': '貼り付けました。',
		'ext.listFailed': '拡張機能の一覧を取得できませんでした。',
		'ext.manageList': '拡張機能の管理 ›',
		'ext.manageHint': '無効化・アンインストール・設定・インストール',
		'ext.install': '＋ 拡張機能をインストール',
		'ext.installHint': 'マーケットプレイスで名前から検索',
		'ext.disabled': '無効 · {1}',
		'ext.none': 'インストール済みの拡張機能はありません。',
		'ext.openSettingsFailed': '拡張機能の設定を開けませんでした。',
		'ext.openManageFailed': '拡張機能の管理画面を開けませんでした。',
		'ext.manage': '管理',
		'ext.settings': '設定',
		'voice.unsupported': 'このブラウザは音声認識に対応していません。キーボードのマイクボタンを使ってください。',
		'voice.micDenied': 'マイクの許可が必要です。ブラウザの設定でこのサイトのマイクを許可してください。',
		'voice.error': '音声認識エラー: {1}',
		'voice.startFailed': '音声認識を開始できませんでした: {1}',
		'voice.copied': 'コピーしました: 入力欄を長押しして貼り付けてください\n{1}',
		'voice.listening': '聞き取り中… 話した内容が入力欄に入ります',
		'notice.insecure': 'VS Code に接続するには HTTPS か localhost で開いてください（現在は http）。PC で handide が表示する QR コードかリンクを開いてください。',
		'link.open': 'リンクを開く',
		'preview.browser': 'ブラウザで開く',
		'notice.offline': '接続が切れました。ネットワークが戻ると自動で再確認します。',
		'trust.notice': 'このフォルダを信頼すると、画面の切り替え・ファイルを開く・エージェント拡張機能が使えます。',
		'trust.manage': '信頼の設定',
		'settings.language': '言語',
		'settings.title': '設定',
		'devices.label': 'PC',
		'devices.offline': 'オフライン',
		'devices.switching': '{1} を開いています…',
		'devices.unreachable': '{1} はオフラインです。その PC で handide を起動してください。',
	},
	zh: {
		'key.input': '中',
		'menu.editor': '代码',
		'menu.files': '文件',
		'menu.terminal': '终端',
		'menu.ai': 'AI·扩展',
		'menu.extensions': '扩展管理',
		'menu.quickOpen': '转到文件',
		'menu.palette': '命令',
		'menu.save': '保存',
		'menu.undo': '撤销',
		'menu.redo': '重做',
		'menu.find': '查找',
		'view.terminal': '终端',
		'view.ai': 'AI·扩展',
		'action.copy': '复制',
		'action.paste': '粘贴',
		'action.newTerminal': '新建终端',
		'action.killTerminal': '终止终端',
		'action.attach': '附加图片',
		'action.voice': '语音输入',
		'action.cancel': '取消',
		'action.insert': '插入',
		'action.reconnect': '重新连接',
		'action.back': '‹ 返回',
		'img.needExt': '保存图片需要 handide 扩展。',
		'img.tooBig': '只能附加 15MB 以内的图片。',
		'img.saving': '正在保存图片…',
		'img.saveFailed': '保存图片失败。',
		'img.reference': '请查看这张截图：{1}',
		'img.inserted': '已保存并输入 {1}',
		'img.saved': '已保存到 {1}。请粘贴到智能体输入框。',
		'img.failed': '附加图片失败：{1}',
		'img.tapToCopy': '点按复制路径',
		'img.copied': '已复制。请粘贴到智能体输入框。',
		'sheet.terminal': '长按此处粘贴 → 发送到终端',
		'sheet.placeholder': '在此输入（支持中文）→ 插入',
		'need.create': '创建文件需要 handide 扩展（请确认已信任该文件夹）。',
		'need.open': '打开文件需要 handide 扩展（请确认已信任该文件夹）。',
		'need.folder': '更改文件夹需要 handide 扩展。',
		'prompt.newFolder': '新文件夹名称（在 {1}/ 内）',
		'prompt.newFile': '新文件名称（在 {1}/ 内）',
		'create.failed': '创建失败：{1}（已存在，或名称无效）',
		'folder.unreadable': '无法读取该文件夹。',
		'folder.opening': '正在打开文件夹… 页面将重新加载。',
		'drawer.selectFolder': '选择文件夹',
		'drawer.parent': '上级文件夹',
		'drawer.noSubfolders': '没有子文件夹。',
		'drawer.openHere': '打开此文件夹',
		'drawer.noFolder': '没有文件夹',
		'drawer.empty': '没有打开的文件夹。',
		'drawer.waiting': '正在等待 handide 扩展。请确认已信任该文件夹。',
		'drawer.openFolder': '打开文件夹',
		'drawer.more': '… 还有 {1} 个',
		'word.drives': '驱动器',
		'aria.uploadImage': '上传图片',
		'aria.newFile': '新建文件',
		'aria.newFolder': '新建文件夹',
		'aria.changeFolder': '更改文件夹',
		'aria.refresh': '刷新',
		'aria.close': '关闭',
		'aria.save': '保存',
		'aria.settings': '设置',
		'aria.menu': '菜单',
		'aria.files': '文件',
		'aria.agents': '智能体',
		'aria.quickOpen': '快速打开文件',
		'aria.pickAgent': '选择智能体',
		'aria.hideKeyboard': '收起键盘',
		'aria.manageExt': '管理 {1}',
		'aria.settingsExt': '{1} 的设置',
		'count.views': '{1} 个',
		'clip.empty': '剪贴板为空。',
		'clip.copiedSelection': '已复制所选内容。',
		'clip.iframeCopy': '请在扩展结果中使用复制按钮或长按。',
		'clip.iframePaste': '请长按扩展输入框，然后选择粘贴。',
		'clip.pasted': '已粘贴。',
		'ext.listFailed': '无法获取扩展列表。',
		'ext.manageList': '扩展管理 ›',
		'ext.manageHint': '禁用·卸载·设置·安装',
		'ext.install': '＋ 安装扩展',
		'ext.installHint': '在应用市场中按名称查找',
		'ext.disabled': '已禁用 · {1}',
		'ext.none': '没有已安装的扩展。',
		'ext.openSettingsFailed': '无法打开扩展设置。',
		'ext.openManageFailed': '无法打开扩展管理页面。',
		'ext.manage': '管理',
		'ext.settings': '设置',
		'voice.unsupported': '此浏览器不支持语音识别。请使用键盘上的麦克风按钮。',
		'voice.micDenied': '需要麦克风权限。请在浏览器设置中允许本站使用麦克风。',
		'voice.error': '语音识别错误：{1}',
		'voice.startFailed': '无法启动语音识别：{1}',
		'voice.copied': '已复制：请长按输入框粘贴\n{1}',
		'voice.listening': '正在聆听… 说话内容会进入输入框',
		'notice.insecure': '必须通过 HTTPS 或 localhost 访问才能连接 VS Code（当前为 http）。请打开 PC 上 handide 显示的二维码或链接。',
		'link.open': '打开链接',
		'preview.browser': '在浏览器中打开',
		'notice.offline': '连接已断开。网络恢复后会自动重新检查。',
		'trust.notice': '信任此文件夹后，视图切换、打开文件和智能体扩展才能工作。',
		'trust.manage': '管理信任',
		'settings.language': '语言',
		'settings.title': '设置',
		'devices.label': '电脑',
		'devices.offline': '离线',
		'devices.switching': '正在打开 {1}…',
		'devices.unreachable': '{1} 离线。请在那台电脑上启动 handide。',
	},
};

function storedLang() {
	try {
		return localStorage.getItem('handide.lang');
	} catch {
		return null;
	}
}

let lang = STRINGS[storedLang()] ? storedLang() : 'en';

/** t('img.reference', relative) → this language's string with {1}, {2}, … put in. */
const t = (key, ...args) => {
	const raw = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
	return args.reduce((s, v, i) => s.split(`{${i + 1}}`).join(String(v)), raw);
};

/**
 * Strings built once at boot carry data-i18n* keys; screens rendered on demand call
 * t() instead. Called after a language switch so both kinds end up current.
 */
function applyI18n(root = document) {
	for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
	for (const e of root.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
	for (const e of root.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
	for (const e of root.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
}


const KEY_DEFS = {
	menu: { icon: 'menu', menu: true },
	esc: { label: 'Esc', key: 'Escape', keyCode: 27 },
	tab: { label: '⇥', key: 'Tab', keyCode: 9 },
	left: { label: '←', key: 'ArrowLeft', keyCode: 37 },
	up: { label: '↑', key: 'ArrowUp', keyCode: 38 },
	down: { label: '↓', key: 'ArrowDown', keyCode: 40 },
	right: { label: '→', key: 'ArrowRight', keyCode: 39 },
	home: { label: 'Home', key: 'Home', keyCode: 36 },
	end: { label: 'End', key: 'End', keyCode: 35 },
	ctrl: { label: 'Ctrl', sticky: 'ctrlKey' },
	alt: { label: 'Alt', sticky: 'altKey' },
	shift: { label: 'Shift', sticky: 'shiftKey' },
	undo: { icon: 'discard', action: 'undo' },
	redo: { icon: 'redo', action: 'redo' },
	save: { icon: 'save', action: 'save' },
	find: { icon: 'search', action: 'find' },
	quickOpen: { icon: 'go-to-file', action: 'quickOpen' },
	palette: { icon: 'terminal-cmd', action: 'commandPalette' },
	input: { label: 'key.input', input: true },
	copy: { icon: 'copy', clipboard: 'copy' },
	paste: { icon: 'clippy', clipboard: 'paste' },
};

// Menu sheet tiles: the three drawers, then actions. `terminal` and `ai` toggle.
const MENU_DEFS = {
	editor: { icon: 'code', label: 'menu.editor', view: 'editor' },
	files: { icon: 'files', label: 'menu.files' },
	terminal: { icon: 'terminal', label: 'menu.terminal', view: 'terminalDock' },
	ai: { icon: 'extensions', label: 'menu.ai', view: 'ai' },
	quickOpen: { icon: 'go-to-file', label: 'menu.quickOpen', action: 'quickOpen' },
	palette: { icon: 'terminal-cmd', label: 'menu.palette', action: 'commandPalette' },
	save: { icon: 'save', label: 'menu.save', action: 'save' },
	undo: { icon: 'discard', label: 'menu.undo', action: 'undo' },
	redo: { icon: 'redo', label: 'menu.redo', action: 'redo' },
	find: { icon: 'search', label: 'menu.find', action: 'find' },
	extensions: { icon: 'extensions', label: 'menu.extensions', manage: true },
};
const DEFAULT_MENU = ['files', 'terminal', 'ai', 'quickOpen', 'palette', 'save', 'undo', 'redo'];

// What each view looks like, as the set of VS Code parts that must be visible.
const VIEW_PARTS = {
	editor: ['editor'],
	terminalDock: ['editor', 'panel'],
	ai: ['auxiliarybar'],
};

// The bar laid over the title strip of a drawer's part: [icon, label, action].
// `side` is where the drawer comes from, and so which way it closes. `agents`: the
// title picks which extension's views the drawer shows; their own title buttons stay visible.
const VIEW_BARS = {
	terminalDock: { part: 'panel', title: 'view.terminal', side: 'bottom', actions: [['clippy', 'action.paste', 'pasteTerminal'], ['add', 'action.newTerminal', 'newTerminal'], ['trash', 'action.killTerminal', 'killTerminal']] },
	ai: { part: 'auxiliarybar', title: 'view.ai', side: 'right', agents: true, actions: [['copy', 'action.copy', 'copy'], ['clippy', 'action.paste', 'paste'], ['attach', 'action.attach', 'uploadImage'], ['mic', 'action.voice', 'voice']] },
};
// Bar actions the layer handles itself instead of a VS Code command.
const LAYER_ACTIONS = { voice: () => toggleVoice(), uploadImage: () => chooseImage(), copy: () => copySelection(), paste: () => pasteClipboard(), pasteTerminal: () => pasteToTerminal() };

const state = {
	config: null,
	commands: null,
	selectors: null,
	view: 'editor',
	sticky: { ctrlKey: false, altKey: false, shiftKey: false },
	keysOn: false, // accessory keys: a text input has focus and the keyboard is up
	lastInput: null,
	bridge: false,
	folder: null, // { name, path }
	activePath: null,
	tree: new Map(), // dir path → { entries, open }
	picker: null, // { path, parent, entries } while choosing a folder
	drawerOpen: false,
	menuOpen: false,
	viewbarFor: null,
	fab: loadFab(),
	networkOnline: true,
	agents: null,
	agentsLoading: null,
	managerStandalone: false,
	previewOpen: false, // a localhost page shown over the code view
	devices: null, // { current, devices: [{ id, name, online }] } when other PCs are set up
};

// ---------------------------------------------------------------- bridge + fs

async function api(path, { method = 'GET', body } = {}) {
	const res = await fetch(path, {
		method,
		headers: { 'x-handide': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return res.json();
}

function chooseImage() {
	if (!state.bridge) return toast(t('img.needExt'));
	document.getElementById('hd-image-input')?.click();
}

async function uploadImage(file) {
	if (!file) return;
	if (file.size > 15 * 1024 * 1024) return toast(t('img.tooBig'));
	toast(t('img.saving'));
	try {
		const data = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result).split(',')[1]);
			reader.onerror = () => reject(reader.error || new Error('read failed'));
			reader.readAsDataURL(file);
		});
		const saved = await bridgeCall('handide.upload', { name: file.name || 'screenshot.png', data });
		if (!saved?.relative) return toast(t('img.saveFailed'));
		const reference = t('img.reference', saved.relative);
		const target = document.querySelector(state.selectors.chatInput);
		if (target?.getBoundingClientRect().width) {
			pasteInto(target, reference);
			toast(t('img.inserted', saved.relative));
		} else {
			showUploaded(saved.relative, reference);
		}
	} catch (err) {
		toast(t('img.failed', err.message));
	}
}

// Extension agents draw their input inside a webview the layer cannot type into. iOS only
// lets a page write the clipboard during a tap, and the upload has awaited by now, so the
// path stays on screen until a tap copies it.
function showUploaded(relative, reference) {
	const pill = document.getElementById('hd-upload');
	pill.replaceChildren(el('strong', {}, t('img.tapToCopy')), el('small', {}, relative));
	pill.hidden = false;
	pill.onclick = async () => {
		pill.hidden = true;
		try {
			await navigator.clipboard.writeText(reference);
			toast(t('img.copied'));
		} catch {
			openInputSheet();
			const box = document.querySelector('#hd-sheet textarea, #hd-sheet input');
			if (box) box.value = reference;
		}
	};
}

/** Runs a VS Code command with arguments through the companion extension. */
async function bridgeCall(command, ...args) {
	try {
		const r = await api(`${BASE}bridge/call`, { method: 'POST', body: { command, args } });
		if (!r.ok) throw new Error(r.error);
		state.bridge = true;
		return r.result;
	} catch (err) {
		console.warn(`[handide] ${command}: ${err.message}`);
		return undefined;
	}
}

async function waitForBridge() {
	for (let i = 0; i < 40; i++) {
		const s = await api(`${BASE}bridge/status`).catch(() => ({}));
		if (s.connected) return (state.bridge = true);
		await new Promise((r) => setTimeout(r, 1500));
	}
	return false;
}

async function refreshState() {
	const s = await bridgeCall('handide.state');
	if (!s) return;
	const folder = s.folders?.[0] ?? null;
	const changed = folder?.path !== state.folder?.path;
	state.folder = folder;
	state.activePath = s.active?.path ?? null;
	if (changed) {
		state.tree.clear();
		if (folder) await loadDir(folder.path, true);
	}
	renderDrawer();
	renderMenuHead();
}

/**
 * The open folder as the page itself knows it: ?folder= after a folder switch,
 * otherwise the workbench configuration VS Code embeds in the page. Lets the drawer
 * work before (or without) the companion extension.
 */
function pageFolder() {
	let p = new URLSearchParams(location.search).get('folder');
	if (!p) {
		try {
			p = JSON.parse(document.getElementById('vscode-workbench-web-configuration').dataset.settings).folderUri?.path;
		} catch {
			// no configuration: nothing to show yet
		}
	}
	if (!p) return null;
	p = decodeURIComponent(p);
	if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replaceAll('/', '\\'); // "/c:/Users/x" → "c:\Users\x"
	return { name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p };
}

async function loadDir(path, open) {
	const r = await api(`${BASE}fs?path=${encodeURIComponent(path)}`).catch(() => null);
	if (!r?.ok) return;
	state.tree.set(path, { entries: r.entries, open: open ?? state.tree.get(path)?.open ?? false });
}

// ---------------------------------------------------------------- keys → VS Code

function keyCodeOf(key) {
	if (/^F\d+$/.test(key)) return 111 + Number(key.slice(1));
	if (key.length === 1) return key.toUpperCase().charCodeAt(0);
	return 0;
}

/** Sends a synthetic keydown that VS Code's keybinding service resolves like a real one. */
function sendKey({ key, keyCode = keyCodeOf(key), code = key, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false, target }) {
	const el = target || focusTarget();
	for (const type of ['keydown', 'keyup']) {
		const e = new KeyboardEvent(type, { key, code, ctrlKey, altKey, shiftKey, metaKey, bubbles: true, cancelable: true });
		Object.defineProperty(e, 'keyCode', { get: () => keyCode });
		Object.defineProperty(e, 'which', { get: () => keyCode });
		el.dispatchEvent(e);
	}
}

const LAYER_UI = '#hd-root, #hd-fab, #hd-menu, #hd-drawer, #hd-viewbar';

function focusTarget() {
	const active = document.activeElement;
	if (active && active !== document.body && !active.closest(LAYER_UI)) return active;
	if (state.lastInput?.isConnected) return state.lastInput;
	return document.querySelector(state.selectors.workbench) || document.body;
}

function chord(key) {
	const [ctrl, alt, shift] = ['ctrl', 'alt', 'shift'].map((m) => state.commands.modifiers.includes(m));
	sendKey({ key, ctrlKey: ctrl, altKey: alt, shiftKey: shift });
}

// Fallback when the companion extension can't be used (companion.mode = "builtin"):
// VS Code's own default shortcuts. Areas open, but not in the phone layout.
const APPLE = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const k = (key, code, keyCode, mods) => ({ key, code, keyCode, ...mods });
const MOD = APPLE ? { metaKey: true } : { ctrlKey: true };
const BUILTIN_VIEWS = {
	editor: k('1', 'Digit1', 49, MOD),
	terminalDock: k('`', 'Backquote', 192, { ctrlKey: true }),
	ai: APPLE ? k('I', 'KeyI', 73, { ctrlKey: true, metaKey: true }) : k('I', 'KeyI', 73, { ctrlKey: true, altKey: true }),
};
const BUILTIN_ACTIONS = {
	quickOpen: k('P', 'KeyP', 80, MOD),
	commandPalette: k('P', 'KeyP', 80, { ...MOD, shiftKey: true }),
	save: k('S', 'KeyS', 83, MOD),
	undo: k('Z', 'KeyZ', 90, MOD),
	redo: APPLE ? k('Z', 'KeyZ', 90, { metaKey: true, shiftKey: true }) : k('Y', 'KeyY', 89, { ctrlKey: true }),
	find: k('F', 'KeyF', 70, MOD),
	newTerminal: k('`', 'Backquote', 192, { ctrlKey: true, shiftKey: true }),
};
// VS Code's default toggles, which work even in Restricted Mode (companion off).
// Toggles: sent only for a part the DOM shows as open.
const CLOSE_PART_KEYS = {
	sidebar: k('B', 'KeyB', 66, MOD),
	auxiliarybar: k('B', 'KeyB', 66, { ...MOD, altKey: true }),
	panel: k('J', 'KeyJ', 74, MOD),
};
const builtin = () => state.config.companion?.mode === 'builtin';

function runAction(name) {
	if (builtin()) {
		if (BUILTIN_ACTIONS[name]) sendKey(BUILTIN_ACTIONS[name]);
		return;
	}
	const action = state.commands.actions[name];
	if (!action) return;
	if (state.bridge) bridgeCall(action.command);
	else if (action.key) chord(action.key);
}

// ---------------------------------------------------------------- views

function visiblePart(name) {
	const el = document.querySelector(state.selectors.parts[name]);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
}
const visibleParts = () => Object.keys(state.selectors.parts).filter(visiblePart);

function showView(view) {
	state.view = view;
	// While VS Code carries out the switch, the layout is in between: don't let
	// syncViewFromLayout read that as the user closing something.
	state.settlingUntil = Date.now() + 4500;
	closeDrawer();
	closeMenu();
	render();
	if (builtin()) {
		// Ctrl+` toggles the terminal: pressing it again while it is open would close it.
		const terminalAlreadyOpen = view === 'terminalDock' && visiblePart('panel');
		if (BUILTIN_VIEWS[view] && !terminalAlreadyOpen) sendKey(BUILTIN_VIEWS[view]);
		return;
	}
	if (state.bridge) bridgeCall('handide.view', { view });
	else if (state.commands.tabs[view]) chord(state.commands.tabs[view]);
	settleView(view);
	if (view === 'editor') setTimeout(() => focusTarget().focus?.(), 200);
}

// The extension opens the right areas with idempotent commands. Whether the panel
// fills the screen is a toggle only the DOM reveals, so the layer finishes the job:
// it toggles "maximize panel" only when the panel is open but the layout is wrong,
// and never again until the layout visibly changed (so it can't undo its own toggle).
function settleView(view) {
	const want = VIEW_PARTS[view];
	if (!want) return;
	const started = Date.now();
	let resent = false;
	let toggledAt = 0;
	let layoutAtToggle = '';
	const tick = () => {
		if (state.view !== view || Date.now() - started > 4000) return;
		const shown = visibleParts();
		const key = shown.join(',');
		if (want.length === shown.length && want.every((p) => shown.includes(p))) {
			state.settlingUntil = 0; // done
			return;
		}
		if (want.includes('panel') && shown.includes('panel')) {
			const needMax = !want.includes('editor') && shown.includes('editor');
			const needRestore = want.includes('editor') && !shown.includes('editor');
			if ((needMax || needRestore) && (!toggledAt || (key !== layoutAtToggle && Date.now() - toggledAt > 600))) {
				toggledAt = Date.now();
				layoutAtToggle = key;
				runAction('toggleMaximizedPanel');
			}
		} else if (!resent && Date.now() - started > 1200) {
			resent = true;
			if (state.bridge) bridgeCall('handide.view', { view });
			else if (state.commands.tabs[view]) chord(state.commands.tabs[view]);
		}
		setTimeout(tick, 300);
	};
	setTimeout(tick, 300);
}

/**
 * Keeps the screen to the code plus at most the drawer the user opened, whatever VS Code
 * does by itself: it restores its saved layout (side bar, panel and chat side by side)
 * when the folder is trusted, and extensions reveal their views. A drawer VS Code
 * closed is followed; anything VS Code opened is closed again.
 */
let lastEnforced = 0;
let recheck = 0;
/** Looks again once a pause is over, even if nothing in the DOM changes by then. */
function syncLater(at) {
	clearTimeout(recheck);
	recheck = setTimeout(syncViewFromLayout, Math.max(0, at - Date.now()) + 50);
}
function syncViewFromLayout() {
	if (Date.now() < (state.settlingUntil || 0)) return syncLater(state.settlingUntil);
	const shown = visibleParts();
	let view = state.view;
	if (view === 'terminalDock' && !shown.includes('panel') && shown.includes('editor')) view = 'editor';
	if (view === 'ai' && !shown.includes('auxiliarybar') && shown.includes('editor')) view = 'editor';
	const stray = shown.filter((p) => !VIEW_PARTS[view].includes(p) && CLOSE_PART_KEYS[p]);
	if (view !== state.view) {
		state.view = view;
		render();
	}
	if (!stray.length) return;
	if (Date.now() - lastEnforced < 3000) return syncLater(lastEnforced + 3000);
	// Not while the user is in quick open or a dialog: the keys would take their focus.
	const busy = [state.selectors.quickInput, state.selectors.dialog].some((s) => document.querySelector(s)?.getBoundingClientRect().height > 0);
	if (busy) return syncLater(Date.now() + 1000);
	lastEnforced = Date.now();
	syncLater(lastEnforced + 3000); // confirm it worked
	if (state.bridge && !builtin()) return showView(view);
	// No companion (Restricted Mode, or builtin mode): close them with VS Code's own keys.
	for (const part of stray) sendKey({ ...CLOSE_PART_KEYS[part], target: document.querySelector(state.selectors.workbench) });
}

function pressMenu(name) {
	const def = MENU_DEFS[name];
	closeMenu();
	if (name === 'files') return openDrawer();
	if (def.manage) return openExtensionManager();
	if (def.view) return showView(state.view === def.view ? 'editor' : def.view);
	if (def.action) runAction(def.action);
}

// ---------------------------------------------------------------- sticky modifiers

function consumeSticky() {
	const mods = { ...state.sticky };
	state.sticky = { ctrlKey: false, altKey: false, shiftKey: false };
	render();
	return mods;
}

const anySticky = () => state.sticky.ctrlKey || state.sticky.altKey || state.sticky.shiftKey;

// Soft keyboards report keyCode 229 for letters, so sticky Ctrl/Alt is applied at
// the `beforeinput` stage: the typed character becomes a chord instead of text.
function onBeforeInput(e) {
	if (!anySticky() || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
	e.preventDefault();
	e.stopImmediatePropagation();
	const mods = consumeSticky();
	const ch = e.data;
	sendKey({ key: ch.toLowerCase(), code: `Key${ch.toUpperCase()}`, keyCode: keyCodeOf(ch), ...mods, target: e.target });
}

// ---------------------------------------------------------------- input sheet

/** @param {{ terminal?: boolean }} [opts] terminal: send the text to the terminal's shell */
function openInputSheet(opts = {}) {
	const target = focusTarget();
	// A synthetic paste into the terminal goes missing on iOS; the shell gets it from VS Code instead.
	const toTerminal = state.bridge && (opts.terminal || target?.classList?.contains('xterm-helper-textarea'));
	const sheet = document.getElementById('hd-sheet');
	const area = sheet.querySelector('textarea');
	sheet.hidden = false;
	area.value = '';
	area.placeholder = t(opts.terminal ? 'sheet.terminal' : 'sheet.placeholder');
	area.focus();
	render();
	sheet.onsubmit = (e) => {
		e.preventDefault();
		sheet.hidden = true;
		if (area.value && toTerminal) bridgeCall('workbench.action.terminal.sendSequence', { text: area.value });
		else if (area.value) pasteInto(target, area.value);
		render();
	};
}

function closeInputSheet() {
	document.getElementById('hd-sheet').hidden = true;
	render();
}

/**
 * Inserts text at the cursor.
 * - Editor using EditContext (current Chrome, desktop and Android): a `textupdate`,
 *   the same path the soft keyboard uses. A synthetic paste is *accepted* there but
 *   inserts nothing on Android Chrome, so it is not used for the editor.
 * - Anything else (terminal, VS Code inputs, browsers without EditContext): a paste.
 */
function pasteInto(target, text) {
	target.focus?.();
	let how;
	const ec = target.editContext;
	if (ec && typeof TextUpdateEvent === 'function') {
		const start = ec.selectionStart;
		const caret = start + text.length;
		ec.dispatchEvent(new TextUpdateEvent('textupdate', { text, updateRangeStart: start, updateRangeEnd: ec.selectionEnd, selectionStart: caret, selectionEnd: caret }));
		how = 'textupdate';
	} else {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		const handled = !target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		how = `paste handled=${handled}`;
	}
	// Breadcrumb for `npm run check` when an insert goes missing.
	document.documentElement.dataset.hdLastPaste = `${target.tagName}.${[...(target.classList || [])].join('.')} ${how}`;
}

// ---------------------------------------------------------------- menu sheet

function openMenu() {
	closeDrawer();
	state.menuOpen = true;
	document.documentElement.classList.add('hd-menu-open');
	document.activeElement?.blur?.(); // no soft keyboard under the sheet
	renderMenuHead();
	render();
	loadDevices(); // their online state may have changed since
}

function closeMenu() {
	if (!state.menuOpen) return;
	state.menuOpen = false;
	document.getElementById('hd-settings')?.setAttribute('hidden', '');
	document.getElementById('hd-menu').dataset.panel = '';
	document.documentElement.classList.remove('hd-menu-open');
	render();
}


// Language (gear in the menu head) and the panel it opens.
function setLang(code) {
	if (!STRINGS[code] || code === lang) return;
	lang = code;
	try {
		localStorage.setItem('handide.lang', code);
	} catch {}
	document.documentElement.lang = code;
	applyI18n();
	for (const b of document.querySelectorAll('#hd-settings [data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
	state.viewbarFor = null; // the view bar would keep its previous strings
	render();
	renderDrawer();
	renderMenuHead();
	renderDevices();
	if (voice.rec) renderVoice();
}

function toggleSettings() {
	const panel = document.getElementById('hd-settings');
	if (!panel) return;
	const open = panel.hidden;
	panel.hidden = !open;
	document.getElementById('hd-menu').dataset.panel = open ? 'settings' : '';
	document.querySelector('#hd-menu [data-act="settings"]')?.setAttribute('aria-expanded', String(open));
}

function buildSettings() {
	const langs = Object.entries(LANGS).map(([code, name]) =>
		button({ class: 'hd-lang', 'data-lang': code, 'aria-pressed': String(code === lang) }, name, () => setLang(code)),
	);
	return el(
		'div',
		{ id: 'hd-settings', hidden: true },
		el('span', { class: 'hd-settings-label', 'data-i18n': 'settings.language' }, t('settings.language')),
		el('div', { class: 'hd-lang-list' }, langs),
	);
}

function renderMenuHead() {
	const folder = document.getElementById('hd-menu-folder');
	const pc = currentDevice();
	if (folder) folder.textContent = [pc?.name, state.folder?.name].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- other PCs
//
// With other PCs set up ("handide devices add"), the PC this link belongs to relays the
// page to the one picked here (proxy/devices.mjs). Switching is a plain navigation, so
// it reloads the editor of that PC with its own folder, terminals and extensions.

const currentDevice = () => (state.devices?.devices.length > 1 ? state.devices.devices.find((d) => d.id === state.devices.current) : null);

async function loadDevices() {
	const r = await api(`${BASE}devices`).catch(() => null);
	state.devices = r?.ok ? r : null;
	renderDevices();
	renderMenuHead();
}

function renderDevices() {
	const box = document.getElementById('hd-devices');
	if (!box) return;
	const list = state.devices?.devices ?? [];
	box.hidden = list.length < 2;
	box.replaceChildren(
		el('span', { class: 'hd-settings-label', 'data-i18n': 'devices.label' }, t('devices.label')),
		el(
			'div',
			{ class: 'hd-device-list' },
			list.map((d) =>
				button(
					{ class: 'hd-device', 'aria-pressed': String(d.id === state.devices.current), 'data-online': String(d.online) },
					[icon('vm'), el('span', {}, d.name), d.online ? null : el('small', {}, t('devices.offline'))],
					() => useDevice(d),
				),
			),
		),
	);
}

function useDevice(d) {
	if (d.id === state.devices.current) return closeMenu();
	if (!d.online) return toast(t('devices.unreachable', d.name));
	toast(t('devices.switching', d.name));
	location.href = `${BASE}devices/use?id=${encodeURIComponent(d.id)}`;
}

// ---------------------------------------------------------------- drawer

function openDrawer() {
	closeMenu();
	state.drawerOpen = true;
	document.documentElement.classList.add('hd-drawer-open');
	document.activeElement?.blur?.(); // no soft keyboard over the tree
	refreshState();
	render();
}

function closeDrawer() {
	if (!state.drawerOpen) return;
	state.drawerOpen = false;
	state.picker = null;
	document.documentElement.classList.remove('hd-drawer-open');
	render();
}

const samePath = (a, b) => !!a && !!b && (APPLE || !/^[a-z]:/i.test(a) ? a === b : a.toLowerCase() === b.toLowerCase());

async function toggleDir(path) {
	const node = state.tree.get(path);
	if (node) node.open = !node.open;
	else await loadDir(path, true);
	// New files and folders go into the folder opened last.
	state.targetDir = state.tree.get(path)?.open ? path : parentOf(path);
	renderDrawer();
}

/** New file or folder in the folder opened last (or the root); the name may contain subfolders. */
async function createEntry(folder) {
	const root = state.folder?.path;
	if (!root) return;
	if (!state.bridge) return toast(t('need.create'));
	const dir = state.targetDir && state.targetDir.toLowerCase().startsWith(root.toLowerCase()) ? state.targetDir : root;
	const where = dir === root ? state.folder.name : `${state.folder.name}${dir.slice(root.length).replaceAll('\\', '/')}`;
	const name = window.prompt(t(folder ? 'prompt.newFolder' : 'prompt.newFile', where), '')?.trim();
	if (!name) return;
	const sep = dir.includes('\\') ? '\\' : '/';
	const target = `${dir.replace(/[\\/]$/, '')}${sep}${name.replace(/[\\/]+/g, sep)}`;
	const r = await bridgeCall('handide.create', { path: target, folder });
	if (!r) return toast(t('create.failed', name));
	await loadDir(dir, true);
	if (folder) {
		await loadDir(target, true);
		state.targetDir = target;
		renderDrawer();
		return;
	}
	state.activePath = target;
	closeDrawer();
	if (state.view !== 'editor' && state.view !== 'terminalDock') showView('editor');
}

async function openFile(path) {
	if (!state.bridge) return toast(t('need.open'));
	closeDrawer();
	closePreview(); // opening a file means the code
	await bridgeCall('vscode.open', { $file: path });
	state.activePath = path;
	if (state.view !== 'editor' && state.view !== 'terminalDock') showView('editor');
}

async function openPicker(path) {
	const r = await api(`${BASE}fs?path=${encodeURIComponent(path ?? '')}`).catch(() => null);
	if (!r?.ok) return toast(t('folder.unreadable'));
	state.picker = { path: r.path, parent: r.parent, entries: r.entries.filter((e) => e.dir) };
	renderDrawer();
}

async function openFolder(path) {
	if (!state.bridge) return toast(t('need.folder'));
	toast(t('folder.opening'));
	await bridgeCall('vscode.openFolder', { $file: path }, { forceReuseWindow: true });
}

/**
 * Activates on a real tap (pointer up close to where it went down), not on the
 * browser's synthesized click: VS Code's own touch gesture handler can end up
 * suppressing clicks page-wide, and a scroll in the drawer must not open a file.
 * Keyboard activation (click with detail 0) still works.
 */
function onTap(node, fn) {
	let down = null;
	node.addEventListener('pointerdown', (e) => {
		down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
	});
	node.addEventListener('pointerup', (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId || Date.now() - d.t > 700) return;
		if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
		e.preventDefault();
		fn(e);
	});
	node.addEventListener('pointercancel', () => (down = null));
	node.addEventListener('click', (e) => {
		if (e.detail === 0) fn(e); // keyboard; pointer taps were handled on pointerup
		e.preventDefault();
	});
}

function el(tag, attrs = {}, ...children) {
	const e = document.createElement(tag);
	for (const [key, v] of Object.entries(attrs)) {
		if (key === 'class') e.className = v;
		else if (key === 'onclick') onTap(e, v);
		else if (key.startsWith('on')) e.addEventListener(key.slice(2), v);
		else if (v !== false && v != null) e.setAttribute(key, v === true ? '' : v);
	}
	for (const c of children.flat()) if (c != null) e.append(c);
	return e;
}
const icon = (name) => el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });

function renderDrawer() {
	const body = document.getElementById('hd-drawer-body');
	const head = document.getElementById('hd-drawer-head');
	if (!body || !head) return;
	head.replaceChildren();
	body.replaceChildren();

	if (state.picker) {
		const { path, parent, entries } = state.picker;
		head.append(
			el('div', { class: 'hd-drawer-title' }, el('strong', {}, t('drawer.selectFolder')), el('small', {}, path || t('word.drives'))),
			el('button', { class: 'hd-icon-btn', 'aria-label': t('action.cancel'), onclick: () => ((state.picker = null), renderDrawer()) }, icon('close')),
		);
		if (parent !== null) body.append(row({ depth: 0, iconName: 'arrow-up', label: t('drawer.parent'), onclick: () => openPicker(parent) }));
		for (const e of entries) body.append(row({ depth: 0, iconName: 'folder', label: e.name, onclick: () => openPicker(e.path) }));
		if (!entries.length) body.append(el('p', { class: 'hd-empty' }, t('drawer.noSubfolders')));
		if (path) body.append(el('div', { class: 'hd-picker-actions' }, el('button', { class: 'hd-primary', onclick: () => openFolder(path) }, t('drawer.openHere'))));
		return;
	}

	const folder = state.folder;
	head.append(
		el('div', { class: 'hd-drawer-title' }, el('strong', {}, folder?.name ?? t('drawer.noFolder')), el('small', {}, folder?.path ?? '')),
		folder ? el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.uploadImage'), title: t('aria.uploadImage'), onclick: chooseImage }, icon('file-media')) : null,
		folder ? el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.newFile'), 'data-act': 'newFile', onclick: () => createEntry(false) }, icon('new-file')) : null,
		folder ? el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.newFolder'), 'data-act': 'newFolder', onclick: () => createEntry(true) }, icon('new-folder')) : null,
		el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.changeFolder'), 'data-act': 'changeFolder', title: t('aria.changeFolder'), onclick: () => openPicker(folder ? parentOf(folder.path) : '') }, icon('folder-opened')),
		el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.refresh'), onclick: async () => { state.tree.clear(); if (folder) await loadDir(folder.path, true); renderDrawer(); } }, icon('refresh')),
		el('button', { class: 'hd-icon-btn', 'aria-label': t('aria.close'), onclick: closeDrawer }, icon('close')),
	);
	if (!folder) {
		body.append(
			el('p', { class: 'hd-empty' }, state.bridge ? t('drawer.empty') : t('drawer.waiting')),
			el('div', { class: 'hd-picker-actions' }, el('button', { class: 'hd-primary', onclick: () => openPicker('') }, t('drawer.openFolder'))),
		);
		return;
	}
	const walk = (dir, depth) => {
		const node = state.tree.get(dir);
		if (!node?.open) return;
		for (const e of node.entries.slice(0, 500)) {
			const open = e.dir && state.tree.get(e.path)?.open;
			body.append(
				row({
					depth,
					iconName: e.dir ? (open ? 'chevron-down' : 'chevron-right') : 'file',
					label: e.name,
					dim: e.name.startsWith('.'),
					active: !e.dir && samePath(e.path, state.activePath),
					onclick: () => (e.dir ? toggleDir(e.path) : openFile(e.path)),
				}),
			);
			if (open) walk(e.path, depth + 1);
		}
		if (node.entries.length > 500) body.append(el('p', { class: 'hd-empty' }, t('drawer.more', node.entries.length - 500)));
	};
	walk(folder.path, 0);
}

function parentOf(path) {
	const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
	if (i <= 0) return '';
	const p = path.slice(0, i);
	return /^[a-z]:$/i.test(p) ? `${p}\\` : p;
}

function row({ depth, iconName, label, onclick, dim, active }) {
	return el(
		'button',
		{ class: `hd-row${dim ? ' dim' : ''}${active ? ' active' : ''}`, style: `padding-left:${16 + depth * 14}px`, onclick },
		icon(iconName),
		el('span', { class: 'hd-row-label' }, label),
	);
}

// ---------------------------------------------------------------- gestures

// Left edge swipe opens the file drawer, right edge swipe the AI drawer; each closes by
// swiping back the way it came (the AI drawer on its bar or from the left edge), and
// the menu sheet and the terminal's grab bar close when swiped down. Touches that
// belong to the layer are kept from VS Code's own gesture handler: a swipe that starts
// on the editor and ends over a layer element would otherwise leave it thinking a
// finger is still down, and it then swallows every following tap.
function installGestures() {
	let start = null;
	const ours = (e) => !!e.target.closest?.('#hd-drawer, #hd-scrim, #hd-menu, #hd-menu-scrim, #hd-fab, #hd-viewbar');
	const edge = (z) => z === 'leftEdge' || z === 'rightEdge';
	const zoneOf = (e, t) => {
		if (e.touches.length !== 1) return null;
		const free = !state.drawerOpen && !state.menuOpen;
		if (free && t.clientX < 18) return 'leftEdge';
		if (free && t.clientX > document.documentElement.clientWidth - 18 && state.view !== 'ai') return 'rightEdge';
		if (state.drawerOpen && e.target.closest('#hd-drawer, #hd-scrim')) return 'drawer';
		if (state.menuOpen && e.target.closest('#hd-menu')) return 'menu';
		if (e.target.closest('#hd-viewbar')) return VIEW_BARS[state.view]?.side ?? null;
		return null;
	};
	document.addEventListener(
		'touchstart',
		(e) => {
			const t = e.touches[0];
			const zone = zoneOf(e, t);
			start = zone ? { x: t.clientX, y: t.clientY, zone } : null;
			if (edge(start?.zone) || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchmove',
		(e) => {
			if (edge(start?.zone) || ours(e)) e.stopPropagation();
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		'touchend',
		(e) => {
			const s0 = start;
			start = null;
			if (edge(s0?.zone) || ours(e)) e.stopPropagation();
			if (!s0) return;
			const t = e.changedTouches[0];
			const dx = t.clientX - s0.x;
			const dy = t.clientY - s0.y;
			const sideways = Math.abs(dy) < 60;
			const downward = Math.abs(dx) < 80;
			if (s0.zone === 'leftEdge' && dx > 50 && sideways) state.view === 'ai' ? showView('editor') : openDrawer();
			else if (s0.zone === 'rightEdge' && dx < -50 && sideways) showView('ai');
			else if (s0.zone === 'drawer' && dx < -60 && sideways) closeDrawer();
			else if (s0.zone === 'menu' && dy > 60 && downward) closeMenu();
			else if (s0.zone === 'bottom' && dy > 40 && downward) showView('editor');
			else if (s0.zone === 'right' && dx > 50 && sideways) showView('editor');
		},
		{ passive: true, capture: true },
	);
}

// ---------------------------------------------------------------- floating button

const FAB_SIZE = 52;
const FAB_MARGIN = 12;

function loadFab() {
	try {
		const f = JSON.parse(localStorage.getItem('handide.fab'));
		if ((f?.side === 'left' || f?.side === 'right') && f.y >= 0 && f.y <= 1) return f;
	} catch {
		// unreadable: default position
	}
	return { side: 'right', y: 0.72 };
}

/** The band the button may sit in: between the top inset and our bottom bars. */
function fabBand() {
	const top = (vv?.offsetTop || 0) + reservedTop + FAB_MARGIN;
	let bottom = (vv?.offsetTop || 0) + realViewportHeight() - reservedBottom - FAB_SIZE - FAB_MARGIN;
	// Above the terminal drawer, off its grab bar.
	const bar = document.getElementById('hd-viewbar');
	if (VIEW_BARS[state.view]?.side === 'bottom' && bar && !bar.hidden) bottom = Math.min(bottom, bar.getBoundingClientRect().top - FAB_SIZE - FAB_MARGIN);
	return { top, bottom: Math.max(top, bottom), width: document.documentElement.clientWidth };
}

function placeFab() {
	const fab = document.getElementById('hd-fab');
	if (!fab || fab.dataset.dragging) return;
	const band = fabBand();
	fab.style.left = `${state.fab.side === 'left' ? FAB_MARGIN : band.width - FAB_SIZE - FAB_MARGIN}px`;
	fab.style.top = `${Math.round(band.top + state.fab.y * (band.bottom - band.top))}px`;
}

// Tap opens the menu; dragging moves the button, which then snaps to the nearest side.
function installFab(fab) {
	let down = null;
	fab.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		const r = fab.getBoundingClientRect();
		down = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, t: Date.now(), moved: false };
		fab.setPointerCapture?.(e.pointerId);
	});
	fab.addEventListener('pointermove', (e) => {
		if (!down || down.id !== e.pointerId) return;
		if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return;
		down.moved = true;
		fab.dataset.dragging = '1';
		const band = fabBand();
		fab.style.left = `${Math.min(band.width - FAB_SIZE, Math.max(0, e.clientX - down.dx))}px`;
		fab.style.top = `${Math.min(band.bottom, Math.max(band.top, e.clientY - down.dy))}px`;
	});
	const end = (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId) return;
		delete fab.dataset.dragging;
		if (!d.moved) {
			if (e.type === 'pointerup' && Date.now() - d.t < 700) openMenu();
			return;
		}
		const r = fab.getBoundingClientRect();
		const band = fabBand();
		state.fab = {
			side: r.left + r.width / 2 < band.width / 2 ? 'left' : 'right',
			y: band.bottom > band.top ? Math.min(1, Math.max(0, (r.top - band.top) / (band.bottom - band.top))) : 0,
		};
		localStorage.setItem('handide.fab', JSON.stringify(state.fab));
		placeFab();
	};
	fab.addEventListener('pointerup', end);
	fab.addEventListener('pointercancel', end);
	fab.addEventListener('click', (e) => {
		if (e.detail === 0) openMenu(); // keyboard
		e.preventDefault();
	});
}

// ---------------------------------------------------------------- view bar

// Laid exactly over the title strip of the part the view shows, so VS Code's desktop
// tabs and buttons there are covered by a phone header. Sized from the DOM only.
function renderViewbar() {
	const bar = document.getElementById('hd-viewbar');
	const key = `${state.view}:${state.bridge}`;
	if (!bar || state.viewbarFor === key) return;
	state.viewbarFor = key;
	const def = VIEW_BARS[state.view];
	bar.replaceChildren();
	bar.classList.toggle('hd-grab', def?.side === 'bottom');
	if (!def) return;
	if (def.side === 'bottom') bar.append(el('span', { class: 'hd-grip', 'aria-hidden': 'true' }));
	bar.append(
		button({ class: 'hd-icon-btn', 'aria-label': t('aria.close'), 'data-act': 'back' }, icon(def.side === 'bottom' ? 'chevron-down' : 'chevron-right'), () => showView('editor')),
		def.agents && state.bridge
			? button({ class: 'hd-viewbar-title hd-agent-btn', 'aria-label': t('aria.pickAgent'), 'data-act': 'agents' }, [el('span', { class: 'hd-agent-name' }, partLabel(def) || t(def.title)), icon('chevron-down')], toggleAgents)
			: el('span', { class: 'hd-viewbar-title' }, t(def.title)),
		...def.actions.map(([iconName, label, action]) =>
			button({ class: 'hd-icon-btn', 'aria-label': t(label), 'data-act': action }, icon(iconName), () => (LAYER_ACTIONS[action] ? LAYER_ACTIONS[action]() : runAction(action))),
		),
	);
	renderVoice();
	if (def.agents && state.bridge) {
		// How many there are to switch between, so the pill does not read as a lone title.
		loadAgents().then((items) => {
			const btn = bar.querySelector('[data-act="agents"]');
			if (btn && items?.length > 1) btn.dataset.count = t('count.views', items.length);
		});
	}
}

function loadAgents() {
	if (state.agents) return Promise.resolve(state.agents);
	if (!state.agentsLoading) {
		state.agentsLoading = bridgeCall('handide.extensionViews')
			.then((items) => (state.agents = items || []))
			.finally(() => (state.agentsLoading = null));
	}
	return state.agentsLoading;
}

// Phones offer no paste inside the terminal (xterm draws it; iOS shows no paste menu).
// The clipboard goes to the shell with VS Code's own "send sequence"; where the browser
// will not hand the clipboard over, the text box opens to paste into by hand.
async function pasteToTerminal() {
	let text = null;
	try {
		text = await navigator.clipboard.readText();
	} catch {}
	if (text == null) return openInputSheet({ terminal: true });
	if (!text) return toast(t('clip.empty'));
	await bridgeCall('workbench.action.terminal.sendSequence', { text });
}

function partLabel(def) {
	const sel = state.selectors.partTitleLabels?.[def.part];
	return (sel && document.querySelector(sel)?.textContent.trim()) || '';
}

// ---------------------------------------------------------------- agent picker (AI view)

// VS Code's activity bar and side bar tabs are hidden on the phone; this list of every
// extension's views (Claude Code, Codex, Chat, and primary side bar / panel ones) replaces them.
async function toggleAgents() {
	const list = document.getElementById('hd-agents');
	if (!list.hidden) return closeAgents();
	state.managerStandalone = false;
	const items = await loadAgents();
	if (!items.length) return toast(t('ext.listFailed'));
	const current = partLabel(VIEW_BARS.ai).toLowerCase();
	list.replaceChildren(
		...items.map((a) =>
			button(
				{ class: `hd-agent${current.includes(a.title.toLowerCase()) ? ' active' : ''}`, 'data-agent': a.id, 'data-moved': a.views ? '' : null },
				[el('span', {}, a.title), a.extension && a.extension !== a.title ? el('small', {}, a.extension) : null],
				() => {
					closeAgents();
					bridgeCall('handide.view', { view: 'ai', agent: a.id });
				},
			),
		),
		button({ class: 'hd-agent hd-agent-manage', 'data-agent': 'manage' }, [el('span', {}, t('ext.manageList')), el('small', {}, t('ext.manageHint'))], showInstalled),
	);
	const bar = document.getElementById('hd-viewbar').getBoundingClientRect();
	list.style.top = `${bar.bottom}px`;
	list.style.left = `${bar.left}px`;
	list.hidden = false;
	setTimeout(() => document.addEventListener('pointerdown', closeAgentsOutside, true));
}

// VS Code's Extensions view cannot leave the primary side bar, so the installed extensions
// are listed here; each opens its details page (enable/disable, uninstall, settings) as an editor.
async function showInstalled() {
	const list = document.getElementById('hd-agents');
	const items = (await bridgeCall('handide.installedExtensions')) || [];
	const manage = async (id, action) => {
		closeAgents();
		state.view = 'editor';
		render();
		const result = await bridgeCall('handide.manageExtension', { id, action });
		if (!result?.ok) toast(t(action === 'settings' ? 'ext.openSettingsFailed' : 'ext.openManageFailed'));
	};
	list.replaceChildren(
		button({ class: 'hd-agent hd-agent-manage', 'data-agent': 'back' }, el('span', {}, t('action.back')), () => {
			closeAgents();
			if (!state.managerStandalone) toggleAgents();
		}),
		button({ class: 'hd-agent', 'data-agent': 'install' }, [el('span', {}, t('ext.install')), el('small', {}, t('ext.installHint'))], () => {
			manage('', 'install');
		}),
		...items.map((x) =>
			button({ class: 'hd-agent', 'data-extension': x.id }, [el('span', {}, x.title), el('small', {}, x.enabled ? x.id : t('ext.disabled', x.id))], () => manage(x.id, 'details')),
		),
	);
	if (!items.length) list.append(el('p', { class: 'hd-empty' }, t('ext.none')));
}

async function openExtensionManager() {
	const list = document.getElementById('hd-agents');
	state.managerStandalone = true;
	list.style.top = `calc(env(safe-area-inset-top) + 8px)`;
	list.style.left = '8px';
	list.style.width = 'calc(100vw - 16px)';
	list.hidden = false;
	await showInstalled();
	setTimeout(() => document.addEventListener('pointerdown', closeAgentsOutside, true));
}

function closeAgentsOutside(e) {
	if (!e.target.closest('#hd-agents, [data-act="agents"]')) closeAgents();
}

function closeAgents() {
	document.getElementById('hd-agents').hidden = true;
	document.removeEventListener('pointerdown', closeAgentsOutside, true);
}

// ---------------------------------------------------------------- voice input (AI chat)

// The browser's own speech recognition (Chrome: Google's service; Safari: Apple's).
// Final phrases go into the chat input at its cursor; the live transcript shows in a
// pill above it. Tap the mic again, or leave the AI view, to stop.
const voice = { rec: null, interim: '' };

function toggleVoice() {
	if (voice.rec) return stopVoice();
	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Recognition) return toast(t('voice.unsupported'));
	const rec = new Recognition();
	rec.lang = state.config.voiceLang || (navigator.language?.startsWith('ko') ? 'ko-KR' : navigator.language || 'en-US');
	rec.continuous = true;
	rec.interimResults = true;
	rec.onresult = (e) => {
		let interim = '';
		for (let i = e.resultIndex; i < e.results.length; i++) {
			const r = e.results[i];
			if (r.isFinal) insertVoiceText(r[0].transcript.trim());
			else interim += r[0].transcript;
		}
		voice.interim = interim;
		renderVoice();
	};
	rec.onerror = (e) => {
		if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast(t('voice.micDenied'));
		else if (e.error !== 'no-speech' && e.error !== 'aborted') toast(t('voice.error', e.error));
	};
	rec.onend = () => {
		if (voice.rec !== rec) return;
		voice.rec = null;
		voice.interim = '';
		renderVoice();
	};
	voice.rec = rec;
	voice.interim = '';
	try {
		rec.start();
	} catch (err) {
		voice.rec = null;
		toast(t('voice.startFailed', err.message));
	}
	renderVoice();
}

function stopVoice() {
	const rec = voice.rec;
	if (!rec) return;
	rec.stop(); // delivers the last final result, then 'end'
}

function insertVoiceText(text) {
	if (!text) return;
	const target = document.querySelector(state.selectors.chatInput);
	if (!target) {
		// Extension agents draw their input inside a webview the layer cannot type into.
		navigator.clipboard?.writeText(text).then(
			() => toast(t('voice.copied', text)),
			() => toast(text),
		);
		return;
	}
	const before = target.editContext ? target.editContext.text.slice(0, target.editContext.selectionStart) : target.value?.slice(0, target.selectionStart) ?? '';
	pasteInto(target, before && !/\s$/.test(before) ? ` ${text}` : text);
}

function renderVoice() {
	const listening = !!voice.rec;
	document.querySelector('#hd-viewbar [data-act="voice"]')?.classList.toggle('hd-listening', listening);
	const pill = document.getElementById('hd-voice');
	if (!pill) return;
	pill.hidden = !listening;
	pill.textContent = voice.interim || t('voice.listening');
}

function placeViewbar() {
	const bar = document.getElementById('hd-viewbar');
	if (!bar) return;
	const def = VIEW_BARS[state.view];
	const title = def && visiblePart(def.part) ? document.querySelector(state.selectors.partTitles[def.part]) : null;
	const r = title?.getBoundingClientRect();
	if (!r || r.width < 8 || r.height < 8) {
		bar.hidden = true;
		return;
	}
	let width = r.width;
	// Up to the view's first own button (the actions box itself stretches wider than its buttons).
	const actionsSel = state.selectors.partTitleActions?.[def.part];
	const lefts = actionsSel ? [...document.querySelectorAll(`${actionsSel} .action-item`)].map((a) => a.getBoundingClientRect()).filter((b) => b.width > 4).map((b) => b.left) : [];
	if (lefts.length) width = Math.max(Math.min(...lefts) - r.left, r.width / 2);
	if (def.agents) {
		const name = bar.querySelector('.hd-agent-name');
		const label = partLabel(def);
		if (name && label && name.textContent !== label) name.textContent = label;
	}
	const moved = bar.hidden || bar.style.top !== `${r.top}px`;
	bar.hidden = false;
	bar.style.top = `${r.top}px`;
	bar.style.left = `${r.left}px`;
	bar.style.width = `${width}px`;
	bar.style.height = `${r.height}px`;
	if (moved && def.side === 'bottom') placeFab();
}

let toastTimer;
function toast(text) {
	const t = document.getElementById('hd-toast');
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// ---------------------------------------------------------------- viewport

// VS Code sizes the workbench from window.innerHeight (visualViewport.height on
// iOS). Report the space between the top inset and our bottom bar, and push the
// workbench below the inset. Nothing inside VS Code is modified.
const vv = window.visualViewport;
const vvHeightDesc = vv && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height');
const realViewportHeight = () => (vvHeightDesc ? vvHeightDesc.get.call(vv) : document.documentElement.clientHeight);
let reservedTop = 0;
let reservedBottom = 0;

function installViewportShim() {
	const available = () => Math.max(200, Math.round(realViewportHeight() - reservedTop - reservedBottom));
	Object.defineProperty(window, 'innerHeight', { configurable: true, get: available });
	if (vv && vvHeightDesc) Object.defineProperty(vv, 'height', { configurable: true, get: available });
}

function relayout() {
	const root = document.getElementById('hd-root');
	const height = realViewportHeight();
	const offset = vv?.offsetTop || 0;
	// Keep the bottom bar glued to the visible area, even when the keyboard only
	// shrinks or pans the visual viewport (Android default, iOS).
	const rootH = root.getBoundingClientRect().height;
	root.style.top = `${Math.round(offset + height - rootH)}px`;
	reservedTop = document.getElementById('hd-safe').getBoundingClientRect().height;
	reservedBottom = rootH;
	const style = document.documentElement.style;
	style.setProperty('--hd-top', `${Math.round(offset + reservedTop)}px`);
	style.setProperty('--hd-bottom', `${Math.round(rootH)}px`);
	placeFab();
	window.dispatchEvent(new Event('resize'));
	requestAnimationFrame(placeViewbar);
}

function isTyping() {
	const a = document.activeElement;
	return !!a && a.matches?.(state.selectors.textInputs);
}

// Accessory keys follow the soft keyboard: a text input has focus *and* the visible
// area shrank. Focus alone is not enough: VS Code focuses the editor by itself, which
// raises no keyboard, and Android's back button hides the keyboard but keeps the focus.
// The keyboard-free height is the largest one seen at the current width.
let fullHeight = 0;
let fullHeightWidth = 0;
function updateKeys() {
	const h = realViewportHeight();
	const w = document.documentElement.clientWidth;
	if (w !== fullHeightWidth) {
		fullHeightWidth = w;
		fullHeight = 0;
	}
	fullHeight = Math.max(fullHeight, h);
	const on = isTyping() && h < fullHeight - 150;
	if (on === state.keysOn) return relayout();
	state.keysOn = on;
	render();
}

function onFocusIn(e) {
	if (e.target.matches?.(state.selectors.textInputs)) state.lastInput = e.target;
	updateKeys();
}

function onFocusOut() {
	setTimeout(updateKeys, 50);
}

// ---------------------------------------------------------------- UI

function button(attrs, children, onPress) {
	const b = el('button', { type: 'button', tabindex: '-1', ...attrs }, children);
	// Keep focus (and the soft keyboard) on the editor when tapping our bars.
	b.addEventListener('pointerdown', (e) => e.preventDefault());
	b.addEventListener('mousedown', (e) => e.preventDefault());
	onTap(b, () => onPress());
	return b;
}

function build() {
	const keys = el('div', { id: 'hd-keys' });
	const accessory = [...new Set([...state.config.accessoryKeys.filter((n) => n !== 'menu'), 'copy', 'paste'])];
	for (const name of ['menu', ...accessory]) {
		const def = KEY_DEFS[name];
		if (!def) continue;
		const face = def.label && !def.icon ? el('span', { 'data-i18n': def.label }, t(def.label)) : icon(def.icon);
		keys.append(button({ 'data-key': name, 'aria-label': name }, face, () => pressKey(name, def)));
	}
	keys.append(button({ 'data-key': 'hideKeyboard', 'aria-label': t('aria.hideKeyboard'), 'data-i18n-aria': 'aria.hideKeyboard' }, icon('chevron-down'), () => document.activeElement?.blur?.()));

	const insecure = el('div', { id: 'hd-insecure', hidden: window.isSecureContext, 'data-i18n': 'notice.insecure' }, t('notice.insecure'));
	const network = el(
		'div',
		{ id: 'hd-network', hidden: true, role: 'status', 'aria-live': 'polite' },
		el('span', { 'data-i18n': 'notice.offline' }, t('notice.offline')),
		el('button', { type: 'button', 'data-i18n': 'action.reconnect', onclick: () => location.reload() }, t('action.reconnect')),
	);
	const notice = el('div', { id: 'hd-notice', hidden: true });
	const root = el('div', { id: 'hd-root' }, insecure, network, notice, keys);

	const fab = el('button', { id: 'hd-fab', type: 'button', tabindex: '-1', 'aria-label': t('aria.menu'), 'data-i18n-aria': 'aria.menu' }, icon('menu'));
	installFab(fab);

	const tiles = el('div', { id: 'hd-menu-grid' });
	for (const name of state.config.menu) {
		const def = MENU_DEFS[name];
		if (!def) continue;
		tiles.append(button({ class: 'hd-tile', 'data-item': name, 'aria-label': t(def.label), 'data-i18n-aria': def.label }, [icon(def.icon), el('span', { 'data-i18n': def.label }, t(def.label))], () => pressMenu(name)));
	}
	const menu = el(
		'section',
		{ id: 'hd-menu', 'aria-label': t('aria.menu'), 'data-i18n-aria': 'aria.menu' },
		el('span', { class: 'hd-grip', 'aria-hidden': 'true' }),
		el(
			'div',
			{ id: 'hd-menu-head' },
			button({ id: 'hd-title', 'aria-label': t('aria.quickOpen'), 'data-i18n-aria': 'aria.quickOpen' }, [el('span', { id: 'hd-title-text' }, 'handide'), el('small', { id: 'hd-menu-folder' })], () => {
				closeMenu();
				runAction('quickOpen');
			}),
			button({ class: 'hd-icon-btn', 'aria-label': t('aria.settings'), 'data-i18n-aria': 'aria.settings', 'data-act': 'settings', 'aria-expanded': 'false' }, icon('gear'), toggleSettings),
			button({ class: 'hd-icon-btn', 'aria-label': t('aria.save'), 'data-i18n-aria': 'aria.save', 'data-act': 'save' }, icon('save'), () => runAction('save')),
			button({ class: 'hd-icon-btn', 'aria-label': t('aria.close'), 'data-i18n-aria': 'aria.close', 'data-act': 'close' }, icon('close'), closeMenu),
		),
		el('div', { id: 'hd-devices', hidden: true }),
		buildSettings(),
		tiles,
	);
	const menuScrim = el('div', { id: 'hd-menu-scrim', onclick: closeMenu });

	const drawer = el(
		'aside',
		{ id: 'hd-drawer', 'aria-label': t('aria.files'), 'data-i18n-aria': 'aria.files' },
		el('div', { id: 'hd-drawer-head' }),
		el('div', { id: 'hd-drawer-body' }),
	);
	const scrim = el('div', { id: 'hd-scrim', onclick: closeDrawer });

	const viewbar = el('div', { id: 'hd-viewbar', hidden: true });

	const sheet = el(
		'form',
		{ id: 'hd-sheet', hidden: true },
		el('textarea', { rows: '4', placeholder: t('sheet.placeholder'), 'data-i18n-ph': 'sheet.placeholder', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' }),
		el(
			'div',
			{ class: 'hd-sheet-actions' },
			el('button', { type: 'button', 'data-act': 'cancel', 'data-i18n': 'action.cancel', onclick: closeInputSheet }, t('action.cancel')),
			el('button', { type: 'submit', 'data-i18n': 'action.insert' }, t('action.insert')),
		),
	);
	// Tapping the buttons must not take the focus (and the keyboard) from the text box.
	for (const b of sheet.querySelectorAll('button')) b.addEventListener('pointerdown', (e) => e.preventDefault());
	const imageInput = el('input', { id: 'hd-image-input', type: 'file', accept: 'image/*', hidden: true });
	imageInput.addEventListener('change', () => {
		const file = imageInput.files?.[0];
		imageInput.value = '';
		uploadImage(file);
	});
	const toastEl = el('div', { id: 'hd-toast', hidden: true, role: 'status' });
	const voicePill = el('div', { id: 'hd-voice', hidden: true, role: 'status', 'aria-live': 'polite', onclick: stopVoice });
	const uploadPill = el('button', { id: 'hd-upload', type: 'button', hidden: true, 'aria-live': 'polite' });
	const agents = el('div', { id: 'hd-agents', hidden: true, role: 'menu', 'aria-label': t('aria.agents'), 'data-i18n-aria': 'aria.agents' });
	const safe = el('div', { id: 'hd-safe', 'aria-hidden': 'true' });

	document.body.append(safe, viewbar, agents, root, fab, menuScrim, menu, scrim, drawer, sheet, imageInput, toastEl, voicePill, uploadPill);
	renderDrawer();
}

// Mobile browsers suspend sockets in the background and may keep reporting
// navigator.onLine=true while switching Wi-Fi/cellular networks. Probe our own
// origin, surface the failure, and let VS Code perform its normal reconnect.
function watchNetwork() {
	const banner = document.getElementById('hd-network');
	let probing = false;
	let failures = 0;
	const show = (online) => {
		state.networkOnline = online;
		banner.hidden = online;
		requestAnimationFrame(relayout);
	};
	const probe = async () => {
		if (probing || document.visibilityState === 'hidden') return;
		probing = true;
		try {
			const res = await fetch(`${BASE}health?at=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
			if (!res.ok) throw new Error(String(res.status));
			const recovered = !state.networkOnline;
			failures = 0;
			show(true);
			if (recovered && state.bridge) refreshState();
		} catch {
			failures++;
			if (failures >= 2 || !navigator.onLine) show(false);
		} finally {
			probing = false;
		}
	};
	window.addEventListener('offline', () => {
		failures = 2;
		show(false);
	});
	window.addEventListener('online', probe);
	document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && probe());
	setInterval(probe, 5000);
	probe();
}

function pressKey(name, def) {
	if (def.menu) return openMenu();
	if (def.clipboard === 'copy') return copySelection();
	if (def.clipboard === 'paste') return pasteClipboard();
	if (def.sticky) {
		state.sticky[def.sticky] = !state.sticky[def.sticky];
		render();
		return;
	}
	if (def.input) return openInputSheet();
	if (def.action) return runAction(def.action);
	sendKey({ key: def.key, keyCode: def.keyCode, ...consumeSticky() });
}

async function copySelection() {
	const selected = window.getSelection()?.toString() || '';
	if (selected) {
		try {
			await navigator.clipboard.writeText(selected);
			return toast(t('clip.copiedSelection'));
		} catch {}
	}
	// Monaco stores its selection outside the normal DOM Selection.
	const target = focusTarget();
	sendKey({ key: 'c', code: 'KeyC', keyCode: 67, ...(APPLE ? { metaKey: true } : { ctrlKey: true }), target });
	toast(t(target?.tagName === 'IFRAME' ? 'clip.iframeCopy' : 'clip.copiedSelection'));
}

async function pasteClipboard() {
	let text;
	try {
		text = await navigator.clipboard.readText();
	} catch {
		return openInputSheet();
	}
	if (!text) return toast(t('clip.empty'));
	const target = focusTarget();
	if (target?.tagName === 'IFRAME') return toast(t('clip.iframePaste'));
	pasteInto(target, text);
	toast(t('clip.pasted'));
}

function render() {
	const root = document.getElementById('hd-root');
	if (!root) return;
	const sheetOpen = !document.getElementById('hd-sheet').hidden;
	root.dataset.keys = state.keysOn && !sheetOpen ? '1' : '';
	document.documentElement.dataset.hdView = state.view;
	document.getElementById('hd-fab').hidden = state.keysOn || state.drawerOpen || state.menuOpen || sheetOpen;
	for (const b of document.querySelectorAll('#hd-menu [data-item]')) b.classList.toggle('active', MENU_DEFS[b.dataset.item]?.view === state.view);
	for (const b of root.querySelectorAll('[data-key]')) {
		const def = KEY_DEFS[b.dataset.key];
		b.classList.toggle('active', !!(def?.sticky && state.sticky[def.sticky]));
	}
	const preview = document.getElementById('hd-preview');
	if (preview) preview.hidden = !state.previewOpen || state.view !== 'editor';
	renderViewbar();
	if (state.view !== 'ai') {
		stopVoice();
		closeAgents();
	}
	requestAnimationFrame(relayout);
}

// The active file, from VS Code's own window title ("● name - folder - …"):
// shown in the menu sheet, and as a dot on the floating button while unsaved.
function watchTitle() {
	const update = () => {
		const [first] = document.title.split(' - ');
		const dirty = first.startsWith('●');
		const name = first.replace(/^●\s*/, '').trim();
		const known = name && !/Visual Studio Code/.test(name);
		const text = document.getElementById('hd-title-text');
		text.textContent = known ? name : state.folder?.name ?? 'handide';
		text.classList.toggle('dirty', dirty);
		document.getElementById('hd-fab').classList.toggle('dirty', dirty);
	};
	new MutationObserver(update).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });
	update();
}

// VS Code defines its theme variables on the workbench element, and our UI lives
// outside it. Copy the few we use onto our elements, and again whenever the theme changes.
const THEME_VARS = [
	'--vscode-sideBar-background', '--vscode-editor-background', '--vscode-foreground',
	'--vscode-descriptionForeground', '--vscode-focusBorder', '--vscode-panel-border',
	'--vscode-panel-background', '--vscode-sideBarSectionHeader-background',
	'--vscode-button-background', '--vscode-button-foreground',
	'--vscode-button-secondaryBackground', '--vscode-button-secondaryForeground',
	'--vscode-input-background', '--vscode-input-foreground',
	'--vscode-list-activeSelectionBackground', '--vscode-list-activeSelectionForeground', '--vscode-list-hoverBackground',
	'--vscode-titleBar-activeBackground', '--vscode-titleBar-activeForeground',
	'--vscode-inputValidation-warningBackground', '--vscode-inputValidation-warningForeground',
	'--vscode-inputValidation-errorBackground', '--vscode-inputValidation-errorForeground',
	'--vscode-widget-shadow',
	'--vscode-font-family', '--vscode-editor-font-family',
];

function syncTheme(workbench) {
	const copy = () => {
		const computed = getComputedStyle(workbench);
		const style = document.documentElement.style;
		for (const name of THEME_VARS) {
			const value = computed.getPropertyValue(name);
			if (value) style.setProperty(name, value);
		}
		const bg = computed.getPropertyValue('--vscode-editor-background');
		if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg.trim());
	};
	new MutationObserver(copy).observe(workbench, { attributes: true, attributeFilter: ['class'] });
	copy();
	setTimeout(copy, 2000);
}

// The trust screen opens as an editor, which a drawer (the maximized AI side bar) would
// cover. Restricted Mode means no companion, so the drawers are closed with VS Code's own
// keys first. Without the banner's link, the command palette finds the same command.
function openTrust() {
	const workbench = document.querySelector(state.selectors.workbench);
	if (state.view !== 'editor') {
		state.view = 'editor';
		render();
	}
	for (const part of visibleParts().filter((p) => CLOSE_PART_KEYS[p])) sendKey({ ...CLOSE_PART_KEYS[part], target: workbench });
	setTimeout(() => {
		const banner = document.querySelector(state.selectors.banner);
		const manage = banner && [...banner.querySelectorAll('a')].find((a) => /Manage/i.test(a.textContent));
		if (manage) return manage.click();
		sendKey({ key: 'F1', keyCode: 112, code: 'F1', target: workbench });
		setTimeout(() => {
			const input = document.querySelector(state.selectors.quickInputBox);
			if (!input) return;
			input.value = 'Manage Workspace Trust';
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}, 500);
	}, 400);
}

// Restricted Mode disables the companion extension: bridge, views and file opening stop.
function watchTrust() {
	const notice = document.getElementById('hd-notice');
	const update = () => {
		const banner = document.querySelector(state.selectors.banner);
		const restricted = !!banner && banner.getBoundingClientRect().height > 0 && /Restricted Mode/i.test(banner.textContent);
		if (restricted === !notice.hidden) return;
		notice.hidden = !restricted;
		if (restricted) {
			notice.replaceChildren(
				el('span', { 'data-i18n': 'trust.notice' }, t('trust.notice')),
				button({ 'data-i18n': 'trust.manage' }, t('trust.manage'), openTrust),
			);
		}
		requestAnimationFrame(relayout);
	};
	let queued = false;
	new MutationObserver((records) => {
		if (queued || records.every((r) => r.target.closest?.('#hd-viewbar, #hd-fab'))) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			update();
			syncViewFromLayout();
			placeViewbar();
		});
	}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
	update();
}

// ---------------------------------------------------------------- boot

async function loadJson(name) {
	const res = await fetch(BASE + name, { cache: 'no-cache' });
	return res.json();
}

function waitFor(selector) {
	return new Promise((resolve) => {
		const found = document.querySelector(selector);
		if (found) return resolve(found);
		const obs = new MutationObserver(() => {
			const e = document.querySelector(selector);
			if (e) {
				obs.disconnect();
				resolve(e);
			}
		});
		obs.observe(document.documentElement, { childList: true, subtree: true });
	});
}

// ---------------------------------------------------------------- localhost links
//
// "http://localhost:3300" in a chat answer or the terminal means the PC, but on the phone
// it would open the phone itself. Such links go through the proxy instead
// (proxy/ports.mjs), unless this browser runs on the PC. VS Code opens links with
// window.open(url), or on Safari window.open() and then newTab.location.href = url.
//
// On the phone a localhost link opens in the code view first (a preview over the editor,
// same origin, so the app works as usual); "Open in browser" takes it full screen in a
// tab. Other links open in a tab. Safari blocks a tab that no tap opened, and links from
// the AI chat reach the page only after a round trip to the PC (the agent hands them to
// $BROWSER); such a link is offered as a banner to tap instead of being lost.
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;
const PORT_BASE = `${BASE}port/`;

function localUrl(href) {
	if (LOOPBACK.test(location.hostname)) return href;
	let url;
	try {
		url = new URL(String(href), location.href);
	} catch {
		return href;
	}
	if (!/^https?:$/.test(url.protocol) || !LOOPBACK.test(url.hostname)) return href;
	const port = url.port || (url.protocol === 'https:' ? '443' : '80');
	return `${location.origin}${PORT_BASE}${port}${url.pathname}${url.search}${url.hash}`;
}

const isForwarded = (href) => String(href).startsWith(`${location.origin}${PORT_BASE}`);
const shownUrl = (href) => String(href).replace(`${location.origin}${PORT_BASE}`, 'localhost:');
const mobileUi = () => document.documentElement.classList.contains('hd-mobile');
const tapped = () => !navigator.userActivation || navigator.userActivation.isActive;

function offerLink(href) {
	document.getElementById('hd-link')?.remove();
	const close = () => box.remove();
	// A plain link (not onTap, which cancels the click): the tap itself opens the tab.
	const link = el('a', { href, target: '_blank', rel: 'noopener' }, el('b', {}, t('link.open')), el('small', {}, shownUrl(href)));
	link.addEventListener('click', () => setTimeout(close));
	const box = el('div', { id: 'hd-link', role: 'status' }, link, el('button', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('close')));
	document.body.append(box);
	setTimeout(close, 20000);
}

const preview = { port: null };

/** What the preview shows now, as a link that opens the same page in a tab. */
function previewHref() {
	const frame = document.querySelector('#hd-preview iframe');
	let path = '/';
	try {
		const loc = frame.contentWindow.location;
		path = (loc.pathname.startsWith(PORT_BASE) ? loc.pathname.replace(/^\/__handide\/port\/\d+/, '') || '/' : loc.pathname) + loc.search + loc.hash;
	} catch {}
	return `${location.origin}${PORT_BASE}${preview.port}${path}`;
}

function setPreviewBar(href) {
	const box = document.getElementById('hd-preview');
	box.querySelector('.hd-preview-url').textContent = shownUrl(href);
	box.querySelector('.hd-preview-open').href = href;
}

function showPreview(href) {
	preview.port = href.slice(`${location.origin}${PORT_BASE}`.length).match(/^\d+/)?.[0];
	let box = document.getElementById('hd-preview');
	if (!box) {
		const frame = el('iframe', { title: 'Preview' });
		frame.addEventListener('load', () => frame.src !== 'about:blank' && setPreviewBar(previewHref()));
		// A plain link: the tap opens the tab, so Safari lets it through.
		const open = el('a', { class: 'hd-preview-open', target: '_blank', rel: 'noopener' }, icon('link-external'), el('span', { 'data-i18n': 'preview.browser' }, t('preview.browser')));
		const bar = el(
			'div',
			{ class: 'hd-preview-bar' },
			el('button', { type: 'button', 'aria-label': 'Close', onclick: closePreview }, icon('close')),
			el('span', { class: 'hd-preview-url' }),
			el('button', { type: 'button', 'aria-label': 'Reload', onclick: () => frame.contentWindow?.location.reload() }, icon('refresh')),
			open,
		);
		box = el('div', { id: 'hd-preview', hidden: true }, bar, frame);
		document.body.append(box);
	}
	box.querySelector('iframe').src = href;
	setPreviewBar(href);
	state.previewOpen = true;
	if (state.view === 'editor') render();
	else showView('editor');
}

function closePreview() {
	const box = document.getElementById('hd-preview');
	if (!box || !state.previewOpen) return;
	state.previewOpen = false;
	box.querySelector('iframe').src = 'about:blank';
	render();
}

/** Opens a link as described above; `openTab` opens a real tab (only while tapped). */
function openLink(href, openTab) {
	const local = localUrl(href);
	if (isForwarded(local) && mobileUi()) return showPreview(local);
	if (tapped()) return openTab(local);
	offerLink(local);
}

/** Stands in for the tab VS Code opens first on Safari; the address it then sets goes to openLink. */
function deferredTab(openTab) {
	const go = (v) => openLink(v, openTab);
	const tab = {
		closed: false,
		opener: null,
		focus() {},
		close() { tab.closed = true; },
		document: { documentElement: { style: {} }, body: { style: {} } },
		get location() {
			return { set href(v) { go(v); }, assign: go, replace: go };
		},
		set location(v) { go(v); },
	};
	return tab;
}

function installLocalLinks() {
	const open = window.open;
	window.open = function (url, ...rest) {
		const openTab = (u) => open.call(window, u, ...rest);
		if (!url) return deferredTab((u) => open.call(window, u, '_blank', 'noopener'));
		let win = null;
		openLink(url, (u) => (win = openTab(u)));
		return win;
	};
	// Plain <a href> links that VS Code leaves to the browser.
	document.addEventListener(
		'click',
		(e) => {
			const a = e.target.closest?.('a[href]');
			if (!a || a.closest('#hd-link, #hd-preview')) return;
			const local = localUrl(a.href);
			if (local === a.href) return;
			if (mobileUi()) {
				e.preventDefault();
				showPreview(local);
			} else a.href = local;
		},
		true,
	);
}

async function main() {
	installLocalLinks(); // desktop browsers on another machine need it too
	const [config, commands, selectors] = await Promise.all([loadJson('config.json'), loadJson('commands.json'), loadJson('selectors.json')]);
	config.menu ??= DEFAULT_MENU;
	config.accessoryKeys ??= ['esc', 'tab', 'ctrl', 'left', 'up', 'down', 'right', 'undo', 'input'];
	Object.assign(state, { config, commands, selectors });

	const mobile = window.matchMedia(`(max-width: ${config.breakpoint}px), (pointer: coarse)`);
	if (!mobile.matches) return; // desktop browsers get plain VS Code

	document.documentElement.classList.add('hd-mobile');
	document.documentElement.lang = lang;
	installViewportShim();
	build();
	render();
	installGestures();
	watchNetwork();

	updateKeys();
	vv?.addEventListener('resize', updateKeys);
	vv?.addEventListener('scroll', relayout);
	window.addEventListener('orientationchange', () => setTimeout(updateKeys, 300));
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	document.addEventListener('beforeinput', onBeforeInput, true);
	document.addEventListener(
		'keydown',
		(e) => {
			if (e.key !== 'Escape') return;
			if (state.menuOpen) closeMenu();
			else if (state.drawerOpen) closeDrawer();
		},
		true,
	);

	syncTheme(await waitFor(selectors.workbench));
	watchTrust();
	watchTitle();
	state.folder = pageFolder();
	renderMenuHead();
	loadDevices();
	if (state.folder) loadDir(state.folder.path, true).then(renderDrawer);
	if (!builtin() && (await waitForBridge())) {
		loadAgents(); // make the extension picker instant when it is opened later
		await refreshState();
		showView('editor');
		// Keep the drawer's active file and folder current.
		setInterval(() => state.drawerOpen || refreshState(), 5000);
	} else {
		setTimeout(() => showView('editor'), 2500);
	}
}

main().catch((err) => console.error('[handide] layer failed', err));
