#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mirai Audit Workpaper — 文書リンク整合性チェック
- Markdown 内の相対リンク（[text](path)）が実在するか検証する。
- HTML 文書内の相対リンク（href）が実在するか検証する。
- 戻り値: 破損リンクがあれば exit 1、すべて解決していれば exit 0。

使い方: python3 scripts/check-links.py
"""
import os
import re
import sys
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_markdown(files):
    broken, ok = [], 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            content = fh.read()
        for m in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", content):
            target = m.group(1)
            if target.startswith("http") or target.startswith("#") or target.startswith("mailto:"):
                continue
            t = target.split("#")[0]
            if not t:
                continue
            resolved = os.path.normpath(os.path.join(os.path.dirname(f), t))
            if not os.path.exists(resolved):
                broken.append((f, target))
            else:
                ok += 1
    return broken, ok


def check_html(files):
    broken, ok = [], 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            content = fh.read()
        for m in re.finditer(r'href="([^"]+)"', content):
            target = m.group(1)
            if target.startswith("#") or target.startswith("http") or target.startswith("mailto:"):
                continue
            resolved = os.path.normpath(os.path.join(os.path.dirname(f), target))
            if not os.path.exists(resolved):
                broken.append((f, target))
            else:
                ok += 1
    return broken, ok


def main():
    md_files = ["README.md"] + sorted(glob.glob(os.path.join(ROOT, "docs", "*.md")))
    html_files = sorted(glob.glob(os.path.join(ROOT, "*.html")))
    md_broken, md_ok = check_markdown(md_files)
    html_broken, html_ok = check_html(html_files)
    print(f"Markdown: {md_ok} OK, {len(md_broken)} broken")
    for f, t in md_broken:
        print(f"  [MD] {os.path.relpath(f, ROOT)} -> {t}")
    print(f"HTML: {html_ok} OK, {len(html_broken)} broken")
    for f, t in html_broken:
        print(f"  [HTML] {os.path.relpath(f, ROOT)} -> {t}")
    if md_broken or html_broken:
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
