// handide-cam: feeds the phone's camera into the "handide Camera" virtual webcam.
// MIT License.
//
//   handide-cam.exe run [width height fps]   frames on stdin: [u32 LE length][JPEG bytes];
//                                            length 0 = phone gone (show the waiting screen).
//                                            Exits when stdin closes.
//   handide-cam.exe register | unregister    (un)registers handide-camera.dll next to this
//                                            exe with DirectShow; asks for admin rights (UAC).
//   handide-cam.exe status                   prints "registered" or "not-registered".
//
// The virtual camera itself is softcam (MIT, https://github.com/tshino/softcam), built as
// handide-camera.dll with its own name and IDs (native/build.mjs). It is loaded at run
// time, so the DLL can be renamed and no import library is needed.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <wincodec.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")

// Must match the CLSID patched into the DLL by native/build.mjs.
static const wchar_t CLSID_STR[] = L"{3C7B5E1A-8D2F-4E6B-9A41-6F0D2C8B7E15}";

typedef void* scCamera;
typedef scCamera(__cdecl* CreateFn)(int, int, float);
typedef void(__cdecl* DeleteFn)(scCamera);
typedef void(__cdecl* SendFn)(scCamera, const void*);

static std::wstring exeDir() {
	wchar_t buf[MAX_PATH];
	DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
	std::wstring p(buf, n);
	return p.substr(0, p.find_last_of(L"\\/") + 1);
}

static bool isRegistered() {
	std::wstring key = std::wstring(L"CLSID\\") + CLSID_STR + L"\\InprocServer32";
	HKEY h;
	if (RegOpenKeyExW(HKEY_CLASSES_ROOT, key.c_str(), 0, KEY_READ, &h) != ERROR_SUCCESS) return false;
	RegCloseKey(h);
	return true;
}

static bool isElevated() {
	HANDLE tok;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return false;
	TOKEN_ELEVATION e{};
	DWORD sz;
	BOOL ok = GetTokenInformation(tok, TokenElevation, &e, sizeof e, &sz);
	CloseHandle(tok);
	return ok && e.TokenIsElevated;
}

// register / unregister: needs admin. Relaunches itself elevated (one UAC prompt) and
// passes the elevated process's exit code through.
static int registration(bool reg) {
	if (!isElevated()) {
		wchar_t self[MAX_PATH];
		GetModuleFileNameW(nullptr, self, MAX_PATH);
		SHELLEXECUTEINFOW sei{ sizeof sei };
		sei.fMask = SEE_MASK_NOCLOSEPROCESS;
		sei.lpVerb = L"runas";
		sei.lpFile = self;
		sei.lpParameters = reg ? L"register" : L"unregister";
		sei.nShow = SW_HIDE;
		if (!ShellExecuteExW(&sei)) {
			fprintf(stderr, "elevation refused (%lu)\n", GetLastError());
			return 3;
		}
		WaitForSingleObject(sei.hProcess, INFINITE);
		DWORD code = 1;
		GetExitCodeProcess(sei.hProcess, &code);
		CloseHandle(sei.hProcess);
		printf("%s\n", code == 0 ? (reg ? "registered" : "unregistered") : "failed");
		return (int)code;
	}
	std::wstring dll = exeDir() + L"handide-camera.dll";
	HMODULE h = LoadLibraryW(dll.c_str());
	if (!h) return 2;
	typedef HRESULT(STDAPICALLTYPE * RegFn)();
	auto fn = (RegFn)GetProcAddress(h, reg ? "DllRegisterServer" : "DllUnregisterServer");
	HRESULT hr = fn ? fn() : E_FAIL;
	return SUCCEEDED(hr) ? 0 : 1;
}

// ---------------------------------------------------------------- frames
struct Frames {
	int w, h;
	std::vector<uint8_t> waiting;  // top-down BGR24 (what softcam passes on as-is)
	std::vector<uint8_t> latest;
	std::mutex mu;
	bool live = false;
	std::atomic<bool> quit{ false };
};

