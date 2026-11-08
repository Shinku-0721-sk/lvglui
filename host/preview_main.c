/**
 * @file preview_main.c
 * A 240x320 window that shows your UI and rebuilds it whenever you save.
 *
 * Architecture (chosen so hot reload is safe):
 *   preview.exe  -> window, message loop, timing, file watching. Knows no LVGL.
 *   ui.dll       -> LVGL + your ui_entry.c. Unloaded and reloaded on every save,
 *                   which throws away the entire engine state at once.
 *
 * Build: build.bat   Run: build\preview.exe
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_host.h"

#define DEFAULT_W 240
#define DEFAULT_H 320
#define POLL_MS   400

static HWND    g_hwnd;
static HMODULE g_dll;
static unsigned long long g_loaded_stamp;
static int     g_w = DEFAULT_W, g_h = DEFAULT_H;

static int                    (*p_attach)(int, int);
static int                    (*p_tick)(uint32_t);
static const void *           (*p_pixels)(int *, int *, uint32_t *);
static void                   (*p_detach)(void);

static unsigned long long dll_stamp(void);   /* mtime of build/ui.dll */

static void      *g_dib_bits;
static BITMAPINFO g_bmi;
static HBITMAP    g_dib;

/* ---- paths ---------------------------------------------------------- */
static char g_dir[MAX_PATH];      /* .../tools/ui-preview              */
static char g_dll_path[MAX_PATH]; /* .../build/ui_live_<n>.dll         */
static char g_src_mtime[64];      /* fingerprint of ui\*.c, ui\*.h     */

static void exe_dir(void)
{
    GetModuleFileNameA(NULL, g_dir, MAX_PATH);
    char *p = strrchr(g_dir, '\\');
    if(p) *p = 0;                       /* .../build */
    p = strrchr(g_dir, '\\');
    if(p) *p = 0;                       /* .../ui-preview */
}

/* Newest modification time across ui\*.c and ui\*.h, as a string. */
static void src_fingerprint(char *out, size_t n)
{
    char pat[MAX_PATH];
    WIN32_FIND_DATAA fd;
    ULONGLONG newest = 0;
    for(int pass = 0; pass < 2; ++pass) {
        snprintf(pat, sizeof(pat), "%s\\ui\\*.%s", g_dir, pass == 0 ? "c" : "h");
        HANDLE h = FindFirstFileA(pat, &fd);
        if(h == INVALID_HANDLE_VALUE) continue;
        do {
            ULONGLONG t = ((ULONGLONG)fd.ftLastWriteTime.dwHighDateTime << 32)
                          | fd.ftLastWriteTime.dwLowDateTime;
            if(t > newest) newest = t;
        } while(FindNextFileA(h, &fd));
        FindClose(h);
    }
    snprintf(out, n, "%llu", (unsigned long long)newest);
}

/* ---- DLL lifecycle --------------------------------------------------- */
static void unload_ui(void)
{
    if(g_dll) {
        if(p_detach) p_detach();
        FreeLibrary(g_dll);
        g_dll = NULL;
        p_attach = NULL; p_tick = NULL; p_pixels = NULL; p_detach = NULL;
    }
}

static int load_ui(void)
{
    /* Load a private copy so that rebuilding never fights with a file lock. */
    char src[MAX_PATH];
    snprintf(src, sizeof(src), "%s\\build\\ui.dll", g_dir);
    static int seq;
    snprintf(g_dll_path, sizeof(g_dll_path), "%s\\build\\ui_live_%d.dll", g_dir, ++seq);

    if(!CopyFileA(src, g_dll_path, FALSE)) {
        printf("[host] cannot copy %s (err %lu)\n", src, GetLastError());
        return -1;
    }
    g_dll = LoadLibraryA(g_dll_path);
    if(!g_dll) {
        printf("[host] LoadLibrary failed (err %lu)\n", GetLastError());
        return -1;
    }
    p_attach = (int (*)(int, int))            GetProcAddress(g_dll, "ui_attach");
    p_tick   = (int (*)(uint32_t))            GetProcAddress(g_dll, "ui_tick");
    p_pixels = (const void *(*)(int *, int *, uint32_t *))GetProcAddress(g_dll, "ui_pixels");
    p_detach = (void (*)(void))               GetProcAddress(g_dll, "ui_detach");
    if(!p_attach || !p_tick || !p_pixels || !p_detach) {
        printf("[host] ui.dll is missing its exports\n");
        unload_ui();
        return -1;
    }
    if(p_attach(g_w, g_h) != 0) {
        printf("[host] ui_attach failed\n");
        unload_ui();
        return -1;
    }
    g_loaded_stamp = dll_stamp();
    InvalidateRect(g_hwnd, NULL, FALSE);
    return 0;
}

/* Run build.bat and wait. Returns 0 on success.
 * No handle inheritance: the compiler gets a clean environment, and its
 * output goes to out\build.log (inherited handles from a GUI process have
 * bitten MSVC's temp files before). */
static int rebuild(void)
{
    char cmd[MAX_PATH + 256];
    char log[MAX_PATH];
    char tmp[MAX_PATH];
    snprintf(log, sizeof(log), "%s\\out\\build.log", g_dir);
    snprintf(tmp, sizeof(tmp), "%s\\build\\tmp", g_dir);
    CreateDirectoryA(tmp, NULL);
    /* Point the compiler at a local temp dir. Some sandboxed hosts refuse
     * writes to %TEMP%, which shows up as C1083 on c1's _CL_ file. */
    snprintf(cmd, sizeof(cmd),
             "cmd /c \"set TMP=%s&& set TEMP=%s&& \"%s\\build.bat\" > \"%s\" 2>&1\"",
             tmp, tmp, g_dir, log);

    STARTUPINFOA si = { sizeof(si) };
    PROCESS_INFORMATION pi = { 0 };
    if(!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, g_dir, &si, &pi)) {
        printf("[host] cannot start build.bat (err %lu)\n", GetLastError());
        return -1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return code == 0 ? 0 : -1;
}

