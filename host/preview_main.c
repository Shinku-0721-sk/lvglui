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
 *   --topmost                           (optional; Ctrl+Alt+T toggles it)
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
#include <stdarg.h>
#include <wchar.h>
#include "ui_host.h"

#define DEFAULT_W       240
#define DEFAULT_H       320
#define PATH_CAP        4096
#define MAX_WATCH       16
#define BUILD_POLL_MS   33
#define FILE_POLL_MS    50
#define DEBOUNCE_MS     100

static HWND    g_hwnd;
static HMODULE g_dll;
static int     g_w = DEFAULT_W, g_h = DEFAULT_H;

static int                    (*p_attach)(int, int);
static int                    (*p_tick)(uint32_t);
static const void *           (*p_pixels)(int *, int *, uint32_t *);
static void                   (*p_detach)(void);
static int                    (*p_page_total)(void);
static const char *           (*p_page_name)(int);
static int                    (*p_page_index)(const char *);
static int                    (*p_set_page)(int);
static int                    (*p_goto_page)(int);
static int                    (*p_scroll)(int, int, int, int);

/* Page navigation (optional ui_page_* contract). g_page_index -1 means the
 * entry function chose the screen; names are kept in UTF-8 for the ABI. */
static wchar_t g_page_request[128];    /* --page: a page name or a 1-based page number */
static int     g_page_index = -1;
static char    g_page_name[64];
static int     g_page_total;

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

/* rebuild acceleration: one captured VS environment, then plain cmake */
static wchar_t g_cmake[PATH_CAP];       /* --cmake: cmake.exe                */
static wchar_t g_vcvars[PATH_CAP];      /* --vcvars: vcvars64.bat            */
static wchar_t g_vsenv_path[PATH_CAP];  /* <build-dir>\vsenv.txt             */
static wchar_t g_fast_cmd_path[PATH_CAP]; /* <build-dir>\build-fast.cmd      */
static int     g_env_ready;
static HANDLE  g_env_proc;              /* background vcvars capture         */
static DWORD   g_build_started;

/* window quality-of-life */
static wchar_t g_pos_path[PATH_CAP];    /* <build-dir>\preview-window.txt    */
static wchar_t g_dbg_path[PATH_CAP];    /* <build-dir>\preview-debug.log     */
static int     g_debug;

/* always-on-top: --topmost pins it from the start, Ctrl+Alt+T toggles it while
 * the window is open, and the last state is remembered with the position. */
static int     g_topmost;
static int     g_topmost_forced;
static int     g_hotkey_ok;
static wchar_t g_title_state[128] = L"starting";

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

/* Page names cross the ABI as UTF-8 C strings; the window needs them for the
 * title bar, so keep the conversion in one place. */
static int utf8_to_wide(const char *src, wchar_t *dst, int cap)
{
    int n;
    if(!src || !dst || cap <= 0) return 0;
    n = MultiByteToWideChar(CP_UTF8, 0, src, -1, dst, cap);
    if(n <= 0) dst[0] = 0;
    return n > 0 ? n - 1 : 0;
}

static int wide_to_utf8(const wchar_t *src, char *dst, int cap)
{
    int n;
    if(!src || !dst || cap <= 0) return 0;
    n = WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, cap, NULL, NULL);
    if(n <= 0) dst[0] = 0;
    return n > 0 ? n - 1 : 0;
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

/* ---- diagnostics ------------------------------------------------------ */
/* Only written when LVGLUI_PREVIEW_DEBUG is set. It exists to answer one
 * question on a machine we cannot see: which mouse messages did the window
 * actually receive? */
