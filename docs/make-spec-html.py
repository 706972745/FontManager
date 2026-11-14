#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 docs/UI设计交付规格书.md 生成 docs/UI设计交付规格书.html。

用法（仓库根目录）：
    python docs/make-spec-html.py

为什么要这个脚本：Markdown 版是**唯一事实来源**（改代码就改 .md），
HTML 版只是给设计师看的渲染结果 —— 放在 GitHub 上直接能看、也能打印成 PDF。
每次改完 .md 跑一次即可，别手工改 HTML（会被下次生成覆盖）。

样式沿用设计交付稿《QuickBar-设计交付规格书》的纸墨语言：
纸底 #fff / 版心 #FAFAF8 / 发丝线 #E2E2DD / 强调蓝 #1B4FE0 / 等宽 Geist Mono。
"""

import io
import os
import re
import html as html_mod

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "UI设计交付规格书.md")
DST = os.path.join(HERE, "UI设计交付规格书.html")

# 每份文档一个条目：md 是唯一事实来源，html 由本脚本生成。
# 用法：python docs/make-spec-html.py [spec|installer]   默认 spec。
DOCS = {
    "spec": {
        "src": SRC,
        "dst": DST,
        "src_name": "docs/UI设计交付规格书.md",
        "title": "FontManager · UI 设计交付规格书",
        "kicker": "DESIGN HANDOFF SPECIFICATION / SOURCE-CALIBRATED",
        "h1": "FontManager<br>UI 设计交付规格书",
        "sub": "字体管理软件 · 纸墨两色 + 单一蓝强调 · 本文写的是软件里「实际生效」的规格，不是提案",
        "meta": [
            ("当前版本", "1.7.7"),
            ("覆盖", "速览 / 主界面 / 设置 / 菜单 / Toast / 在线库 / 插件分区 / 插件面板"),
            ("语言", "9 种"),
            ("来源", "docs/UI设计交付规格书.md"),
        ],
        "footer": "数值以源码为准；若两者不一致，以代码为准并补齐 Markdown。",
    },
    "installer": {
        "src": os.path.join(HERE, "安装器与启动页-UI交付规格书.md"),
        "dst": os.path.join(HERE, "安装器与启动页-UI交付规格书.html"),
        "src_name": "docs/安装器与启动页-UI交付规格书.md",
        "title": "FontManager · 安装器与启动页 UI 交付规格书",
        "kicker": "INSTALLER & SPLASH / DESIGN HANDOFF",
        "h1": "FontManager<br>安装器 & 启动页<br>UI 交付规格书",
        "sub": "白卡 + 左文字 / 右品牌图 · 深林绿 + 宝蓝 · 每个数值都能在原型里量到",
        "meta": [
            ("适用版本", "2.1.6"),
            ("覆盖", "安装器 4 屏 / 启动页 / NSIS 备选版"),
            ("单位", "逻辑像素（100%）"),
            ("原型", "docs/installer-splash-ui-demo.html"),
        ],
        "footer": "数值以原型为准；若两者不一致，以原型为准并补齐 Markdown。",
    },
}

# ── 样式（与 handoff/QuickBar-设计交付规格书.html 同一套视觉语言） ─────────────
CSS = """
@page { size: A4; margin: 22mm 18mm; }
* { box-sizing: border-box; }
body { margin:0 auto; max-width: 940px; padding: 0 32px 80px;
  font-family: "Noto Sans SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif;
  font-size: 14px; line-height: 1.85; color:#262625; background:#fff; }
.cover { padding: 90px 0 60px; border-bottom: 3px solid #1B4FE0; margin-bottom: 40px; }
.cover .kicker { font: 600 12px/1.6 "Geist Mono",Consolas,monospace; letter-spacing:.14em;
  color:#1B4FE0; text-transform:uppercase; margin-bottom:26px; }
.cover h1 { font-size: 40px; line-height:1.3; margin:0 0 22px; letter-spacing:-.02em; color:#141412; }
.cover .sub { font-size:16px; color:#6B6B66; margin-bottom:38px; }
.cover .meta { display:flex; flex-wrap:wrap; gap:10px 28px; font-size:12px; color:#6B6B66;
  border-top:1px solid #E2E2DD; padding-top:18px; }
.cover .meta b { color:#141412; font-weight:600; }
.doc-toc { background:#FAFAF8; border:1px solid #E2E2DD; border-left:3px solid #1B4FE0;
  padding:22px 28px; margin:0 0 48px; }
.doc-toc h2 { font-size:15px; margin:0 0 12px; color:#1B4FE0; border:0; padding:0; }
.doc-toc ul { list-style:none; margin:0; padding:0; columns:2; column-gap:36px; }
.doc-toc li { font-size:12.5px; line-height:1.9; break-inside:avoid; }
.doc-toc .toc-l3 { padding-left:16px; color:#6B6B66; }
.doc-toc .toc-l4 { padding-left:32px; color:#9B9B95; }
.doc-toc a { color:#262625; text-decoration:none; border-bottom:1px solid #E2E2DD; }
h2 { font-size:24px; line-height:1.4; margin:56px 0 18px; padding-bottom:10px;
  border-bottom:1px solid #E2E2DD; color:#141412; letter-spacing:-.01em; }
h3 { font-size:17px; margin:34px 0 12px; color:#141412; }
h4 { font-size:14px; margin:24px 0 8px; color:#1B4FE0; }
p { margin:0 0 13px; }
strong { font-weight:600; color:#141412; }
em { font-style:italic; }
code { font-family:"Geist Mono","Cascadia Mono",Consolas,monospace; font-size:.88em;
  background:#F1F1ED; padding:2px 5px; border-radius:2px; color:#1B4FE0; }
pre { background:#1B1B19; color:#F2F2EF; padding:18px 20px; overflow-x:auto;
  border-radius:4px; font-size:12px; line-height:1.7; margin:16px 0 22px; }
pre code { background:none; color:inherit; padding:0; font-size:inherit; }
table { width:100%; border-collapse:collapse; margin:14px 0 24px; font-size:12.5px; }
th { background:#F1F1ED; text-align:left; font-weight:600; color:#141412; }
th, td { border:1px solid #E2E2DD; padding:8px 11px; vertical-align:top; line-height:1.65; }
tr:nth-child(even) td { background:#FCFCFA; }
ul, ol { margin:0 0 16px; padding-left:24px; }
li { margin:4px 0; }
blockquote { margin:16px 0; padding:12px 18px; border-left:3px solid #1B4FE0;
  background:#FAFAF8; color:#6B6B66; font-size:13px; }
figure { margin:22px 0 28px; text-align:center; break-inside:avoid; }
figure img { max-width:100%; max-height:760px; height:auto; border:1px solid #E2E2DD; }
figcaption { font-size:11.5px; color:#9B9B95; margin-top:8px; }
hr { border:0; border-top:1px solid #E2E2DD; margin:36px 0; }
a { color:#1B4FE0; }
.footer { margin-top:60px; padding-top:16px; border-top:1px solid #E2E2DD;
  font:11px/1.8 "Geist Mono",Consolas,monospace; color:#9B9B95; }
"""


def slug(text, used):
    """标题 → 锚点 id；同名时加后缀，保证目录链接不打架。"""
    s = re.sub(r"[^\w一-鿿-]+", "-", text.strip().lower())
    s = s.strip("-") or "sec"
    base = s
    i = 2
    while s in used:
        s = "%s-%d" % (base, i)
        i += 1
    used.add(s)
    return s


def inline(text):
    """行内格式化：代码 > 链接 > 粗体 > 斜体。代码片段先摘出来占位，避免被后面的规则改坏。"""
    spans = []

    def keep(fragment):
        spans.append(fragment)
        return "\x00%d\x00" % (len(spans) - 1)

    # `code`
    text = re.sub(r"`([^`]+)`", lambda m: keep("<code>%s</code>" % m.group(1)), text)
    # [text](url)
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: keep('<a href="%s">%s</a>' % (m.group(2), m.group(1))),
        text,
    )
    # **bold**
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    # *italic*（避免误伤已生成的标签与 ** ）
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", text)

    def restore(m):
        return spans[int(m.group(1))]

    text = re.sub(r"\x00(\d+)\x00", restore, text)
    return text


def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    cells = []
    cur = ""
    escape = False
    for ch in line:
        if escape:
            cur += ch
            escape = False
        elif ch == "\\":
            cur += ch
            escape = True
        elif ch == "|":
            cells.append(cur.strip())
            cur = ""
        else:
            cur += ch
    cells.append(cur.strip())
    return cells


def convert(md):
    lines = md.split("\n")
    out = []
    toc = []
    used = set()
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # 代码块
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            body = html_mod.escape("\n".join(buf))
            out.append("<pre><code>%s</code></pre>" % body)
            continue

        # 空行
        if not stripped:
            i += 1
            continue

        # 分隔线
        if stripped in ("---", "***", "___"):
            out.append("<hr>")
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            text = m.group(2).strip()
            if level == 1:
                # 一级标题是文档名，已在封面出现，正文里不重复
                i += 1
                continue
            sid = slug(text, used)
            out.append('<h%d id="%s">%s</h%d>' % (level, sid, inline(text), level))
            toc.append((level, text, sid))
            i += 1
            continue

        # 图片：![alt](path) 独占一行 → <figure>
        m = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)$", stripped)
        if m:
            out.append(
                '<figure><img src="%s" alt="%s"><figcaption>%s</figcaption></figure>'
                % (m.group(2), html_mod.escape(m.group(1)), inline(m.group(1)))
            )
            i += 1
            continue

        # 表格
        if stripped.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            head = split_row(stripped)
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            buf = ["<table><thead><tr>"]
            for c in head:
                buf.append("<th>%s</th>" % inline(c))
            buf.append("</tr></thead><tbody>")
            for r in rows:
                buf.append("<tr>")
                for c in r:
                    buf.append("<td>%s</td>" % inline(c))
                buf.append("</tr>")
            buf.append("</tbody></table>")
            out.append("".join(buf))
            continue

        # 引用块
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                t = lines[i].strip()[1:].strip()
                buf.append(t)
                i += 1
            paras = []
            cur = []
            for t in buf:
                if not t:
                    if cur:
                        paras.append(" ".join(cur))
                        cur = []
                else:
                    cur.append(t)
            if cur:
                paras.append(" ".join(cur))
            body = "<br>".join(inline(p) for p in paras)
            out.append("<blockquote>%s</blockquote>" % body)
            continue

        # 列表（无序 / 有序）
        if re.match(r"^([-*]|\d+\.)\s+", stripped):
            ordered = bool(re.match(r"^\d+\.\s+", stripped))
            buf = []
            while i < n:
                t = lines[i].strip()
                if not t:
                    # 列表后紧跟空行：看下一行是不是同类列表项
                    j = i + 1
                    while j < n and not lines[j].strip():
                        j += 1
                    if j < n and re.match(r"^([-*]|\d+\.)\s+", lines[j].strip()):
                        i = j
                        continue
                    break
                m = re.match(r"^([-*]|\d+\.)\s+(.*)$", t)
                if not m:
                    break
                buf.append(inline(m.group(2)))
                i += 1
            tag = "ol" if ordered else "ul"
            out.append("<%s>%s</%s>" % (tag, "".join("<li>%s</li>" % b for b in buf), tag))
            continue

        # 段落（连续非空行合并；行尾两空格 = 硬换行）
        buf = []
        while i < n:
            t = lines[i]
            s = t.strip()
            if not s or s.startswith("```") or s.startswith("|") or s.startswith(">") or re.match(r"^#{1,4}\s+", s):
                break
            hard = t.endswith("  ")
            buf.append((s, hard))
            i += 1
        pieces = []
        for j, (s, hard) in enumerate(buf):
            pieces.append(inline(s))
            if hard and j < len(buf) - 1:
                pieces.append("<br>")
        out.append("<p>%s</p>" % " ".join(pieces))

    return "\n".join(out), toc


def plain(text):
    """目录用：去掉 Markdown 标记，只留纯文本（标题里允许加粗，目录里不该出现 **）。"""
    t = re.sub(r"`([^`]+)`", r"\1", text)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"\1", t)
    return t


def main():
    import sys

    key = sys.argv[1] if len(sys.argv) > 1 else "spec"
    if key not in DOCS:
        print("未知文档：%s（可选：%s）" % (key, " / ".join(DOCS)))
        raise SystemExit(2)
    cfg = DOCS[key]

    md = io.open(cfg["src"], encoding="utf-8").read()
    body, toc = convert(md)

    toc_html = ["<nav class=\"doc-toc\"><h2>目录</h2><ul>"]
    for level, text, sid in toc:
        cls = "" if level == 2 else (" toc-l3" if level == 3 else " toc-l4")
        toc_html.append(
            '<li class="%s"><a href="#%s">%s</a></li>'
            % (cls.strip(), sid, html_mod.escape(plain(text)))
        )
    toc_html.append("</ul></nav>")

    meta_html = "".join(
        "<span>%s <b>%s</b></span>" % (label, value) for label, value in cfg["meta"]
    )

    doc = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>%s</style></head><body>
<section class="cover">
  <div class="kicker">%s</div>
  <h1>%s</h1>
  <div class="sub">%s</div>
  <div class="meta">
    %s
  </div>
</section>

%s

%s

<div class="footer">
本页由 docs/make-spec-html.py 从 %s 生成，请勿手工修改 HTML。<br>
%s
</div>
</body></html>
""" % (
        cfg["title"],
        CSS,
        cfg["kicker"],
        cfg["h1"],
        cfg["sub"],
        meta_html,
        "\n".join(toc_html),
        body,
        cfg["src_name"],
        cfg["footer"],
    )

    io.open(cfg["dst"], "w", encoding="utf-8", newline="\n").write(doc)
    print(
        "已生成 %s（%d 字符，目录 %d 条）"
        % (os.path.basename(cfg["dst"]), len(doc), len(toc))
    )


if __name__ == "__main__":
    main()
