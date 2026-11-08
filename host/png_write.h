#ifndef PNG_WRITE_H
#define PNG_WRITE_H

/* Encode an RGB565 framebuffer as an 8-bit RGB PNG. Returns 0 on success. */
int png_write_rgb565(const char *path, const unsigned char *rgb565, int w, int h);

#endif /* PNG_WRITE_H */