static void dbg(const char *fmt, ...)
{
    va_list ap;
    FILE *f;

    if(!g_debug || !g_dbg_path[0]) return;
    f = _wfopen(g_dbg_path, L"a");
    if(!f) return;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

/* ---- window position -------------------------------------------------- */
static void save_window_pos(void)
{
    RECT r;
    FILE *f;

    if(!g_hwnd || !g_pos_path[0]) return;
    if(!GetWindowRect(g_hwnd, &r)) return;
    f = _wfopen(g_pos_path, L"w");
    if(!f) return;
    fprintf(f, "%ld %ld %d\n", (long)r.left, (long)r.top, g_topmost);
    fclose(f);
}

static int load_window_pos(int *x, int *y, int *topmost)
{
    FILE *f;
    long a, b;
    int t = 0;
    RECT work;
    POINT corner;

    if(!g_pos_path[0]) return -1;
    f = _wfopen(g_pos_path, L"r");
    if(!f) return -1;
    if(fscanf(f, "%ld %ld %d", &a, &b, &t) < 2) { fclose(f); return -1; }
    fclose(f);

    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    corner.x = (LONG)a + 32;
    corner.y = (LONG)b + 32;
    if(!PtInRect(&work, corner)) return -1;
    *x = (int)a;
    *y = (int)b;
    if(topmost) *topmost = t != 0;
    return 0;
}

/* ---- cached Visual Studio environment ---------------------------------
 * build.cmd spends ~1.3s inside vcvars64.bat and another ~0.3s re-running
 * CMake before ninja does anything. Both costs are per save and both are
 * avoidable: capture the environment vcvars produces once, then replay it
 * from a generated batch file, so a rebuild is just "cmd -> cmake --build".
 * The environment is replayed as text rather than as a CreateProcess block
 * because a custom lpEnvironment is rejected in some sandboxed contexts. */
static int capture_vsenv(void)
{
    wchar_t cmd[PATH_CAP * 3];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD code = 1;

    if(!g_vsenv_path[0] || !g_vcvars[0]) return -1;
    DeleteFileW(g_vsenv_path);
    /* cmd /u makes `set` write UTF-16LE, which keeps non-ASCII paths intact */
    if(swprintf(cmd, PATH_CAP * 3,
                L"cmd.exe /u /c \"\"%ls\" >nul && set > \"%ls\"\"",
                g_vcvars, g_vsenv_path) < 0) {
        return -1;
    }
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));
    if(!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, g_build_dir, &si, &pi)) {
        return -1;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, 60 * 1000);
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    return code == 0 ? 0 : -1;
}

static int env_cmp(const void *a, const void *b)
{
    return _wcsicmp(*(const wchar_t *const *)a, *(const wchar_t *const *)b);
}

/* Batch files are read in the OEM code page, so anything outside printable
 * ASCII could be mangled. Writing it anyway would hand cmd a corrupt PATH;
 * skippable values are dropped, toolchain-critical ones abort the fast path. */
static int is_ascii(const wchar_t *s)
{
    for(; *s; ++s) {
        if(*s < 0x20 || *s > 0x7e) return 0;
    }
    return 1;
}

/* `set "K=V"` with % doubled, so cmd cannot expand anything inside a value. */
static int put_raw(FILE *f, const wchar_t *s)
{
    for(; *s; ++s) fputc((int)*s, f);
    return 0;
}

static int put_ascii(FILE *f, const wchar_t *s)
{
    if(!is_ascii(s)) return -1;
    return put_raw(f, s);
}

/* `set "K=V"` with % doubled, so cmd cannot expand anything inside a value. */
static int put_assign(FILE *f, const wchar_t *pair)
{
    const wchar_t *p;

    if(!is_ascii(pair)) return -1;
    fputs("set \"", f);
    for(p = pair; *p; ++p) {
        if(*p == L'%') fputc('%', f);   /* keep cmd from expanding a value */
        fputc((int)*p, f);
    }
    fputs("\"\r\n", f);
    return 0;
}

