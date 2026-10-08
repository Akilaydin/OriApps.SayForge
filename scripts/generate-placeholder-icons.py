"""Generate temporary SayForge icons using only the Python standard library.

Run from the repository root:
    python scripts/generate-placeholder-icons.py

These intentionally plain microphone icons replace original SayIt artwork.
Replace them once the project has its own visual identity.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def round_rect(x: float, y: float, half_w: float, half_h: float, radius: float) -> float:
    dx = abs(x) - half_w + radius
    dy = abs(y) - half_h + radius
    return math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - radius


def coverage(distance: float, size: int) -> float:
    return clamp(0.5 - distance * size / 2.0)


def blend(background: tuple[int, int, int], ink: tuple[int, int, int], alpha: float):
    return tuple(round(a * (1 - alpha) + b * alpha) for a, b in zip(background, ink))


def icon_pixels(size: int) -> bytes:
    out = bytearray()
    white = (246, 249, 253)
    mint = (126, 226, 219)
    for iy in range(size):
        y = (iy + 0.5) * 2.0 / size - 1.0
        for ix in range(size):
            x = (ix + 0.5) * 2.0 / size - 1.0
            edge = round_rect(x, y, 0.93, 0.93, 0.34)
            alpha = coverage(edge, size)
            if alpha < 0.001:
                out.extend((0, 0, 0, 0))
                continue

            dark = (21, 34, 53)
            light = (32, 72, 85)
            color = blend(dark, light, clamp((x - y + 1.8) / 3.6))
            border = coverage(edge + 0.035, size)
            color = blend((67, 109, 123), color, border)

            # A white microphone capsule.
            capsule = round_rect(x, y + 0.19, 0.16, 0.32, 0.16)
            color = blend(color, white, coverage(capsule, size))

            # A U-shaped pickup loop with two short vertical sides.
            loop = 0.0
            if abs(x) <= 0.29:
                arc_y = 0.04 + 0.34 * math.sqrt(max(0.0, 1 - (x / 0.29) ** 2))
                loop = coverage(abs(y - arc_y) - 0.046, size)
            if -0.1 <= y <= 0.07:
                loop = max(loop, coverage(abs(abs(x) - 0.29) - 0.046, size))
            color = blend(color, white, loop)

            # Mint stand and underline.
            stand = round_rect(x, y - 0.42, 0.037, 0.15, 0.018)
            base = round_rect(x, y - 0.56, 0.27, 0.04, 0.025)
            color = blend(color, mint, max(coverage(stand, size), coverage(base, size)))
            out.extend((*color, round(alpha * 255)))
    return bytes(out)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def png(size: int) -> bytes:
    pixels = icon_pixels(size)
    scanlines = b"".join(b"\x00" + pixels[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines, level=9))
            + chunk(b"IEND", b""))


def ico() -> bytes:
    resolutions = [16, 24, 32, 48, 64, 128, 256]
    images = [png(size) for size in resolutions]
    offset = 6 + 16 * len(images)
    header = [struct.pack("<HHH", 0, 1, len(images))]
    for size, image in zip(resolutions, images):
        header.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(image), offset))
        offset += len(image)
    return b"".join(header + images)


def bmp(width: int, height: int, sidebar: bool) -> bytes:
    """Generate installer artwork: understated gradient with a white/mint mic."""
    tile = icon_pixels(128)
    rows = []
    logo_size = 90 if sidebar else 39
    left = (width - logo_size) // 2 if sidebar else 10
    top = 42 if sidebar else (height - logo_size) // 2
    for y in range(height - 1, -1, -1):
        row = bytearray()
        for x in range(width):
            t = y / max(1, height - 1)
            color = blend((24, 46, 66), (16, 29, 46), t)
            if left <= x < left + logo_size and top <= y < top + logo_size:
                sx = int((x - left) * 128 / logo_size)
                sy = int((y - top) * 128 / logo_size)
                pos = 4 * (sy * 128 + sx)
                r, g, b, a = tile[pos:pos + 4]
                color = blend(color, (r, g, b), a / 255)
            if sidebar and height - 39 < y < height - 34 and 28 < x < width - 28:
                color = (126, 226, 219)
            row.extend(reversed(color))
        row.extend(b"\x00" * ((-width * 3) % 4))
        rows.append(bytes(row))
    payload = b"".join(rows)
    file_header = struct.pack("<2sIHHI", b"BM", 54 + len(payload), 0, 0, 54)
    dib_header = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(payload), 2835, 2835, 0, 0)
    return file_header + dib_header + payload


def write(path: str, content: bytes) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    print(f"{target.relative_to(ROOT)} ({len(content)} bytes)")


def main() -> None:
    files = {
        "client/src-tauri/icons/icon.png": 256,
        "client/src-tauri/icons/128x128.png": 128,
        "client/src-tauri/icons/128x128@2x.png": 256,
        "client/src-tauri/icons/32x32.png": 32,
        "client/src-tauri/icons/tray-16.png": 16,
        "client/src-tauri/icons/tray-20.png": 20,
        "client/src-tauri/icons/tray-24.png": 24,
        "client/src-tauri/icons/tray-32.png": 32,
        "client/src/assets/ico-frame-48x48.png": 48,
        "client/src/assets/icon-128.png": 128,
        "docs/images/readme/icon.png": 128,
        "server/web/logo.png": 256,
        "server/web/logo-72.png": 72,
        "server/web/apple-touch-icon.png": 180,
        "server/web/favicon-16.png": 16,
        "server/web/favicon-32.png": 32,
        "server/web/favicon-48.png": 48,
        "server/web/favicon-192.png": 192,
    }
    for path, size in files.items():
        write(path, png(size))
    write("client/src-tauri/icons/icon.ico", ico())
    write("server/web/favicon.ico", ico())
    write("client/src-tauri/icons/nsis-header.bmp", bmp(150, 57, False))
    write("client/src-tauri/icons/nsis-sidebar.bmp", bmp(164, 314, True))


if __name__ == "__main__":
    main()
