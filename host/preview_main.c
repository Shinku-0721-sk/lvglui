/**
 * @file preview_main.c
 * A live window for one LVGL UI, with save-driven hot reload.
 *
 * Architecture (chosen so hot reload is safe):
 *   preview.exe  -> window, message loop, timing, file watching. Knows no LVGL.
 *   ui.dll       -> LVGL + your ui_entry.c. Unloaded and reloaded on every save,
 *                   which throws away the entire engine state at once.
 *
 * Everything project-specific comes from the command line; the shell never
 * guesses paths from its own location:
 *
 *   --dll       <buildDir>/ui.dll
 *   --project   <project root>          (for lvglui.json / sdkconfig)
 *   --ui-dir    <UI source dir>         (recursive .c/.h fingerprint)
 *   --build-dir <buildDir>              (build.cmd, build.log, ui_live_N.dll)
 *   --build-cmd <buildDir>/build.cmd
 *   --width N --height N
 *   --watch <path>                      (optional, repeated)
 *
 * Builds run asynchronously: saving a file starts `cmd.exe /c ...` and the
 * window keeps painting the old UI until the new ui.dll loads. A failed build
 * keeps the old DLL and reports it in the title bar.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "ui_host.h"

#define DEFAULT_W       240
#define DEFAULT_H       320
#define PATH_CAP        4096
#define MAX_WATCH       16
#define BUILD_POLL_MS   33
#define FILE_POLL_MS    100
#define DEBOUNCE_MS     300

static HWND    g_hwnd;
static HMODULE g_dll;
static int     g_w = DEFAULT_W, g_h = DEFAULT_H;

static int                    (*p_attach)(int, int);
static int                    (*p_tick)(uint32_t);
static const void *           (*p_pixels)(int *, int *, uint32_t *);
static void                   (*p_detach)(void);

/* ---- paths ---------------------------------------------------------- */
static wchar_t g_dll_src[PATH_CAP];    /* --dll: ui.dll the build writes   */
static wchar_t g_project[PATH_CAP];    /* --project                        */
static wchar_t g_ui_dir[PATH_CAP];     /* --ui-dir                         */
static wchar_t g_build_dir[PATH_CAP];  /* --build-dir                      */
static wchar_t g_build_cmd[PATH_CAP];  /* --build-cmd                      */
static wchar_t g_log_path[PATH_CAP];   /* <build-dir>\build.log            */
static wchar_t g_live_path[PATH_CAP];  /* currently loaded ui_live_N.dll   */
static wchar_t g_watch[MAX_WATCH][PATH_CAP];
static int     g_watch_count;
static unsigned g_live_seq;

static char g_fp[32];                  /* last fingerprint we reacted to   */
static char g_build_fp[32];            /* sources the running build sees   */
static HANDLE g_build_proc;
static int    g_building;
static int    g_change_pending;
static DWORD  g_change_tick;
static unsigned long long g_loaded_stamp;

static void      *g_dib_bits;
static BITMAPINFO g_bmi;
static HBITMAP    g_dib;

/* ---- small path helpers --------------------------------------------- */
static int set_path(wchar_t *dst, const wchar_t *src)
{
    size_t n;
    if(!src) return -1;
    n = wcslen(src);
    if(n >= PATH_CAP) return -1;
    memcpy(dst, src, (n + 1) * sizeof(wchar_t));
    return 0;
}

static int join_path(wchar_t *out, const wchar_t *a, const wchar_t *b)
{
    size_t n;
    const wchar_t *sep;
    if(!a[0]) return set_path(out, b);
    n = wcslen(a);
    sep = (a[n - 1] == L'\\' || a[n - 1] == L'/') ? L"" : L"\\";
    return swprintf(out, PATH_CAP, L"%ls%ls%ls", a, sep, b) < 0 ? -1 : 0;
}

static void dir_of(const wchar_t *file, wchar_t *out)
{
    wchar_t *slash;
    wchar_t *fwd;
    set_path(out, file);
    slash = wcsrchr(out, L'\\');
    fwd = wcsrchr(out, L'/');
    if(fwd > slash) slash = fwd;
    if(slash) *slash = 0;
}

static void usage(void)
{
    fprintf(stderr,
            "usage: preview.exe --dll <ui.dll> --build-cmd <build.cmd>\n"
            "                   [--project <root>] [--ui-dir <dir>] [--build-dir <dir>]\n"
            "                   [--width <n>] [--height <n>] [--watch <path>]...\n");
}

/* ---- fingerprint ----------------------------------------------------- */
/* FNV-1a over the relevant files' paths, mtimes and sizes. A recursive
 * walk is required because the UI may live in nested directories. */
