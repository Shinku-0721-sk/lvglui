/**
 * @file shot_main.c
 * Headless renderer: builds the UI into an in-memory RGB565 framebuffer,
 * advances a fixed number of frames, writes the result as a PNG.
 *
 * No window, no wall clock -> two runs of the same UI produce identical
 * pixels. That determinism is what makes "render, look, fix" loops reliable.
 *
 * Same ui_entry.c and same LVGL sources as ui.dll, and RGB565 like the panel,
 * so the picture is what the board will show.
 *
 *   shot.exe [--out preview.png] [--frames 12] [--tree tree.json]
 *            [--raw frame.bin] [--page N] [--list-pages pages.txt]
 *            [--scroll <y>|<name>=<y>|<...>=bottom]
 *
 * `--page N` renders one page of the optional ui_page_* contract;
 * `--scroll` moves the page's scroll offset before the frames are sampled,
 * so the PNG shows the same visible viewport the firmware shows at that
 * offset. `--list-pages` only writes the page names (one per line, render
 * order) and exits. Multi-page rendering runs one process per page: each run
 * gets a fresh LVGL engine, so no state leaks between pages.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_host.h"
#include "png_write.h"

#define FRAME_MS 33

static int list_pages(const char *path)
{
    int total = ui_page_total();
    if(total <= 0) {
        fprintf(stderr, "this UI has no ui_page_count/ui_page_name/ui_page_show contract\n");
        return 2;
    }
    FILE * f = fopen(path, "wb");
    if(!f) {
        fprintf(stderr, "cannot write %s\n", path);
        return 1;
    }
    for(int i = 0; i < total; i++) {
        const char * name = ui_page_name_at(i);
        fprintf(f, "%s\n", name ? name : "");
    }
    fclose(f);
    printf("pages %d\n", total);
    return 0;
}

int main(int argc, char **argv)
{
    const char *out = "preview.png";
    const char *raw = NULL;
    const char *tree_path = NULL;
    const char *pages_path = NULL;
    const char *scroll_spec = NULL;
    int frames = 12;
    int page = -1;

    for(int i = 1; i < argc; ++i) {
        if(strcmp(argv[i], "--out") == 0 && i + 1 < argc) out = argv[++i];
        else if(strcmp(argv[i], "--raw") == 0 && i + 1 < argc) raw = argv[++i];
        else if(strcmp(argv[i], "--tree") == 0 && i + 1 < argc) tree_path = argv[++i];
        else if(strcmp(argv[i], "--frames") == 0 && i + 1 < argc) frames = atoi(argv[++i]);
        else if(strcmp(argv[i], "--page") == 0 && i + 1 < argc) page = atoi(argv[++i]);
        else if(strcmp(argv[i], "--list-pages") == 0 && i + 1 < argc) pages_path = argv[++i];
        else if(strcmp(argv[i], "--scroll") == 0 && i + 1 < argc) scroll_spec = argv[++i];
    }

    if(pages_path) return list_pages(pages_path);

    if(page >= 0 && ui_set_page(page) != 0) {
        fprintf(stderr, "unknown page %d (no ui_page_* contract, or index out of range)\n", page);
        return 3;
    }

    if(ui_attach(LVGLUI_WIDTH, LVGLUI_HEIGHT) != 0) {
        fprintf(stderr, "ui_attach failed\n");
        return 1;
    }
    if(scroll_spec && ui_scroll(scroll_spec) != 0) {
        fprintf(stderr, "scroll failed: %s\n", scroll_spec);
        ui_detach();
        return 2;
    }
    for(int i = 0; i < frames; ++i) ui_tick(FRAME_MS);

    /* One machine-readable line for the renderer's meta.json; harmless when
       the UI uses an allocator without a monitor (nothing is printed). */
    {
        char membuf[192];
        if(ui_mem_info(membuf, (int)sizeof(membuf)) == 0) printf("%s\n", membuf);
    }

    if(tree_path) ui_dump_tree(tree_path);

    int w = 0, h = 0;
    unsigned int ver = 0;
    const void *px = ui_pixels(&w, &h, &ver);
    if(!px) { fprintf(stderr, "no framebuffer\n"); return 1; }

    if(raw) {
        /* Raw RGB565 dump: lets the Node CLI do a proper (small) PNG. */
        FILE *f = fopen(raw, "wb");
        if(!f) { fprintf(stderr, "cannot write %s\n", raw); return 1; }
        size_t n = (size_t)w * (size_t)h * 2u;
        fwrite(px, 1, n, f);
        fclose(f);
        printf("%d %d %u %s\n", w, h, ver, raw);
        ui_detach();
        return 0;
    }

    if(png_write_rgb565(out, (const unsigned char *)px, w, h) != 0) {
        fprintf(stderr, "cannot write %s\n", out);
        return 1;
    }
    printf("rendered %dx%d (%u repaints) -> %s\n", w, h, ver, out);
    ui_detach();
    return 0;
}