// The screen shown while no phone is sending: dark background and a short message.
static std::vector<uint8_t> waitingScreen(int w, int h) {
	BITMAPINFO bi{};
	bi.bmiHeader.biSize = sizeof bi.bmiHeader;
	bi.bmiHeader.biWidth = w;
	bi.bmiHeader.biHeight = -h;  // top-down, like the camera's buffer
	bi.bmiHeader.biPlanes = 1;
	bi.bmiHeader.biBitCount = 24;
	void* bits = nullptr;
	HDC dc = CreateCompatibleDC(nullptr);
	HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
	HGDIOBJ old = SelectObject(dc, bmp);
	RECT r{ 0, 0, w, h };
	HBRUSH bg = CreateSolidBrush(RGB(24, 26, 30));
	FillRect(dc, &r, bg);
	DeleteObject(bg);
	HFONT f = CreateFontW(h / 14, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
	HGDIOBJ oldf = SelectObject(dc, f);
	SetBkMode(dc, TRANSPARENT);
	SetTextColor(dc, RGB(235, 235, 235));
	RECT t1{ 0, h / 2 - h / 10, w, h / 2 };
	DrawTextW(dc, L"handide Camera", -1, &t1, DT_CENTER | DT_BOTTOM | DT_SINGLELINE);
	HFONT f2 = CreateFontW(h / 24, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
	SelectObject(dc, f2);
	SetTextColor(dc, RGB(150, 155, 165));
	RECT t2{ 0, h / 2 + h / 40, w, h / 2 + h / 8 };
	DrawTextW(dc, L"Waiting for the phone — open handide on the phone and choose PC webcam", -1, &t2, DT_CENTER | DT_TOP | DT_SINGLELINE);
	GdiFlush();
	size_t stride = ((size_t)w * 3 + 3) & ~(size_t)3;
	std::vector<uint8_t> out((size_t)w * h * 3);
	for (int y = 0; y < h; y++) memcpy(&out[(size_t)y * w * 3], (uint8_t*)bits + y * stride, (size_t)w * 3);
	SelectObject(dc, oldf);
	SelectObject(dc, old);
	DeleteObject(f);
	DeleteObject(f2);
	DeleteObject(bmp);
	DeleteDC(dc);
	return out;
}

// JPEG -> letterboxed, top-down BGR24 of the camera's size. Checked by capturing the
// camera through DirectShow: softcam hands rows to apps in this order.
static bool decode(IWICImagingFactory* wic, const uint8_t* data, size_t n, int W, int H, std::vector<uint8_t>& out) {
	IWICStream* stream = nullptr;
	IWICBitmapDecoder* dec = nullptr;
	IWICBitmapFrameDecode* frame = nullptr;
	IWICBitmapScaler* scaler = nullptr;
	IWICFormatConverter* conv = nullptr;
	bool ok = false;
	do {
		if (FAILED(wic->CreateStream(&stream))) break;
		if (FAILED(stream->InitializeFromMemory((BYTE*)data, (DWORD)n))) break;
		if (FAILED(wic->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnDemand, &dec))) break;
		if (FAILED(dec->GetFrame(0, &frame))) break;
		UINT sw, sh;
		frame->GetSize(&sw, &sh);
		if (!sw || !sh) break;
		double k = std::min((double)W / sw, (double)H / sh);
		UINT dw = std::max(1u, (UINT)(sw * k + 0.5)), dh = std::max(1u, (UINT)(sh * k + 0.5));
		dw = std::min<UINT>(dw, W);
		dh = std::min<UINT>(dh, H);
		if (FAILED(wic->CreateBitmapScaler(&scaler))) break;
		if (FAILED(scaler->Initialize(frame, dw, dh, WICBitmapInterpolationModeLinear))) break;
		if (FAILED(wic->CreateFormatConverter(&conv))) break;
		if (FAILED(conv->Initialize(scaler, GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) break;
		std::vector<uint8_t> tmp((size_t)dw * dh * 3);
		if (FAILED(conv->CopyPixels(nullptr, dw * 3, (UINT)tmp.size(), tmp.data()))) break;
		out.assign((size_t)W * H * 3, 0);
		int ox = (W - (int)dw) / 2, oy = (H - (int)dh) / 2;
		for (UINT y = 0; y < dh; y++) {
			int dy = oy + (int)y;
			memcpy(&out[((size_t)dy * W + ox) * 3], &tmp[(size_t)y * dw * 3], (size_t)dw * 3);
		}
		ok = true;
	} while (false);
	if (conv) conv->Release();
	if (scaler) scaler->Release();
	if (frame) frame->Release();
	if (dec) dec->Release();
	if (stream) stream->Release();
	return ok;
}

static bool readAll(void* buf, size_t n) {
	uint8_t* p = (uint8_t*)buf;
	while (n) {
		int r = _read(0, p, (unsigned)std::min<size_t>(n, 1 << 20));
		if (r <= 0) return false;
		p += r;
		n -= r;
	}
	return true;
}

static int run(int W, int H, float fps) {
	std::wstring dll = exeDir() + L"handide-camera.dll";
	HMODULE h = LoadLibraryW(dll.c_str());
	if (!h) { fprintf(stderr, "cannot load %ls\n", dll.c_str()); return 2; }
	auto create = (CreateFn)GetProcAddress(h, "scCreateCamera");
	auto destroy = (DeleteFn)GetProcAddress(h, "scDeleteCamera");
	auto send = (SendFn)GetProcAddress(h, "scSendFrame");
	if (!create || !destroy || !send) { fprintf(stderr, "bad dll\n"); return 2; }
	scCamera cam = create(W, H, fps);
	if (!cam) { fprintf(stderr, "camera busy (another handide-cam is running)\n"); return 4; }
	fprintf(stderr, "ready %dx%d@%.0f\n", W, H, fps);

	Frames fr;
	fr.w = W;
	fr.h = H;
	fr.waiting = waitingScreen(W, H);

	// The camera is paced by softcam (scSendFrame sleeps to keep `fps`); it repeats the
	// newest frame, so apps get a steady stream even when the phone is slower.
	std::thread pump([&] {
		std::vector<uint8_t> cur;
		while (!fr.quit) {
			{
				std::lock_guard<std::mutex> l(fr.mu);
				cur = fr.live ? fr.latest : fr.waiting;
			}
			send(cam, cur.data());
		}
	});

	CoInitializeEx(nullptr, COINIT_MULTITHREADED);
	IWICImagingFactory* wic = nullptr;
	CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic));
	_setmode(0, _O_BINARY);
	std::vector<uint8_t> jpeg, img;
	uint32_t n;
	long long frames = 0;
	while (readAll(&n, 4)) {
		if (n == 0) {
			std::lock_guard<std::mutex> l(fr.mu);
			fr.live = false;
			continue;
		}
		if (n > 32u << 20) break;
		jpeg.resize(n);
		if (!readAll(jpeg.data(), n)) break;
		if (wic && decode(wic, jpeg.data(), n, W, H, img)) {
			std::lock_guard<std::mutex> l(fr.mu);
			fr.latest.swap(img);
			fr.live = true;
			if (++frames % 300 == 1) fprintf(stderr, "frames %lld\n", frames);
		}
	}
	fr.quit = true;
	pump.join();
	destroy(cam);
	if (wic) wic->Release();
	CoUninitialize();
	return 0;
}

int wmain(int argc, wchar_t** argv) {
	std::wstring cmd = argc > 1 ? argv[1] : L"";
	if (cmd == L"register") return registration(true);
	if (cmd == L"unregister") return registration(false);
	if (cmd == L"status") { printf("%s\n", isRegistered() ? "registered" : "not-registered"); return 0; }
	if (cmd == L"run") {
		int W = argc > 3 ? _wtoi(argv[2]) : 1280, H = argc > 3 ? _wtoi(argv[3]) : 720;
		float fps = argc > 4 ? (float)_wtof(argv[4]) : 30.0f;
		W = std::max(64, W / 4 * 4);
		H = std::max(64, H / 4 * 4);
		return run(W, H, fps);
	}
	fprintf(stderr, "usage: handide-cam run [width height fps] | register | unregister | status\n");
	return 1;
}