static void fp_add(unsigned long long *h, const void *data, size_t n)
{
    const unsigned char *p = (const unsigned char *)data;
    size_t i;
    for(i = 0; i < n; ++i) {
        *h ^= p[i];
        *h *= 1099511628211ULL;
    }
}

static void fp_add_text(unsigned long long *h, const wchar_t *text)
{
    fp_add(h, text, wcslen(text) * sizeof(wchar_t));
}

static void fp_add_stat(unsigned long long *h, const wchar_t *path)
{
    WIN32_FILE_ATTRIBUTE_DATA fa;
    fp_add_text(h, path);
    if(GetFileAttributesExW(path, GetFileExInfoStandard, &fa)) {
        fp_add(h, &fa.ftLastWriteTime, sizeof(FILETIME));
        fp_add(h, &fa.nFileSizeHigh, sizeof(DWORD));
        fp_add(h, &fa.nFileSizeLow, sizeof(DWORD));
    }
    else {
        unsigned char missing = 0;
        fp_add(h, &missing, 1);
    }
}

static void fp_walk(unsigned long long *h, const wchar_t *dir)
{
    wchar_t pattern[PATH_CAP];
    WIN32_FIND_DATAW fd;
    HANDLE found;

    if(swprintf(pattern, PATH_CAP, L"%ls\\*", dir) < 0) return;
    found = FindFirstFileW(pattern, &fd);
    if(found == INVALID_HANDLE_VALUE) return;

    do {
        wchar_t full[PATH_CAP];
        const wchar_t *ext;
        if(!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
        if(join_path(full, dir, fd.cFileName) != 0) continue;

        if(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if(!(fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) fp_walk(h, full);
            continue;
        }

        ext = wcsrchr(fd.cFileName, L'.');
        if(!ext || (_wcsicmp(ext, L".c") != 0 && _wcsicmp(ext, L".h") != 0)) continue;

        fp_add_text(h, full);
        fp_add(h, &fd.ftLastWriteTime, sizeof(FILETIME));
        fp_add(h, &fd.nFileSizeHigh, sizeof(DWORD));
        fp_add(h, &fd.nFileSizeLow, sizeof(DWORD));
    } while(FindNextFileW(found, &fd));
    FindClose(found);
}

static void src_fingerprint(char *out, size_t n)
{
    unsigned long long h = 1469598103934665603ULL;
    int i;

    if(g_ui_dir[0]) {
        fp_add_text(&h, L"ui");
        fp_walk(&h, g_ui_dir);
    }
    if(g_project[0]) {
        wchar_t p[PATH_CAP];
        if(join_path(p, g_project, L"lvglui.json") == 0) fp_add_stat(&h, p);
        if(join_path(p, g_project, L"sdkconfig") == 0) fp_add_stat(&h, p);
    }
    for(i = 0; i < g_watch_count; ++i) {
        DWORD attr = GetFileAttributesW(g_watch[i]);
        fp_add_text(&h, g_watch[i]);
        if(attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
            fp_walk(&h, g_watch[i]);
        }
        else {
            fp_add_stat(&h, g_watch[i]);
        }
    }
    if(n) snprintf(out, n, "%016llx", h);
}

static unsigned long long dll_stamp(void)
{
    WIN32_FILE_ATTRIBUTE_DATA fa;
    if(!GetFileAttributesExW(g_dll_src, GetFileExInfoStandard, &fa)) return 0;
    return ((unsigned long long)fa.ftLastWriteTime.dwHighDateTime << 32)
           | fa.ftLastWriteTime.dwLowDateTime;
}

/* ---- title ----------------------------------------------------------- */
static void set_title(const wchar_t *state)
{
    wchar_t title[256];
    swprintf(title, 256, L"LVGL Preview %dx%d  -  %ls  (Esc to quit)", g_w, g_h, state);
    if(g_hwnd) SetWindowTextW(g_hwnd, title);
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
    if(g_live_path[0]) {
        DeleteFileW(g_live_path);
        g_live_path[0] = 0;
    }
}

/* Copy ui.dll to a private ui_live_N.dll, load it and attach. The old DLL is
 * only touched after the new one is fully working; any failure leaves it in
 * place so the window keeps showing the last good UI. */
static int load_ui(void)
{
    wchar_t live[PATH_CAP];
    HMODULE lib;
    int (*attach)(int, int);
    int (*tick)(uint32_t);
    const void *(*pixels)(int *, int *, uint32_t *);
    void (*detach)(void);
    DWORD err;

    if(!g_dll_src[0] || !g_build_dir[0]) return -1;
    swprintf(live, PATH_CAP, L"%ls\\ui_live_%u.dll", g_build_dir, ++g_live_seq);

    if(!CopyFileW(g_dll_src, live, FALSE)) {
        printf("[host] cannot copy %ls (err %lu)\n", g_dll_src, GetLastError());
        return -1;
    }

    lib = LoadLibraryW(live);
    if(!lib) {
        err = GetLastError();
        printf("[host] LoadLibrary failed for %ls (err %lu)\n", live, err);
        DeleteFileW(live);
        return -1;
    }

    attach = (int (*)(int, int))            GetProcAddress(lib, "ui_attach");
    tick   = (int (*)(uint32_t))            GetProcAddress(lib, "ui_tick");
    pixels = (const void *(*)(int *, int *, uint32_t *))GetProcAddress(lib, "ui_pixels");
    detach = (void (*)(void))               GetProcAddress(lib, "ui_detach");
    if(!attach || !tick || !pixels || !detach) {
        printf("[host] ui.dll is missing its exports\n");
        FreeLibrary(lib);
        DeleteFileW(live);
        return -1;
    }

    if(attach(g_w, g_h) != 0) {
        printf("[host] ui_attach failed; keeping the previous UI\n");
        FreeLibrary(lib);
        DeleteFileW(live);
        return -1;
    }

    /* The new engine is up. Tear the old one down before swapping pointers. */
    if(g_dll) {
        if(p_detach) p_detach();
        FreeLibrary(g_dll);
    }
    if(g_live_path[0]) DeleteFileW(g_live_path);

    set_path(g_live_path, live);
    g_dll = lib;
    p_attach = attach;
    p_tick = tick;
    p_pixels = pixels;
    p_detach = detach;
    g_loaded_stamp = dll_stamp();
    InvalidateRect(g_hwnd, NULL, FALSE);
    return 0;
}

/* ---- asynchronous rebuild -------------------------------------------- */
static int start_build(const char *fp)
{
    wchar_t cmd[PATH_CAP * 2 + 64];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;

    if(g_building) return 0;

    CreateDirectoryW(g_build_dir, NULL);
    /* One /c command line: cmd.exe /c ""<build-cmd>" > "<build-dir>\build.log" 2>&1"
     * The doubled opening quote and single closing quote are what cmd expects
     * when the executable path itself is quoted. */
    if(swprintf(cmd, PATH_CAP * 2 + 64,
                L"cmd.exe /c \"\"%ls\" > \"%ls\" 2>&1\"",
                g_build_cmd, g_log_path) < 0) {
        printf("[host] build command is too long\n");
        set_title(L"build failed (see build.log)");
        return -1;
    }

    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));
    if(!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, g_build_dir, &si, &pi)) {
        printf("[host] cannot start build (err %lu)\n", GetLastError());
        set_title(L"build failed (see build.log)");
        return -1;
    }

    CloseHandle(pi.hThread);
    g_build_proc = pi.hProcess;
    g_building = 1;
    g_change_pending = 0;
    snprintf(g_build_fp, sizeof(g_build_fp), "%s", fp);
    set_title(L"building...");
    printf("\n[host] change detected, rebuilding...\n");
    return 0;
}