static int write_fast_cmd(void)
{
    FILE *in, *out;
    long bytes;
    unsigned char *raw;
    wchar_t *text, *cursor;
    wchar_t **items;
    int count = 0, cap = 0, i, status = 0;

    if(!g_vsenv_path[0] || !g_fast_cmd_path[0] || !g_cmake[0]) return -1;

    in = _wfopen(g_vsenv_path, L"rb");
    if(!in) return -1;
    fseek(in, 0, SEEK_END);
    bytes = ftell(in);
    fseek(in, 0, SEEK_SET);
    if(bytes <= 4 || bytes > 4 * 1024 * 1024) { fclose(in); return -1; }
    raw = (unsigned char *)malloc((size_t)bytes);
    if(!raw) { fclose(in); return -1; }
    if(fread(raw, 1, (size_t)bytes, in) != (size_t)bytes) {
        free(raw);
        fclose(in);
        return -1;
    }
    fclose(in);

    {
        size_t off = (bytes >= 2 && raw[0] == 0xFF && raw[1] == 0xFE) ? 2 : 0;
        size_t len = ((size_t)bytes - off) / 2;
        text = (wchar_t *)malloc((len + 1) * sizeof(wchar_t));
        if(!text) { free(raw); return -1; }
        memcpy(text, raw + off, len * sizeof(wchar_t));
        text[len] = 0;
    }
    free(raw);

    items = (wchar_t **)malloc(256 * sizeof(*items));
    if(!items) { free(text); return -1; }
    cap = 256;
    cursor = text;
    while(*cursor) {
        wchar_t *nl = wcschr(cursor, L'\n');
        size_t len;
        if(nl) *nl = 0;
        len = wcslen(cursor);
        while(len && cursor[len - 1] == L'\r') cursor[--len] = 0;
        if(len && cursor[0] != L'=') {
            int skip = 0;
            const wchar_t *eq = wcschr(cursor, L'=');
            if(eq) {
                size_t name = (size_t)(eq - cursor);
                /* the per-build temp dir is ours, not vcvars's */
                if(name == 3 && !_wcsnicmp(cursor, L"TMP", 3)) skip = 1;
                if(name == 4 && !_wcsnicmp(cursor, L"TEMP", 4)) skip = 1;
            }
            if(!skip) {
                if(count == cap) {
                    wchar_t **grown = (wchar_t **)realloc(items, (size_t)(cap * 2) * sizeof(*items));
                    if(!grown) { status = -1; break; }
                    items = grown;
                    cap *= 2;
                }
                items[count++] = cursor;
            }
        }
        if(!nl) break;
        cursor = nl + 1;
    }

    out = status == 0 ? _wfopen(g_fast_cmd_path, L"wb") : NULL;
    if(!out) {
        free(items);
        free(text);
        return -1;
    }

    qsort(items, (size_t)count, sizeof(*items), env_cmp);
    fputs("@echo off\r\nsetlocal\r\n", out);

    {
        wchar_t tmpdir[PATH_CAP + 8];
        if(status == 0 && join_path(tmpdir, g_build_dir, L"tmp") == 0) {
            CreateDirectoryW(tmpdir, NULL);
            if(put_ascii(out, L"set \"TMP=") != 0 || put_ascii(out, tmpdir) != 0) status = -1;
            else fputs("\"\r\n", out);
            if(status == 0) {
                if(put_ascii(out, L"set \"TEMP=") != 0 || put_ascii(out, tmpdir) != 0) status = -1;
                else fputs("\"\r\n", out);
            }
        }
    }

    for(i = 0; i < count && status == 0; ++i) {
        if(!is_ascii(items[i])) {
            /* e.g. some IDE's VM_OPTIONS pointing into a non-ASCII folder.
             * Harmless for the build, but PATH/INCLUDE/LIB cannot be dropped. */
            const wchar_t *eq = wcschr(items[i], L'=');
            size_t name = eq ? (size_t)(eq - items[i]) : 0;
            int critical = (name == 4 && !_wcsnicmp(items[i], L"PATH", 4))
                        || (name == 7 && !_wcsnicmp(items[i], L"INCLUDE", 7))
                        || (name == 7 && !_wcsnicmp(items[i], L"LIBPATH", 7))
                        || (name == 3 && !_wcsnicmp(items[i], L"LIB", 3));
            if(critical) status = -1;
            continue;
        }
        if(put_assign(out, items[i]) != 0) status = -1;
    }

    if(status == 0) {
        fputs("\"", out);
        if(put_ascii(out, g_cmake) != 0) status = -1;
    }
    if(status == 0) {
        fputs("\" --build \"", out);
        if(put_ascii(out, g_build_dir) != 0) status = -1;
    }
    if(status == 0) {
        fputs("\" --target ui\r\n", out);
    }
    if(status == 0) fputs("exit /b %ERRORLEVEL%\r\n", out);
    fclose(out);

    if(status == 0) {
        g_env_ready = 1;
    }
    else {
        DeleteFileW(g_fast_cmd_path);
    }
    free(items);
    free(text);
    return status;
}

