#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 API 23-25 的旧版启动图标 PNG（adaptive icon 仅 API 26+ 生效）。

零依赖：纯 Python zlib/struct 写 PNG，逐像素光栅化「朱砂方章 + 白文笔画」几何图形，
与 res/drawable/ic_launcher_foreground.xml 的矢量图标同一造型。
用法：python3 gen_icons.py   （在 mobile/ 目录下执行）
"""
import math
import os
import struct
import zlib

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "android", "app", "src", "main", "res")

# 配色（与 style.css 一致）
PAPER = (241, 233, 212, 255)     # #F1E9D4
RED = (168, 64, 47, 255)         # #A8402F
WHITE = (251, 246, 232, 255)     # #FBF6E8


def write_png(path, w, h, pix):
    """pix: 行优先的 (r,g,b,a) 元组列表。"""
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *p) for p in row) for row in pix)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print("✓", path, f"({w}x{h})")


def dist_seg(px, py, ax, ay, bx, by):
    """点到线段距离。"""
    abx, aby = bx - ax, by - ay
    t = 0 if abx == aby == 0 else max(0, min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
    cx, cy = ax + t * abx, ay + t * aby
    return math.hypot(px - cx, py - cy)


def raster(size, round_mask=False):
    """在 size×size 画布上按 108 视口坐标光栅化印章图形。round_mask=True 时裁成圆底。"""
    s = size / 108.0
    # 几何定义（与矢量图一致）
    seal = (24, 26, 84, 82, 6)          # x1,y1,x2,y2,r（视口坐标）
    strokes = [                          # (点序列, 线宽)
        ([(56, 34), (50, 41), (45, 49), (43, 58)], 5),   # 夕·撇（折线近似曲线）
        ([(41, 40), (60, 45), (47, 60)], 5),             # 夕·横折撇
    ]
    dot = (57, 51, 2.6)                  # 夕·点
    mouth = (48, 62, 68, 74, 5)          # 口·方框
    out = []
    cx = cy = size / 2
    for y in range(size):
        row = []
        for x in range(size):
            # 圆形遮罩（ic_launcher_round）
            if round_mask and math.hypot(x - cx, y - cy) > size / 2:
                row.append((0, 0, 0, 0))
                continue
            vx, vy = x / s, y / s
            # 印面圆角矩形（含圆角半径）
            x1, y1, x2, y2, r = seal
            inside_rrect = False
            if x1 + r <= vx <= x2 - r and y1 <= vy <= y2:
                inside_rrect = True
            elif x1 <= vx < x1 + r and y1 <= vy < y1 + r and math.hypot(vx - (x1 + r), vy - (y1 + r)) <= r:
                inside_rrect = True
            elif x2 - r < vx <= x2 and y1 <= vy < y1 + r and math.hypot(vx - (x2 - r), vy - (y1 + r)) <= r:
                inside_rrect = True
            elif x1 <= vx < x1 + r and y2 - r < vy <= y2 and math.hypot(vx - (x1 + r), vy - (y2 - r)) <= r:
                inside_rrect = True
            elif x2 - r < vx <= x2 and y2 - r < vy <= y2 and math.hypot(vx - (x2 - r), vy - (y2 - r)) <= r:
                inside_rrect = True
            if not inside_rrect:
                row.append((0, 0, 0, 0))
                continue
            white = False
            # 笔画（白）
            for pts, wpx in strokes:
                for i in range(len(pts) - 1):
                    if dist_seg(vx, vy, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= wpx / 2:
                        white = True
                        break
                if white:
                    break
            # 点
            if math.hypot(vx - dot[0], vy - dot[1]) <= dot[2]:
                white = True
            # 口（方框描边）
            if not white:
                mx1, my1, mx2, my2, mw = mouth
                if mx1 - mw / 2 <= vx <= mx2 + mw / 2 and my1 - mw / 2 <= vy <= my2 + mw / 2:
                    if not (mx1 + mw / 2 <= vx <= mx2 - mw / 2 and my1 + mw / 2 <= vy <= my2 - mw / 2):
                        white = True
            row.append(WHITE if white else RED)
        out.append(row)
    return out


DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

if __name__ == "__main__":
    for dpi, size in DENSITIES.items():
        base = os.path.join(RES, "mipmap-" + dpi)
        write_png(os.path.join(base, "ic_launcher.png"), size, size, raster(size))
        write_png(os.path.join(base, "ic_launcher_round.png"), size, size, raster(size, round_mask=True))
    print("全部图标生成完毕")
