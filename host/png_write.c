/**
 * @file png_write.c
 * Minimal PNG encoder: 8-bit RGB, filter type 0, zlib "stored" blocks.
 * No dependencies on purpose -- the previewer must build on a bare MSVC box.
 *
 * Output is bigger than a real zlib run, but a 240x320 screen lands around
 * 230 KB, which is irrelevant for a local preview file.
 */
#include "png_write.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- checksums ------------------------------------------------------- */
static unsigned long crc_table[256];
static int crc_ready;

static void crc_init(void)
{
    for(unsigned long i = 0; i < 256; ++i) {
        unsigned long c = i;
        for(int k = 0; k < 8; ++k) c = (c & 1) ? 0xEDB88320UL ^ (c >> 1) : (c >> 1);
        crc_table[i] = c;
    }
    crc_ready = 1;
}

static unsigned long crc32_buf(const unsigned char *buf, size_t len)
{
    if(!crc_ready) crc_init();
    unsigned long c = 0xFFFFFFFFUL;
    for(size_t i = 0; i < len; ++i) c = crc_table[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
    return (c ^ 0xFFFFFFFFUL) & 0xFFFFFFFFUL;
}

static unsigned long adler32_buf(const unsigned char *buf, size_t len)
{
    unsigned long a = 1, b = 0;
    for(size_t i = 0; i < len; ++i) {
        a = (a + buf[i]) % 65521UL;
        b = (b + a) % 65521UL;
    }
    return (b << 16) | a;
}

/* ---- chunk helpers --------------------------------------------------- */
static void put32(unsigned char *p, unsigned long v)
{
    p[0] = (unsigned char)(v >> 24);
    p[1] = (unsigned char)(v >> 16);
    p[2] = (unsigned char)(v >> 8);
    p[3] = (unsigned char)(v);
}

static int write_chunk(FILE *f, const char *type, const unsigned char *data, size_t len)
{
    unsigned char buf[4];
    put32(buf, (unsigned long)len);
    if(fwrite(buf, 1, 4, f) != 4) return -1;
    if(fwrite(type, 1, 4, f) != 4) return -1;
    if(len && fwrite(data, 1, len, f) != len) return -1;

    unsigned char *crcbuf = (unsigned char *)malloc(4 + len);
    if(!crcbuf) return -1;
    memcpy(crcbuf, type, 4);
    if(len) memcpy(crcbuf + 4, data, len);
    unsigned long crc = crc32_buf(crcbuf, 4 + len);
    free(crcbuf);
    put32(buf, crc);
    if(fwrite(buf, 1, 4, f) != 4) return -1;
    return 0;
}

/* ---- public ---------------------------------------------------------- */
int png_write_rgb565(const char *path, const unsigned char *fb, int w, int h)
{
    const size_t row_raw = (size_t)w * 3u + 1u;      /* filter byte + RGB */
    const size_t raw_len = row_raw * (size_t)h;
    unsigned char *raw = (unsigned char *)malloc(raw_len);
    if(!raw) return -1;

    const unsigned short *px = (const unsigned short *)fb;
    for(int y = 0; y < h; ++y) {
        unsigned char *dst = raw + (size_t)y * row_raw;
        *dst++ = 0;                                   /* filter: none */
        const unsigned short *src = px + (size_t)y * (size_t)w;
        for(int x = 0; x < w; ++x) {
            unsigned short p = src[x];
            dst[0] = (unsigned char)(((p >> 11) & 0x1F) * 255 / 31);   /* R */
            dst[1] = (unsigned char)(((p >> 5) & 0x3F) * 255 / 63);    /* G */
            dst[2] = (unsigned char)((p & 0x1F) * 255 / 31);           /* B */
            dst += 3;
        }
    }

    /* zlib stream: 2-byte header + stored blocks + adler32 */
    const size_t blocks = (raw_len + 65534u) / 65535u;
    const size_t zlen = 2u + blocks * 5u + raw_len + 4u;
    unsigned char *z = (unsigned char *)malloc(zlen);
    if(!z) { free(raw); return -1; }

    size_t zi = 0;
    z[zi++] = 0x78; z[zi++] = 0x01;                   /* CMF/FLG, no compression */
    size_t off = 0;
    while(off < raw_len) {
        size_t n = raw_len - off;
        if(n > 65535u) n = 65535u;
        z[zi++] = (off + n >= raw_len) ? 1 : 0;       /* BFINAL */
        z[zi++] = (unsigned char)(n & 0xFF);
        z[zi++] = (unsigned char)(n >> 8);
        z[zi++] = (unsigned char)(~n & 0xFF);
        z[zi++] = (unsigned char)((~n >> 8) & 0xFF);
        memcpy(z + zi, raw + off, n);
        zi += n;
        off += n;
    }
    put32(z + zi, adler32_buf(raw, raw_len));
    zi += 4;

    FILE *f = fopen(path, "wb");
    if(!f) { free(raw); free(z); return -1; }

    static const unsigned char sig[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
    int rc = 0;
    if(fwrite(sig, 1, 8, f) != 8) rc = -1;

    unsigned char ihdr[13];
    put32(ihdr, (unsigned long)w);
    put32(ihdr + 4, (unsigned long)h);
    ihdr[8] = 8;      /* bit depth */
    ihdr[9] = 2;      /* colour type: truecolour */
    ihdr[10] = 0;     /* compression */
    ihdr[11] = 0;     /* filter */
    ihdr[12] = 0;     /* interlace */
    if(rc == 0 && write_chunk(f, "IHDR", ihdr, 13) != 0) rc = -1;
    if(rc == 0 && write_chunk(f, "IDAT", z, zi) != 0) rc = -1;
    if(rc == 0 && write_chunk(f, "IEND", NULL, 0) != 0) rc = -1;

    fclose(f);
    free(raw);
    free(z);
    return rc;
}
