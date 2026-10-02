#!/usr/bin/env node
// Retakes the README screenshots in docs/ (Pixel 7 viewport, private handide, a small
// sample project). Run after a layout change:
//
//   node .claude/skills/mobilize-editor/scripts/screenshots.mjs
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OUT, ROOT, killTree, loadPlaywright, startProxy } from './lib/proxy.mjs';
import { grantTrust } from './lib/trust.mjs';

const PROJECT = {
	'server.js': `import express from 'express';
import { listTodos, addTodo } from './src/todos.js';

const app = express();
app.use(express.json());

// GET /todos → every todo, newest first
app.get('/todos', async (req, res) => {
  const todos = await listTodos();
  res.json(todos.sort((a, b) => b.created - a.created));
});

// POST /todos { title } → the new todo
app.post('/todos', async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  res.status(201).json(await addTodo(title.trim()));
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(\`todo api on http://localhost:\${port}\`);
});
`,
	'src/todos.js': `const todos = [];

export async function listTodos() {
  return [...todos];
}

export async function addTodo(title) {
  const todo = { id: todos.length + 1, title, done: false, created: Date.now() };
  todos.push(todo);
  return todo;
}
`,
	'src/todos.test.js': `import { addTodo, listTodos } from './todos.js';\n`,
	'package.json': `{\n  "name": "todo-api",\n  "type": "module",\n  "scripts": { "start": "node server.js" }\n}\n`,
	'README.md': '# todo-api\n',
};

const { chromium, devices } = await loadPlaywright();
rmSync(join(OUT, 'data'), { recursive: true, force: true }); // no restored terminals or editors
const proxy = await startProxy({ mode: 'extension' });
for (const entry of readdirSync(proxy.workspace)) rmSync(join(proxy.workspace, entry), { recursive: true, force: true }); // leftovers from checks
for (const [name, text] of Object.entries(PROJECT)) {
	const file = join(proxy.workspace, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

const browser = await chromium.launch();
try {
	const context = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1.25 });
	const page = await context.newPage();
	const tap = async (selector) => {
		const box = await page.locator(selector).first().boundingBox();
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	};
	const shot = async (name) => {
		await page.waitForTimeout(1200);
		await page.screenshot({ path: join(ROOT, 'docs', `${name}.png`) });
		console.log(`docs/${name}.png`);
	};
	const menu = async (item) => {
		await tap('#hd-fab');
		await page.waitForTimeout(700);
		if (item) await tap(`#hd-menu [data-item="${item}"]`);
	};

	await page.goto(proxy.url, { timeout: 120_000 });
	await page.waitForSelector('#hd-root', { timeout: 120_000 });
	await page.waitForTimeout(4000);
	console.log(`trust: ${await grantTrust(page)}`);
	await page.waitForTimeout(6000);
	// Toasts (e.g. "a git repository was found in the parent folders": the sample lives
	// inside this repo) are not part of the layout.
	await page.addStyleTag({ content: '.notifications-toasts { display: none !important; }' });

	await menu('files');
	await page.waitForTimeout(2000);
	await tap('#hd-drawer .hd-row:has-text("server.js")');
	await page.waitForTimeout(2500);
	await shot('editor');

	await menu('files');
	await page.waitForTimeout(1500);
	await tap('#hd-drawer .hd-row:has-text("src")');
	await page.waitForTimeout(1500);
	await shot('drawer');
	await page.touchscreen.tap(400, 400); // the scrim beside the drawer
	await page.waitForTimeout(800);

	await menu();
	await shot('menu');
	await page.locator('#hd-menu-scrim, #hd-scrim').first().evaluate((el) => el.click()).catch(() => {});
	await page.keyboard.press('Escape');
	await page.waitForTimeout(800);

	await menu('terminal');
	await page.waitForTimeout(3500);
	await page.locator('.part.panel .xterm-helper-textarea').first().focus();
	// Shell start-up garbles the first line typed: send a throwaway one, then clear.
	await page.waitForTimeout(3000);
	const shortPrompt = process.platform === 'win32' ? "function prompt { '~/todo-api> ' }" : "PS1='~/todo-api$ '";
	for (const cmd of ['', shortPrompt, process.platform === 'win32' ? 'cls' : 'clear', 'node --version', 'git --version']) {
		await page.keyboard.type(cmd, { delay: 30 });
		await page.keyboard.press('Enter');
		await page.waitForTimeout(/^(cls|clear)$/.test(cmd) ? 6000 : 3000);
	}
	await shot('terminal-dock');
	await tap('#hd-viewbar [data-act="back"]');
	await page.waitForTimeout(1000);

	await menu('ai');
	await page.waitForTimeout(3000);
	await shot('ai');
} finally {
	await browser.close();
	killTree(proxy.child);
}
process.exit(0);