static int ensure_vsenv(void)
{
    WIN32_FILE_ATTRIBUTE_DATA va, vb;
    int stale = 1;

    if(g_env_ready) return 0;
    if(!g_vcvars[0] || !g_vsenv_path[0]) return -1;
    if(g_env_proc) return -1;   /* capture still running; use the slow path */
    if(GetFileAttributesExW(g_vsenv_path, GetFileExInfoStandard, &va) &&
       GetFileAttributesExW(g_vcvars, GetFileExInfoStandard, &vb)) {
        stale = CompareFileTime(&va.ftLastWriteTime, &vb.ftLastWriteTime) < 0;
    }
    if(stale && capture_vsenv() != 0) return -1;
    return write_fast_cmd();
}

static void start_env_capture(void)
{
    wchar_t cmd[PATH_CAP * 3];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;

    if(!g_cmake[0] || !g_vcvars[0] || !g_vsenv_path[0]) return;
    if(swprintf(cmd, PATH_CAP * 3,
                L"cmd.exe /u /c \"\"%ls\" >nul && set > \"%ls\"\"",
                g_vcvars, g_vsenv_path) < 0) {
        return;
    }
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));
    if(!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, g_build_dir, &si, &pi)) {
        return;
    }
    CloseHandle(pi.hThread);
    g_env_proc = pi.hProcess;
}

static void poll_env_capture(void)
{
    DWORD code = 1;

    if(!g_env_proc) return;
    if(WaitForSingleObject(g_env_proc, 0) != WAIT_OBJECT_0) return;
    GetExitCodeProcess(g_env_proc, &code);
    CloseHandle(g_env_proc);
    g_env_proc = NULL;
    if(code == 0 && write_fast_cmd() == 0) {
        printf("[host] build environment cached - later rebuilds skip vcvars\n");
    }
}

static void usage(void)
{
    fprintf(stderr,
            "usage: preview.exe --dll <ui.dll> --build-cmd <build.cmd>\n"
            "                   [--project <root>] [--ui-dir <dir>] [--build-dir <dir>]\n"
            "                   [--cmake <exe>] [--vcvars <bat>]\n"
            "                   [--width <n>] [--height <n>] [--topmost] [--page <name>]\n"
            "                   [--watch <path>]...\n");
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
    wchar_t title[400];
    wchar_t page[192] = L"";
    wchar_t label[64];
    if(state) {
        lstrcpynW(g_title_state, state, 128);
    }
    if(g_page_total > 0) {
        if(g_page_index >= 0) {
            label[0] = 0;
            if(g_page_name[0]) utf8_to_wide(g_page_name, label, 64);
            swprintf(page, 192, L"  -  page %d/%d%s%ls",
                     g_page_index + 1, g_page_total,
                     label[0] ? L" " : L"", label);
        }
        else {
            swprintf(page, 192, L"  -  entry (%d pages)", g_page_total);
        }
        if(g_page_total > 1) {
            wcsncat(page, L"  [PgUp/PgDn]", 191 - wcslen(page));
        }
    }
    swprintf(title, 400, L"LVGL Preview %dx%d  -  %ls%ls  (Esc to quit)%ls",
             g_w, g_h, g_title_state, page, g_topmost ? L"  [topmost]" : L"");
    if(g_hwnd) SetWindowTextW(g_hwnd, title);
}