static void reload(void)
{
    printf("\n[host] change detected, rebuilding...\n");
    unload_ui();                       /* release the file lock first */
    if(rebuild() != 0) {
        printf("[host] BUILD FAILED - keeping the window blank until it compiles\n");
        return;
    }
    if(load_ui() == 0) {
        src_fingerprint(g_src_mtime, sizeof(g_src_mtime));
        printf("[host] reloaded ok\n");
    }
}

/* mtime of build/ui.dll, so we also pick up builds started from a terminal. */
static unsigned long long dll_stamp(void)
{
    char p[MAX_PATH];
    snprintf(p, sizeof(p), "%s\\build\\ui.dll", g_dir);
    WIN32_FILE_ATTRIBUTE_DATA fa;
    if(!GetFileAttributesExA(p, GetFileExInfoStandard, &fa)) return 0;
    return ((unsigned long long)fa.ftLastWriteTime.dwHighDateTime << 32)
           | fa.ftLastWriteTime.dwLowDateTime;
}

/* ---- painting -------------------------------------------------------- */
static void paint(HWND hwnd)
{
    PAINTSTRUCT ps;
    HDC hdc = BeginPaint(hwnd, &ps);
    if(p_pixels) {
        int w = g_w, h = g_h;
        uint32_t ver = 0;
        const uint16_t *px = (const uint16_t *)p_pixels(&w, &h, &ver);
        if(px && g_dib_bits) {
            uint32_t *dst = (uint32_t *)g_dib_bits;
            for(int i = 0; i < w * h; ++i) {
                uint16_t p = px[i];
                uint32_t r = (p >> 11) & 0x1F, g = (p >> 5) & 0x3F, b = p & 0x1F;
                r = (r << 3) | (r >> 2);
                g = (g << 2) | (g >> 4);
                b = (b << 3) | (b >> 2);
                dst[i] = 0xFF000000u | (r << 16) | (g << 8) | b;
            }
            StretchDIBits(hdc, 0, 0, w, h, 0, 0, w, h,
                          g_dib_bits, &g_bmi, DIB_RGB_COLORS, SRCCOPY);
        }
    }
    EndPaint(hwnd, &ps);
}

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    switch(msg) {
        case WM_PAINT:  paint(hwnd); return 0;
        case WM_ERASEBKGND: return 1;
        case WM_DESTROY: PostQuitMessage(0); return 0;
        case WM_KEYDOWN:
            if(wp == VK_ESCAPE) PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

static void make_dib(void)
{
    g_bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    g_bmi.bmiHeader.biWidth = g_w;
    g_bmi.bmiHeader.biHeight = -g_h;      /* top-down */
    g_bmi.bmiHeader.biPlanes = 1;
    g_bmi.bmiHeader.biBitCount = 32;
    g_bmi.bmiHeader.biCompression = BI_RGB;

    HDC screen = GetDC(NULL);
    g_dib = CreateDIBSection(screen, &g_bmi, DIB_RGB_COLORS, &g_dib_bits, NULL, 0);
    ReleaseDC(NULL, screen);
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);   /* keep the log readable while running */
    SetProcessDPIAware();
    exe_dir();
    make_dib();

    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "LVGLPreviewHost";
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RegisterClassA(&wc);

    RECT rc = { 0, 0, g_w, g_h };
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    g_hwnd = CreateWindowA("LVGLPreviewHost", "LVGL Preview 240x320  (Esc to quit)",
                           WS_OVERLAPPEDWINDOW,
                           CW_USEDEFAULT, CW_USEDEFAULT,
                           rc.right - rc.left, rc.bottom - rc.top,
                           NULL, NULL, wc.hInstance, NULL);
    ShowWindow(g_hwnd, SW_SHOW);

    if(!g_dll && load_ui() != 0) {
        printf("[host] initial load failed - fix the build then save again\n");
    }
    src_fingerprint(g_src_mtime, sizeof(g_src_mtime));

    LARGE_INTEGER freq, prev;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&prev);

    DWORD last_poll = GetTickCount();
    MSG msg;
    for(;;) {
        while(PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) {
            if(msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }

        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        uint32_t ms = (uint32_t)((now.QuadPart - prev.QuadPart) * 1000 / freq.QuadPart);
        prev = now;
        if(ms) {
            if(p_tick && p_tick(ms)) InvalidateRect(g_hwnd, NULL, FALSE);
        }

        if(GetTickCount() - last_poll >= POLL_MS) {
            last_poll = GetTickCount();
            char fp[64];
            src_fingerprint(fp, sizeof(fp));
            if(strcmp(fp, g_src_mtime) != 0) {
                Sleep(150);                       /* let the editor finish */
                reload();                         /* rebuild + swap */
                src_fingerprint(g_src_mtime, sizeof(g_src_mtime));
            }
            else {
                /* Someone else rebuilt ui.dll (terminal, CI, the agent):
                 * just swap it in, no compiler needed here. */
                unsigned long long st = dll_stamp();
                if(st && st != g_loaded_stamp) {
                    printf("[host] new ui.dll detected, reloading\n");
                    unload_ui();
                    if(load_ui() == 0) printf("[host] reloaded ok\n");
                }
            }
        }
        Sleep(8);
    }
done:
    unload_ui();
    return 0;
}
