"""1bitビットマップの切り出し・縮小と、8bitグレーPNGの書き出し。"""
import zlib, struct

def get(px, stride, x, y):
    return (px[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1  # 1=黒

def crop_scale(px, w, h, box, scale):
    """box=(x0,y0,x1,y1) を scale で縮小して 8bit グレーにする（黒の割合を濃さにする）。"""
    x0, y0, x1, y1 = box
    x0 = max(0, x0); y0 = max(0, y0); x1 = min(w, x1); y1 = min(h, y1)
    stride = (w + 7) // 8
    ow = (x1 - x0) // scale; oh = (y1 - y0) // scale
    out = bytearray(ow * oh)
    area = scale * scale
    for oy in range(oh):
        sy = y0 + oy * scale
        base = oy * ow
        for ox in range(ow):
            sx = x0 + ox * scale
            n = 0
            for dy in range(scale):
                row = (sy + dy) * stride
                for dx in range(scale):
                    xx = sx + dx
                    n += (px[row + (xx >> 3)] >> (7 - (xx & 7))) & 1
            out[base + ox] = 255 - (n * 255 // area)
    return bytes(out), ow, oh

def write_gray(path, data, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += data[y * w:(y + 1) * w]
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)

def rotate_cw(px, w, h):
    """時計回りに90度。資料は横向きにスキャンされているので、これで普通に読める向きになる。"""
    sw, sh = h, w                      # 回転後の幅・高さ
    sstride = (w + 7) // 8
    dstride = (sw + 7) // 8
    out = bytearray(dstride * sh)
    for j in range(sw):                # 回転後のx = 元のy
        col = h - 1 - j
        for i in range(sh):            # 回転後のy = 元のx
            if (px[col * sstride + (i >> 3)] >> (7 - (i & 7))) & 1:
                out[i * dstride + (j >> 3)] |= 0x80 >> (j & 7)
    return bytes(out), sw, sh