static void finish_build(void)
{
    DWORD code = 1;
    char now[32];

    if(!g_build_proc) {
        g_building = 0;
        return;
    }
    GetExitCodeProcess(g_build_proc, &code);
    CloseHandle(g_build_proc);
    g_build_proc = NULL;
    g_building = 0;

    src_fingerprint(now, sizeof(now));
    if(code == 0) {
        if(load_ui() == 0) {
            set_title(L"ready");
            printf("[host] reloaded ok\n");
        }
        else {
            printf("[host] new ui.dll could not be loaded; keeping the previous UI\n");
            set_title(L"reload failed (see build.log)");
        }
    }
    else {
        printf("[host] BUILD FAILED - keeping the previous UI (see %ls)\n", g_log_path);
        set_title(L"build failed (see build.log)");
    }

    /* Treat the sources this build saw as the new baseline even on failure,
     * otherwise a broken save would retrigger the same build forever. */
    snprintf(g_fp, sizeof(g_fp), "%s", g_build_fp);
    g_change_pending = 0;
    if(strcmp(now, g_build_fp) != 0) {
        /* The user saved again during the build; debounce a fresh rebuild. */
        g_change_pending = 1;
        g_change_tick = GetTickCount();
    }
}

static void poll_files(void)
{
    char now[32];
    DWORD tick;

    if(g_building) return;
    src_fingerprint(now, sizeof(now));

    if(strcmp(now, g_fp) != 0) {
        tick = GetTickCount();
        if(!g_change_pending) {
            g_change_pending = 1;
            g_change_tick = tick;
        }
        else if(tick - g_change_tick >= DEBOUNCE_MS) {
            g_change_pending = 0;
            if(start_build(now) != 0) {
                /* Never loop on a build that cannot even start. */
                snprintf(g_fp, sizeof(g_fp), "%s", now);
            }
        }
        return;
    }

    g_change_pending = 0;

    /* Someone else rebuilt ui.dll (terminal, CI, the agent): swap it in
     * without invoking the compiler ourselves. */
    {
        unsigned long long stamp = dll_stamp();
        if(stamp && stamp != g_loaded_stamp) {
            printf("[host] new ui.dll detected, reloading\n");
            if(load_ui() == 0) {
                set_title(L"ready");
                printf("[host] reloaded ok\n");
            }
        }
    }
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
    return DefWindowProcW(hwnd, msg, wp, lp);
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

/* ---- entry ----------------------------------------------------------- */
static int parse_args(int argc, wchar_t **argv)
{
    int i;
    for(i = 1; i < argc; ++i) {
        const wchar_t *a = argv[i];
        if(!wcscmp(a, L"--dll")) {
            if(++i >= argc || set_path(g_dll_src, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--project")) {
            if(++i >= argc || set_path(g_project, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--ui-dir")) {
            if(++i >= argc || set_path(g_ui_dir, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--build-dir")) {
            if(++i >= argc || set_path(g_build_dir, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--build-cmd")) {
            if(++i >= argc || set_path(g_build_cmd, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--width")) {
            int value;
            if(++i >= argc) return 2;
            value = _wtoi(argv[i]);
            if(value <= 0 || value > 10000) return 2;
            g_w = value;
        }
        else if(!wcscmp(a, L"--height")) {
            int value;
            if(++i >= argc) return 2;
            value = _wtoi(argv[i]);
            if(value <= 0 || value > 10000) return 2;
            g_h = value;
        }
        else if(!wcscmp(a, L"--watch")) {
            if(++i >= argc || g_watch_count >= MAX_WATCH) return 2;
            if(set_path(g_watch[g_watch_count], argv[i]) != 0) return 2;
            g_watch_count++;
        }
        else {
            return 2;
        }
    }

    if(!g_dll_src[0] || !g_build_cmd[0]) return 2;
    if(!g_build_dir[0]) {
        dir_of(g_dll_src, g_build_dir);
        if(!g_build_dir[0]) return 2;
    }
    if(join_path(g_log_path, g_build_dir, L"build.log") != 0) return 2;
    return 0;
}

int wmain(int argc, wchar_t **argv)
{
    if(parse_args(argc, argv) != 0) {
        usage();
        return 2;
    }

    setvbuf(stdout, NULL, _IONBF, 0);   /* keep the log readable while running */
    SetProcessDPIAware();
    make_dib();

    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.lpszClassName = L"LVGLPreviewHost";
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    RegisterClassExW(&wc);

    RECT rc = { 0, 0, g_w, g_h };
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);
    g_hwnd = CreateWindowExW(0, L"LVGLPreviewHost", L"LVGL Preview",
                             WS_OVERLAPPEDWINDOW,
                             CW_USEDEFAULT, CW_USEDEFAULT,
                             rc.right - rc.left, rc.bottom - rc.top,
                             NULL, NULL, wc.hInstance, NULL);
    if(!g_hwnd) {
        fprintf(stderr, "[host] cannot create the preview window (err %lu)\n", GetLastError());
        unload_ui();
        return 1;
    }
    ShowWindow(g_hwnd, SW_SHOW);

    src_fingerprint(g_fp, sizeof(g_fp));
    if(load_ui() != 0) {
        printf("[host] initial ui.dll load failed - fix the build then save again\n");
        set_title(L"build failed (see build.log)");
    }
    else {
        set_title(L"ready");
    }

    LARGE_INTEGER freq, prev;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&prev);

    DWORD last_build_poll = 0;
    DWORD last_file_poll = 0;
    MSG msg;
    for(;;) {
        while(PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if(msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        uint32_t ms = (uint32_t)((now.QuadPart - prev.QuadPart) * 1000 / freq.QuadPart);
        prev = now;
        if(ms) {
            if(p_tick && p_tick(ms)) InvalidateRect(g_hwnd, NULL, FALSE);
        }

        DWORD tick = GetTickCount();
        if(g_building) {
            if(tick - last_build_poll >= BUILD_POLL_MS) {
                last_build_poll = tick;
                if(g_build_proc && WaitForSingleObject(g_build_proc, 0) == WAIT_OBJECT_0) {
                    finish_build();
                }
            }
        }
        else if(tick - last_file_poll >= FILE_POLL_MS) {
            last_file_poll = tick;
            poll_files();
        }
        Sleep(8);
    }
done:
    g_building = 0;
    if(g_build_proc) {
        CloseHandle(g_build_proc);
        g_build_proc = NULL;
    }
    unload_ui();
    return 0;
}