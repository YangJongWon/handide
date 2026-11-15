#!/usr/bin/env node
// Builds the PC webcam parts (Windows, needs Visual Studio 2022 or its Build Tools with C++):
//
//   native/bin/x64/handide-camera.dll   softcam (MIT, pinned below) as "handide Camera"
//   native/bin/x64/handide-cam.exe      feeds the phone's frames into it (native/handide-cam.cpp)
//
// softcam is fetched at a pinned commit and patched to its own name, CLSID and shared
// memory names, so it never collides with another app's softcam-based camera.
// Usage: node native/build.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOFTCAM_URL = 'https://github.com/tshino/softcam';
const SOFTCAM_COMMIT = 'afb424c2415b04da627fa1a7b4706575c2ba3010'; // v1.8.1
const SRC = join(HERE, 'third_party', 'softcam');
const BUILD = join(HERE, 'build', 'softcam');
const OUT = join(HERE, 'bin', 'x64');

// Must match CLSID_STR in handide-cam.cpp.
const NAME = 'handide Camera';
const CLSID = { str: '3C7B5E1A-8D2F-4E6B-9A41-6F0D2C8B7E15', def: '0x3c7b5e1a, 0x8d2f, 0x4e6b, 0x9a, 0x41, 0x6f, 0x0d, 0x2c, 0x8b, 0x7e, 0x15' };

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
};

if (process.platform !== 'win32') {
	console.error('The PC webcam is Windows only.');
	process.exit(1);
}

// ---- toolchain
const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
if (!existsSync(vswhere)) throw new Error('Visual Studio Build Tools not found (winget install Microsoft.VisualStudio.2022.BuildTools with the C++ workload).');
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
if (!vs) throw new Error('Visual Studio is installed without the C++ tools (workload "Desktop development with C++").');
const msbuild = join(vs, 'MSBuild', 'Current', 'Bin', 'amd64', 'MSBuild.exe');
const vcvars = join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');

// ---- softcam source at the pinned commit
const head = () => (existsSync(join(SRC, '.git')) ? spawnSync('git', ['-C', SRC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() : '');
if (head() !== SOFTCAM_COMMIT) {
	rmSync(SRC, { recursive: true, force: true });
	mkdirSync(SRC, { recursive: true });
	run('git', ['-C', SRC, 'init', '-q']);
	run('git', ['-C', SRC, 'fetch', '-q', '--depth', '1', SOFTCAM_URL, SOFTCAM_COMMIT]);
	run('git', ['-C', SRC, 'checkout', '-q', 'FETCH_HEAD']);
	if (head() !== SOFTCAM_COMMIT) throw new Error('softcam checkout does not match the pinned commit');
}

// ---- patched copy
rmSync(BUILD, { recursive: true, force: true });
cpSync(SRC, BUILD, { recursive: true, filter: (p) => !p.includes(`${join(SRC, '.git')}`) });
const patch = (rel, pairs) => {
	const f = join(BUILD, rel);
	let s = readFileSync(f, 'utf8');
	for (const [from, to] of pairs) {
		if (!s.includes(from)) throw new Error(`patch: "${from}" not found in ${rel} (softcam changed?)`);
		s = s.split(from).join(to);
	}
	writeFileSync(f, s);
};
patch('src/softcam/softcam.cpp', [
	['0xaef3b972, 0x5fa5, 0x4647, 0x95, 0x71, 0x35, 0x8e, 0xb4, 0x72, 0xbc, 0x9e', CLSID.def],
	['L"DirectShow Softcam"', `L"${NAME}"`],
]);
patch('src/softcamcore/DShowSoftcam.cpp', [['L"DirectShow Softcam Stream"', `L"${NAME} Stream"`]]);
patch('src/softcamcore/FrameBuffer.cpp', [
	['"DirectShow Softcam/NamedMutex"', `"${NAME}/NamedMutex"`],
	['"DirectShow Softcam/SharedMemory"', `"${NAME}/SharedMemory"`],
]);

// ---- build
run(msbuild, [join(BUILD, 'softcam.sln'), '/t:softcam', '/p:Configuration=Release', '/p:Platform=x64', '/m', '/nologo', '/v:minimal']);
const dll = [join(BUILD, 'dist', 'bin', 'x64', 'softcam.dll'), join(BUILD, 'x64', 'Release', 'softcam.dll')].find(existsSync);
if (!dll) throw new Error('softcam.dll was not produced');
mkdirSync(OUT, { recursive: true });
copyFileSync(dll, join(OUT, 'handide-camera.dll'));
copyFileSync(join(BUILD, 'LICENSE'), join(OUT, 'softcam-LICENSE.txt'));

const objDir = join(HERE, 'build', 'obj');
mkdirSync(objDir, { recursive: true });
const cl = `"${vcvars}" >nul && cl /nologo /O2 /EHsc /std:c++17 /utf-8 /W3 /DUNICODE /D_UNICODE /Fo"${objDir}\\\\" "${join(HERE, 'handide-cam.cpp')}" /Fe"${join(OUT, 'handide-cam.exe')}" /link /SUBSYSTEM:CONSOLE`;
run('cmd.exe', ['/d', '/s', '/c', `"${cl}"`], { windowsVerbatimArguments: true });

console.log(`\nBuilt ${OUT}\\handide-camera.dll and handide-cam.exe`);
console.log('Install the camera once (asks for admin rights): node proxy/server.mjs camera install');