/* ---- always-on-top --------------------------------------------------- */
static void apply_topmost(void)
{
    if(!g_hwnd) return;
    SetWindowPos(g_hwnd, g_topmost ? HWND_TOPMOST : HWND_NOTOPMOST,
                 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    set_title(NULL);
}

/* ---- page navigation -------------------------------------------------- */
static void goto_page(int index)
{
    const char *name;
    if(!p_goto_page || g_page_total <= 0) return;
    if(index < 0 || index >= g_page_total) return;
    if(p_goto_page(index) != 0) return;

    g_page_index = index;
    name = p_page_name ? p_page_name(index) : NULL;
    if(name && name[0]) snprintf(g_page_name, sizeof(g_page_name), "%s", name);
    else g_page_name[0] = 0;

    InvalidateRect(g_hwnd, NULL, FALSE);
    set_title(NULL);
}

static void step_page(int delta)
{
    int next;
    if(g_page_total <= 1) return;
    if(g_page_index < 0) next = delta > 0 ? 0 : g_page_total - 1;
    else next = (g_page_index + delta + g_page_total) % g_page_total;
    goto_page(next);
}

/* ---- DLL lifecycle --------------------------------------------------- */
static void unload_ui(void)
{
    if(g_dll) {
        if(p_detach) p_detach();
        FreeLibrary(g_dll);
        g_dll = NULL;
        p_attach = NULL; p_tick = NULL; p_pixels = NULL; p_detach = NULL;
        p_page_total = NULL; p_page_name = NULL; p_page_index = NULL;
        p_set_page = NULL; p_goto_page = NULL; p_scroll = NULL;
        g_page_total = 0;
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
    int total = 0;
    int initial = 0;
    int requested = -1;

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

    /* The page exports are optional: a ui.dll built without the multi-page
       contract simply has no pages, and the window keeps its old behaviour. */
    p_page_total = (int (*)(void))          GetProcAddress(lib, "ui_page_total");
    p_page_name  = (const char *(*)(int))   GetProcAddress(lib, "ui_page_name_at");
    p_page_index = (int (*)(const char *))  GetProcAddress(lib, "ui_page_index");
    p_set_page   = (int (*)(int))           GetProcAddress(lib, "ui_set_page");
    p_goto_page  = (int (*)(int))           GetProcAddress(lib, "ui_goto_page");
    p_scroll     = (int (*)(int, int, int, int)) GetProcAddress(lib, "ui_wheel");

    /* Resolve the page before attach so the very first screen is the one the
       user asked for; on hot reload the page they are looking at wins. */
    total = p_page_total ? p_page_total() : 0;
    initial = (g_dll == NULL);
    requested = -1;
    if(g_page_request[0]) {
        if(total > 0) {
            wchar_t *end = NULL;
            long numeric = wcstol(g_page_request, &end, 10);
            /* Numbers follow the title and the 1-9 keys: page 2 means index 1. */
            if(end && *end == 0 && end != g_page_request) {
                requested = (numeric >= 1 && numeric <= total) ? (int)numeric - 1 : -1;
            }
            else {
                char name[160];
                wide_to_utf8(g_page_request, name, sizeof(name));
                requested = p_page_index ? p_page_index(name) : -1;
            }
        }
    }
    else if(g_page_index >= 0 && total > 0) {
        if(g_page_name[0] && p_page_index) requested = p_page_index(g_page_name);
        if(requested < 0 && g_page_index < total) requested = g_page_index;
    }

    if(g_page_request[0] && (requested < 0 || requested >= total)) {
        int i;
        printf("[host] unknown page \"%ls\" - this UI has %d page(s)\n",
               g_page_request, total);
        for(i = 0; i < total; ++i) {
            const char *name = p_page_name ? p_page_name(i) : NULL;
            printf("  [%d] %s\n", i, name ? name : "?");
        }
        /* A typo on the command line is a hard error; a page that vanished
           during a hot reload falls back to the entry screen instead. */
        if(initial) {
            wchar_t state[128];
            swprintf(state, 128, L"unknown page \"%ls\"", g_page_request);
            for(i = 0; i < total; ++i) {
                const char *pname = p_page_name ? p_page_name(i) : NULL;
                if(pname && pname[0]) {
                    wchar_t wide_name[32];
                    utf8_to_wide(pname, wide_name, 32);
                    wcsncat(state, i ? L", " : L": ", 127 - wcslen(state));
                    wcsncat(state, wide_name, 127 - wcslen(state));
                }
            }
            if(total == 0) {
                wcsncat(state, L" - this UI has no pages", 127 - wcslen(state));
            }
            set_title(state);
            FreeLibrary(lib);
            DeleteFileW(live);
            return -2;
        }
        requested = -1;
    }
    if(requested >= 0 && p_set_page) p_set_page(requested);

    if(attach(g_w, g_h) != 0) {
        printf("[host] ui_attach failed; keeping the previous UI\n");
        FreeLibrary(lib);
        DeleteFileW(live);
        return -1;
    }

    g_page_total = total;
    if(requested >= 0) {
        const char *name = p_page_name ? p_page_name(requested) : NULL;
        g_page_index = requested;
        if(name && name[0]) snprintf(g_page_name, sizeof(g_page_name), "%s", name);
        else g_page_name[0] = 0;
    }
    else if(total > 0) {
        /* 模板工程的入口屏就是第 0 页（ui_start -> ui_page_show(0)）；把它
           当作当前页，第一次按 → 才会去第 1 页，而不是把首页重建一遍。 */
        const char *name = p_page_name ? p_page_name(0) : NULL;
        g_page_index = 0;
        if(name && name[0]) snprintf(g_page_name, sizeof(g_page_name), "%s", name);
        else g_page_name[0] = 0;
    }
    else {
        g_page_index = -1;
        g_page_name[0] = 0;
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
    int fast;

    if(g_building) return 0;

    CreateDirectoryW(g_build_dir, NULL);
    fast = (g_env_ready || ensure_vsenv() == 0) && g_fast_cmd_path[0] != 0;
    if(fast) {
        fast = swprintf(cmd, PATH_CAP * 2 + 64,
                        L"cmd.exe /c \"\"%ls\" > \"%ls\" 2>&1\"",
                        g_fast_cmd_path, g_log_path) >= 0;
    }
    /* One /c command line: cmd.exe /c ""<build-cmd>" > "<build-dir>\build.log" 2>&1"
     * The doubled opening quote and single closing quote are what cmd expects
     * when the executable path itself is quoted. */
    if(!fast && swprintf(cmd, PATH_CAP * 2 + 64,
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
    g_build_started = GetTickCount();
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
    if(g_build_started) {
        printf("[host] build took %lu ms\n",
               (unsigned long)(GetTickCount() - g_build_started));
        g_build_started = 0;
    }

    src_fingerprint(now, sizeof(now));
    if(code == 0) {
        if(load_ui() == 0) {
            set_title(L"ready");
            printf("[host] reloaded ok\n");
        }
        else {
            printf("[host] new ui.dll could not be loaded; keeping the previous UI\n");
            /* Remember the bad stamp so poll_files does not retry it every
             * 100ms. The next source build or external rebuild changes the
             * stamp and gets a fresh attempt. */
            g_loaded_stamp = dll_stamp();
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
            else {
                printf("[host] ui.dll reload failed; keeping the previous UI\n");
                g_loaded_stamp = stamp;
                set_title(L"reload failed (see build.log)");
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
        case WM_DESTROY: save_window_pos(); PostQuitMessage(0); return 0;
        case WM_EXITSIZEMOVE: save_window_pos(); break;
        case WM_NCLBUTTONDOWN: case WM_NCLBUTTONUP:
        case WM_LBUTTONDOWN: case WM_LBUTTONUP:
        case WM_ENTERSIZEMOVE: case WM_MOVING: case WM_SIZING:
            dbg("msg=0x%04X wp=%llu lp=%lld cursor=%ld,%ld",
                msg, (unsigned long long)wp, (long long)lp,
                (long)(short)LOWORD(lp), (long)(short)HIWORD(lp));
            break;
        case WM_NCHITTEST: {
            /* Dragging the canvas is the intuitive way to move a 240x320
             * window, and 1.x has no clickable widgets to steal the press
             * from. Frame edges still resize through DefWindowProc. */
            LRESULT hit = DefWindowProcW(hwnd, msg, wp, lp);
            if(hit == HTCLIENT) hit = HTCAPTION;
            return hit;
        }
        case WM_MOUSEWHEEL: {
            /* Wheel: hand the client point and pixel deltas to ui.dll, which
             * hit-tests the deepest scrollable object and moves its offset.
             * delta > 0 means "away from the user" (show earlier content),
             * hence the negated dy. */
            POINT pt;
            pt.x = (short)LOWORD(lp);
            pt.y = (short)HIWORD(lp);
            ScreenToClient(hwnd, &pt);
            if(p_scroll) {
                int delta = GET_WHEEL_DELTA_WPARAM(wp);
                int notches = delta / WHEEL_DELTA;
                int step = 40;
                if(notches == 0) notches = delta > 0 ? 1 : -1;
                if(wp & MK_SHIFT) p_scroll(pt.x, pt.y, -notches * step, 0);
                else p_scroll(pt.x, pt.y, 0, -notches * step);
            }
            return 0;
        }
        case WM_KEYDOWN:
            if(wp == VK_ESCAPE) PostQuitMessage(0);
            else if(wp == VK_NEXT || wp == VK_RIGHT) step_page(1);
            else if(wp == VK_PRIOR || wp == VK_LEFT) step_page(-1);
            else if(wp >= '1' && wp <= '9') goto_page((int)(wp - '1'));
            return 0;
        case WM_HOTKEY:
            /* Ctrl+Alt+T: pin/unpin without restarting the preview. */
            if(wp == 1) {
                g_topmost = !g_topmost;
                apply_topmost();
            }
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
        else if(!wcscmp(a, L"--cmake")) {
            if(++i >= argc || set_path(g_cmake, argv[i]) != 0) return 2;
        }
        else if(!wcscmp(a, L"--vcvars")) {
            if(++i >= argc || set_path(g_vcvars, argv[i]) != 0) return 2;
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
        else if(!wcscmp(a, L"--topmost")) {
            g_topmost = 1;
            g_topmost_forced = 1;
        }
        else if(!wcscmp(a, L"--page")) {
            if(++i >= argc || set_path(g_page_request, argv[i]) != 0) return 2;
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

    join_path(g_vsenv_path, g_build_dir, L"vsenv.txt");
    join_path(g_fast_cmd_path, g_build_dir, L"build-fast.cmd");
    join_path(g_pos_path, g_build_dir, L"preview-window.txt");
    join_path(g_dbg_path, g_build_dir, L"preview-debug.log");
    g_debug = _wgetenv(L"LVGLUI_PREVIEW_DEBUG") != NULL;

    {
        HMODULE user32 = GetModuleHandleW(L"user32.dll");
        BOOL (WINAPI *set_ctx)(HANDLE) = user32
            ? (BOOL (WINAPI *)(HANDLE))GetProcAddress(user32, "SetProcessDpiAwarenessContext")
            : NULL;
        /* Per-monitor v2 keeps the framebuffer at 1:1 pixels on scaled
         * desktops; older Windows keeps the coarse system-aware mode. */
        if(!set_ctx || !set_ctx((HANDLE)-4)) SetProcessDPIAware();
    }
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
    {
        RECT work, wr;
        int ww, wh, x, y;
        int remembered_topmost = 0;
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
        GetWindowRect(g_hwnd, &wr);
        ww = wr.right - wr.left;
        wh = wr.bottom - wr.top;
        /* Reopen where the user left it; only fall back to centering when
         * there is no remembered position (or it belongs to a monitor that
         * is no longer there). The remembered pin state is only used when
         * --topmost was not given on the command line. */
        if(load_window_pos(&x, &y, &remembered_topmost) != 0) {
            x = work.left + (work.right - work.left - ww) / 2;
            y = work.top + (work.bottom - work.top - wh) / 2;
        }
        else if(!g_topmost_forced) {
            g_topmost = remembered_topmost;
        }
        SetWindowPos(g_hwnd, HWND_TOP, x, y, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW);
    }
    SetForegroundWindow(g_hwnd);
    BringWindowToTop(g_hwnd);

    if(g_topmost) apply_topmost();
    g_hotkey_ok = RegisterHotKey(g_hwnd, 1, MOD_CONTROL | MOD_ALT, (UINT)'T');
    if(!g_hotkey_ok) {
        fprintf(stderr, "[host] cannot register Ctrl+Alt+T (err %lu)\n", GetLastError());
    }

    src_fingerprint(g_fp, sizeof(g_fp));
    {
        int load = load_ui();
        if(load != 0) {
            printf("[host] initial ui.dll load failed - fix the build then save again\n");
            /* Do not hot-loop on an unloadable ui.dll; wait for a changed stamp. */
            g_loaded_stamp = dll_stamp();
            /* -2 means load_ui already put a precise "unknown page" title up. */
            if(load != -2) set_title(L"reload failed (see build.log)");
        }
        else {
            set_title(L"ready");
        }
    }

    /* Capture the VS environment in the background so the first save after
     * startup already rebuilds without vcvars. */
    start_env_capture();

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
        poll_env_capture();
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
