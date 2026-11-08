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
 *   shot.exe [--out preview.png] [--frames 12]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_host.h"
#include "png_write.h"

#define W 240
#define H 320
#define FRAME_MS 33

int main(int argc, char **argv)
{
    const char *out = "preview.png";
    const char *raw = NULL;
    int frames = 12;

    for(int i = 1; i < argc; ++i) {
        if(strcmp(argv[i], "--out") == 0 && i + 1 < argc) out = argv[++i];
        else if(strcmp(argv[i], "--raw") == 0 && i + 1 < argc) raw = argv[++i];
        else if(strcmp(argv[i], "--frames") == 0 && i + 1 < argc) frames = atoi(argv[++i]);
    }

    if(ui_attach(W, H) != 0) { fprintf(stderr, "ui_attach failed\n"); return 1; }
    for(int i = 0; i < frames; ++i) ui_tick(FRAME_MS);

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
