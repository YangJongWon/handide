// Grants workspace trust whichever way VS Code asks, and keeps trying until
// Restricted Mode is actually gone: the trust dialog, the trust editor's
// "Trust" button, or the Restricted Mode banner's "Manage" link.
// Returns the path that worked ('dialog' | 'editor' | 'banner'), 'disabled' when
// handide turned workspace trust off for the page, or 'failed'.
const isRestricted = (page) =>
	page.evaluate(() => {
		const banner = document.querySelector('.part.banner');
		return !!banner && banner.getBoundingClientRect().height > 0 && /Restricted Mode/i.test(banner.textContent);
	});

export const trustDisabled = (page) =>
	page.evaluate(() => {
		const raw = document.getElementById('vscode-workbench-web-configuration')?.dataset.settings;
		return !!raw && JSON.parse(raw).enableWorkspaceTrust === false;
	});

export async function grantTrust(page, { timeoutMs = 90000 } = {}) {
	if (await trustDisabled(page)) return 'disabled';
	const deadline = Date.now() + timeoutMs;
	let how = null;
	let sawRestricted = false;
	while (Date.now() < deadline) {
		const dialogTrust = page.locator('.monaco-dialog-box .monaco-button', { hasText: /^(Trust Folder|Yes, I trust)/ }).first();
		const editorTrust = page.locator('.workspace-trust-editor .monaco-button', { hasText: /^Trust$/ }).first();
		const bannerManage = page.locator('.part.banner').getByText('Manage', { exact: true }).first();
		// Buttons may sit partly off-screen on phones, so click through the DOM.
		if (await dialogTrust.count()) {
			await dialogTrust.evaluate((el) => el.click());
			how = 'dialog';
		} else if (await editorTrust.count()) {
			await editorTrust.evaluate((el) => el.click());
			how ??= 'editor';
		} else if (await bannerManage.count()) {
			await bannerManage.evaluate((el) => el.click());
			how = 'banner';
		}
		await page.waitForTimeout(1500);
		const restricted = await isRestricted(page);
		sawRestricted ||= restricted;
		// A fresh browser always starts untrusted, and VS Code can take a while to say
		// so. Only a trust prompt that was acted on and then disappeared counts.
		if (how && !restricted) {
			if (await page.locator('.workspace-trust-editor').count()) await page.keyboard.press('Control+F4');
			return how;
		}
	}
	return sawRestricted ? 'failed' : 'no trust prompt appeared';
}
