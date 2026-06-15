#!/usr/bin/env python3
# M60 Phase 1 — generate the multi-filter PNG decode fixture.
#
# Writes an 8-bit RGBA PNG that deliberately uses the PAETH scanline
# filter (filter type 4) via an encoder INDEPENDENT of pngjs (python
# stdlib only). The png-io decode test asserts the exact RGBA pattern
# below, which only passes if pngjs correctly reverses Paeth filtering —
# something a pngjs-self-encoded round-trip cannot prove.
#
# Run once, commit the resulting filtered-rgba.png. Not executed by the
# test suite (the glob is src/tests/*.test.js).
#
#   python3 src/tests/fixtures/make-filtered-rgba.py
#
# Known pattern (W=H=4, RGBA): r=x*60, g=y*60, b=30, a=255-(x+y)*15
import struct
import zlib

W = H = 4
BPP = 4


def pixel(x, y):
    return (x * 60, y * 60, 30, 255 - (x + y) * 15)


def paeth(a, b, c):  # left, above, upper-left
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


# Build raw RGBA rows, then Paeth-filter each (filter type 4).
raw = [bytearray(b for x in range(W) for b in pixel(x, y)) for y in range(H)]
out = bytearray()
prev = bytearray(W * BPP)
for y in range(H):
    cur = raw[y]
    out.append(4)  # filter type: Paeth
    for i in range(len(cur)):
        left = cur[i - BPP] if i >= BPP else 0
        up = prev[i]
        upleft = prev[i - BPP] if i >= BPP else 0
        out.append((cur[i] - paeth(left, up, upleft)) & 0xFF)
    prev = cur


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)  # 8-bit, RGBA, no interlace
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", ihdr)
       + chunk(b"IDAT", zlib.compress(bytes(out), 9))
       + chunk(b"IEND", b""))

with open(__file__.rsplit("/", 1)[0] + "/filtered-rgba.png", "wb") as f:
    f.write(png)
print("wrote filtered-rgba.png (4x4 RGBA, Paeth-filtered)")
