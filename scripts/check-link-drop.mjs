import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chromium } from 'playwright';

const mobile = readFileSync(process.argv[2] || new URL('../layer/mobile.js', import.meta.url), 'utf8');
const install = mobile.slice(mobile.indexOf('function installLinkDropPreview()'), mobile.indexOf('function closePreview()'));
const css = readFileSync(new URL('../layer/mobile.css', import.meta.url), 'utf8');
const sync = mobile.slice(mobile.indexOf('function syncViewFromLayout()'), mobile.indexOf('function pressMenu('));
for (const shown of [['editor', 'auxiliarybar'], ['auxiliarybar']]) {
	const calls = [];
	const context = vm.createContext({
		Date, state: { view: 'ai' }, visibleParts: () => shown,
		VIEW_PARTS: { ai: ['auxiliarybar'] }, CLOSE_PART_KEYS: {},
		showView: (view) => calls.push(view),
	});
	vm.runInContext(sync, context);
	context.syncViewFromLayout();
	assert.deepEqual(calls, shown.includes('editor') ? ['editor'] : []);
}
console.log('PASS: image/file reveal closes AI sidebar without editorReveal notifications');
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	for (const [width, height, sides] of [[400, 800, ['top', 'bottom']], [800, 400, ['left', 'right']]]) {
		await page.setViewportSize({ width, height });
		await page.goto('about:blank');
		await page.setContent('<html class="hd-mobile"><body></body></html>');
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: `
			window.calls = [];
			window.bridgeCall = async (command, args) => { calls.push({command, args}); return {ok:true}; };
			window.state = {};
			window.showView = (view) => calls.push({view});
			window.el = (tag, attrs) => Object.assign(document.createElement(tag), attrs);
			${install}
			installLinkDropPreview();
			window.drag = (type, x, y, href = 'file:///workspace/test.js') => {
				const dataTransfer = new DataTransfer();
				dataTransfer.setData('text/uri-list', href);
				document.dispatchEvent(new DragEvent(type, {bubbles:true, cancelable:true, clientX:x, clientY:y, dataTransfer}));
			};
		` });
		for (const [i, side] of sides.entries()) {
			await page.evaluate(({ i, width, height }) => drag('dragover', width * (i ? .75 : .25), height * (i ? .75 : .25)), { i, width, height });
			const box = page.locator('#hd-link-drop-preview');
			assert.equal(await box.getAttribute('data-side'), side);
			assert.equal(await box.isVisible(), true);
			const rect = await box.boundingBox();
			assert.equal(rect.width, width > height ? width / 2 : width);
			assert.equal(rect.height, width > height ? height : height / 2);
			assert.equal(await box.evaluate((node) => getComputedStyle(node).pointerEvents), 'none');
		}
		await page.evaluate(() => drag('dragend', 0, 0));
		assert.equal(await page.locator('#hd-link-drop-preview').isVisible(), false);
		await page.evaluate(() => { drag('dragover', 10, 10); drag('drop', 10, 10); });
		await page.waitForFunction(() => calls.some((call) => call.view === 'editor'));
		const dropped = await page.evaluate(() => calls.find((call) => call.command === 'handide.dropLink'));
		assert.equal(dropped.args.side, sides[0]);
		assert.equal(dropped.args.portrait, width < height);
		await page.evaluate(() => {
			const frame = document.createElement('iframe');
			frame.srcdoc = '<a href="file:///workspace/test.js">file</a>';
			document.body.append(frame);
		});
		await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('a'));
		await page.evaluate(() => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('text/uri-list', 'file:///workspace/test.js');
			document.querySelector('iframe').contentDocument.dispatchEvent(new DragEvent('dragover', {
				cancelable: true, clientX: 5, clientY: 5, dataTransfer,
			}));
		});
		assert.equal(await page.locator('#hd-link-drop-preview').isVisible(), true, 'webview drag must reach the preview');
	}
	console.log('PASS: four preview regions, geometry, pointer transparency, cancellation, drop bridge');
} finally { await browser.close(); }

const extension = readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8');
const drop = extension.slice(extension.indexOf('async function dropLink('), extension.indexOf('function state()'));
for (const portrait of [true, false]) {
	const calls = [];
	const context = vm.createContext({
		linkLayout: {}, droppingLink: false, revealTimer: undefined, lastActiveTab: undefined, editorReveal: 0,
		clearTimeout, showView: async () => {},
		run: async (...args) => calls.push(args),
		vscode: { Uri: { parse: (href) => href }, ViewColumn: { Beside: -2 }, window: { tabGroups: { activeTabGroup: { activeTab: {} } } } },
	});
	vm.runInContext(drop, context);
	assert.equal((await context.dropLink({ href: 'file:///workspace/test.js', portrait, side: portrait ? 'top' : 'left' })).ok, true);
	assert.equal(calls[0][0], 'workbench.action.joinAllGroups');
	assert.equal(calls[1][0], 'vscode.open');
	assert.equal(calls[1][2].viewColumn, -2);
	assert.equal(calls[2][0], portrait ? 'workbench.action.editorLayoutTwoRows' : 'workbench.action.editorLayoutTwoColumns');
	assert.equal(calls[3][0], portrait ? 'workbench.action.moveActiveEditorGroupUp' : 'workbench.action.moveActiveEditorGroupLeft');
	assert.equal(context.droppingLink, false);
	assert.equal((await context.dropLink({ href: 'command:danger' })).ok, false);
}
console.log('PASS: explicit split creation, orientation, destination order, rejected command links');
