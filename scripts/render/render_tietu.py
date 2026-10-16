#!/usr/bin/env python3
"""render_tietu.py — 贴图卡片生成器（多形态流水线）

把「内容库/<每条内容>/cards.json」渲染成 1500×2000 PNG（3:4 竖版），
用于公众号「贴图」形态发布。

目录约定（一条内容 = 一个文件夹）
    内容库/
    └── 001-示例内容/
        ├── cards.json     ← 机器读：出图规格（本脚本唯一输入）
        ├── 标题.txt        ← 手机复制用
        ├── 文案.txt        ← 手机复制用
        └── img/           ← 本脚本输出

支持的卡片类型（cards 数组里每项的 type）
    cover  首图     tag + 大字标题 + 副标题 + 可选英文词胶囊
    word   词卡     大英文词 + 中文 + 解释框            （一个词一张）
    quote  范句卡   英文整句 + 中文 + 解释框            （一句话一张）
    vs     避坑卡   提问 + ✕ 错误说法 + ✓ 正确说法       （互动率最高）
    shot   截图卡   1-2 张截图 + 说明                    （转化最强）
    list   清单卡   标题 + 编号条目
    steps  时间线   标题 + 纵向前后节点（可标 off/hot）
    note   短句卡   居中大字 + 补充小字
    mood   情绪卡   深色底 + 超大行，信息流里最抓眼

用法
    python3 render_tietu.py [--lib 内容库目录] [--force] [--only 关键字]
                            [--foot-left "署名"] [--foot-right "默认文案"]

    --lib        内容库目录（默认 ./内容库）
    --foot-left  卡片左下角署名（默认读 cards.json 顶层的 foot_left）
    --foot-right 卡片右下角默认文案（默认读 cards.json 顶层的 foot_right）
    --force      全部重渲染（默认跳过已出过的图）
    --only X     只渲染目录名含 X 的内容

依赖
    · Chrome（HTML → 截图；可用 CHROME_PATH 环境变量指定可执行文件）
    · 中文字体（默认 PingFang SC / Hiragino Sans GB，可在 CSS 里改）
    · Pillow 可选（仅用于截图缩放；缺了也能跑，只是大图不压缩）

设计约束
    · HTML 用 Chrome headless 截图，零第三方依赖（除可选 Pillow）
    · 图片以 base64 内嵌进 HTML，避免中文/空格路径在 file:// 下出错
    · 配色/字体在下方 CSS 里，想换风格直接改（默认米白纸底 + 墨蓝）
"""
import argparse
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

IMG_MAX_W = 1100
LIB = Path(".")        # 内容库根（main 里设置）
CUR_DIR = Path(".")    # 当前内容的目录（逐条设置）

# 页面字体：按系统改（macOS: PingFang SC；Windows: Microsoft YaHei；Linux: Noto Sans CJK SC）
FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif'

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1500px;height:2000px;overflow:hidden}
body{background:#F5F1E8;font-family:FONT_STACK_PLACEHOLDER}
.card{position:relative;width:1420px;height:1920px;margin:40px auto;background:#fff;
      border-radius:64px;padding:96px 96px 72px;display:flex;flex-direction:column}
.tag{align-self:flex-start;background:#1F4E79;color:#fff;border-radius:999px;
     padding:20px 44px;font-size:38px;font-weight:500;letter-spacing:.5px}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center}
.mid.top{justify-content:flex-start;padding-top:130px}
.mid.top .pills{margin-top:230px}
.h1{font-size:92px;font-weight:700;color:#2E2E2E;line-height:1.28;letter-spacing:.5px}
.h1 .em{color:#1F4E79}
.h2{font-size:86px;font-weight:700;color:#2E2E2E;line-height:1.3;text-align:center}
.h3{font-size:50px;color:#8C8578;text-align:center;line-height:1.5}
.sub{margin-top:36px;font-size:42px;color:#8C8578;line-height:1.6}
.pills{display:flex;flex-wrap:wrap;gap:28px;justify-content:center}
.pill{border:3px solid #1F4E79;color:#1F4E79;border-radius:999px;padding:24px 52px;
      font-size:46px;font-weight:600}
.word{font-size:118px;font-weight:700;color:#1F4E79;text-align:center;line-height:1.16;
      letter-spacing:-1px}
.quote{font-size:62px;font-weight:600;color:#1F4E79;text-align:center;line-height:1.44}
.zh{margin-top:40px;font-size:64px;color:#2E2E2E;text-align:center;font-weight:500}
.zhs{margin-top:36px;font-size:50px;color:#2E2E2E;text-align:center;font-weight:500;line-height:1.5}
.box{margin-top:72px;background:#F5F1E8;border-radius:28px;padding:56px;
     font-size:46px;color:#6B7280;line-height:1.62;text-align:center}
.boxs{margin-top:52px;background:#F5F1E8;border-radius:28px;padding:48px;
      font-size:42px;color:#6B7280;line-height:1.6;text-align:center}
.idx{margin-top:56px;text-align:center;font-size:42px;color:#9A9384;letter-spacing:2px}
.cmp{margin-top:56px;display:flex;flex-direction:column;gap:36px}
.cmprow{border-radius:28px;padding:44px 48px;font-size:50px;line-height:1.42;
        display:flex;gap:26px;align-items:flex-start}
.cmprow .mark{flex:0 0 40px;align-self:center;display:flex;
              align-items:center;justify-content:center}
.wrong{background:#F8F1ED;color:#A6522F}
.wrong .mark{color:#B4472E}
.right{background:#EEF3F9;color:#1F4E79;font-weight:600}
.right .mark{color:#1F4E79}
.items{margin-top:20px;display:flex;flex-direction:column;gap:44px}
.item{display:flex;gap:32px;align-items:flex-start}
.num{flex:0 0 76px;height:76px;border-radius:999px;background:#1F4E79;color:#fff;
     font-size:40px;font-weight:600;display:flex;align-items:center;justify-content:center}
.itxt{font-size:48px;color:#2E2E2E;line-height:1.5;padding-top:6px}
.itxt b{color:#1F4E79}
.itxt em{font-style:normal;color:#1F4E79;font-weight:600}
.node{display:flex;flex-direction:column;gap:26px;margin-top:36px}
.row{display:flex;align-items:baseline;gap:28px}
.dot{flex:0 0 22px;height:22px;border-radius:50%;background:#1F4E79;
     align-self:center;position:relative;top:-4px}
.dot.off{background:#CFC8B8}
.rlab{font-size:42px;color:#2E2E2E;font-weight:500;flex:0 0 auto;white-space:nowrap}
.rval{font-size:42px;color:#6B7280;margin-left:auto;text-align:right}
.rval.hot{color:#B4472E;font-weight:600}
.note{margin-top:40px;font-size:44px;color:#8C8578;line-height:1.7;text-align:center}
.shots{display:flex;gap:44px;justify-content:center;align-items:flex-end}
.shotimg{border:2px solid #E6E0D4;border-radius:28px;overflow:hidden;background:#fff}
.shotimg img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.shot1 .shotimg{width:540px;height:1160px}
.shot2 .shotimg{width:450px;height:966px}
.cap{margin-top:56px;font-size:56px;font-weight:600;color:#2E2E2E;text-align:center;line-height:1.42}
.capsub{margin-top:26px;font-size:42px;color:#8C8578;text-align:center;line-height:1.55}
/* ── 深色情绪卡（信息流主图：颜色跳、构图满、主体唯一）── */
.card.dark{background:#141E2D}
.card.dark .foot{border-top-color:#27354A}
.card.dark .fl{color:#8FB4D9}
.card.dark .fr{color:#5A6B7F}
.moodline{font-size:104px;font-weight:700;line-height:1.32;color:#FFFFFF;
          letter-spacing:1px}
.moodline.alt{color:#7FB2E5}
.moodem{margin-top:52px;font-size:52px;font-weight:400;color:#8FA3B8;line-height:1.62}
.foot{margin-top:auto;border-top:2px solid #DCD7CB;padding-top:36px;
      display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
.fl{font-size:36px;font-weight:600;color:#1F4E79;white-space:nowrap}
.fr{font-size:36px;color:#9A9384;text-align:right;max-width:470px;line-height:1.45}
""".replace("FONT_STACK_PLACEHOLDER", FONT_STACK)


def find_chrome() -> str:
    """找 Chrome 可执行文件：CHROME_PATH > 平台默认路径 > PATH 里常见名字。"""
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ):
        if Path(c).exists():
            return c
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p
    raise SystemExit("❌ 找不到 Chrome，请设置 CHROME_PATH 环境变量指向可执行文件")


def esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def esc_br(s) -> str:
    """转义，但允许 <br> 作为换行标记（给 note / tip / sub / cap 用）。"""
    return esc(s).replace("&lt;br&gt;", "<br>").replace("&lt;br/&gt;", "<br>")


def resolve_img(rel: str) -> Path:
    """图片相对路径：先按当前内容目录解析，再按内容库根目录解析。"""
    for base in (CUR_DIR, LIB):
        p = (base / rel).resolve()
        if p.exists():
            return p
    raise FileNotFoundError(f"找不到图片：{rel}")


def img_data_uri(rel: str) -> str:
    """读图 → 按需缩宽 → base64 内嵌，避免 file:// 中文路径问题。"""
    try:
        from PIL import Image
    except ImportError:
        return "file://" + str(resolve_img(rel))
    im = Image.open(resolve_img(rel))
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGB")
    if im.width > IMG_MAX_W:
        im = im.resize((IMG_MAX_W, round(im.height * IMG_MAX_W / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def body_cover(c: dict) -> str:
    pills = "".join(f'<div class="pill">{esc(p)}</div>' for p in c.get("pills", []))
    block = f'<div class="pills">{pills}</div>' if pills else ""
    sub = f'<div class="sub">{esc_br(c["sub"])}</div>' if c.get("sub") else ""
    return f'<div class="mid top"><div class="h1">{c["title"]}</div>{sub}{block}</div>'


def body_word(c: dict) -> str:
    tip = f'<div class="box">{esc_br(c["tip"])}</div>' if c.get("tip") else ""
    idx = f'<div class="idx">{c["i"]} / {c["n"]}</div>' if c.get("i") else ""
    return (f'<div class="mid"><div class="word">{esc(c["en"])}</div>'
            f'<div class="zh">{esc(c["zh"])}</div>{tip}{idx}</div>')


def body_quote(c: dict) -> str:
    zh = f'<div class="zhs">{esc_br(c["zh"])}</div>' if c.get("zh") else ""
    tip = f'<div class="boxs">{esc_br(c["tip"])}</div>' if c.get("tip") else ""
    idx = f'<div class="idx">{c["i"]} / {c["n"]}</div>' if c.get("i") else ""
    return (f'<div class="mid"><div class="quote">{esc_br(c["en"])}</div>'
            f'{zh}{tip}{idx}</div>')


MARK_X = ('<svg width="36" height="36" viewBox="0 0 24 24" fill="none" '
          'stroke="currentColor" stroke-width="3.4" stroke-linecap="round">'
          '<path d="M5.5 5.5L18.5 18.5M18.5 5.5L5.5 18.5"/></svg>')
MARK_V = ('<svg width="36" height="36" viewBox="0 0 24 24" fill="none" '
          'stroke="currentColor" stroke-width="3.4" stroke-linecap="round" '
          'stroke-linejoin="round"><path d="M4 13L9.4 18.4L20 6"/></svg>')


def body_vs(c: dict) -> str:
    q = f'<div class="h3">{esc_br(c["q"])}</div>' if c.get("q") else ""
    tip = f'<div class="boxs">{esc_br(c["tip"])}</div>' if c.get("tip") else ""
    idx = f'<div class="idx">{c["i"]} / {c["n"]}</div>' if c.get("i") else ""
    return (f'<div class="mid">{q}<div class="cmp">'
            f'<div class="cmprow wrong"><span class="mark">{MARK_X}</span>'
            f'<span>{esc_br(c["wrong"])}</span></div>'
            f'<div class="cmprow right"><span class="mark">{MARK_V}</span>'
            f'<span>{esc_br(c["right"])}</span></div></div>{tip}{idx}</div>')


def body_shot(c: dict) -> str:
    imgs = c.get("imgs") or ([c["img"]] if c.get("img") else [])
    cls = "shot1" if len(imgs) == 1 else "shot2"
    cells = "".join(f'<div class="shotimg"><img src="{img_data_uri(p)}" alt=""></div>'
                    for p in imgs)
    cap = f'<div class="cap">{esc_br(c["cap"])}</div>' if c.get("cap") else ""
    sub = f'<div class="capsub">{esc_br(c["sub"])}</div>' if c.get("sub") else ""
    idx = f'<div class="idx">{c["i"]} / {c["n"]}</div>' if c.get("i") else ""
    return (f'<div class="mid"><div class="shots {cls}">{cells}</div>'
            f'{cap}{sub}{idx}</div>')


def body_list(c: dict) -> str:
    items = "".join(
        f'<div class="item"><div class="num">{i}</div><div class="itxt">{t}</div></div>'
        for i, t in enumerate(c["items"], 1))
    title = f'<div class="h2">{esc(c["title"])}</div>' if c.get("title") else ""
    return f'<div class="mid">{title}<div class="items">{items}</div></div>'


def body_steps(c: dict) -> str:
    rows = []
    for step in c["rows"]:
        off = " off" if step.get("off") else ""
        hot = " hot" if step.get("hot") else ""
        rows.append(f'<div class="row"><div class="dot{off}"></div>'
                    f'<div class="rlab">{esc(step["label"])}</div>'
                    f'<div class="rval{hot}">{esc(step["value"])}</div></div>')
    title = f'<div class="h2">{esc(c["title"])}</div>' if c.get("title") else ""
    note = f'<div class="note">{esc_br(c["note"])}</div>' if c.get("note") else ""
    return f'<div class="mid">{title}<div class="node">{"".join(rows)}</div>{note}</div>'


def body_note(c: dict) -> str:
    note = f'<div class="note">{esc_br(c["note"])}</div>' if c.get("note") else ""
    return f'<div class="mid"><div class="h2">{c["title"]}</div>{note}</div>'


def body_mood(c: dict) -> str:
    """情绪语录卡：深色底 + 超大行，1.5 秒内读完。lines 逐行，最后一行可用 alt 强调。"""
    lines = c.get("lines") or []
    n = len(lines)
    html = "".join(
        f'<div class="moodline{" alt" if (c.get("alt_last") and i == n - 1) else ""}">'
        f'{esc_br(t)}</div>' for i, t in enumerate(lines))
    em = f'<div class="moodem">{esc_br(c["em"])}</div>' if c.get("em") else ""
    return f'<div class="mid">{html}{em}</div>'


BODIES = {"cover": body_cover, "word": body_word, "quote": body_quote, "vs": body_vs,
          "shot": body_shot, "list": body_list, "steps": body_steps, "note": body_note,
          "mood": body_mood}

PAGED = ("word", "quote", "vs", "shot", "list")


def render_html(card: dict, foot_left: str, foot_right: str) -> str:
    tag = f'<div class="tag">{esc(card["tag"])}</div>' if card.get("tag") else ""
    foot_r = esc(card.get("foot") or foot_right or "")
    theme = " dark" if card.get("theme") == "dark" else ""
    return (f'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
            f'<style>{CSS}</style></head><body><div class="card{theme}">{tag}'
            f'{BODIES[card["type"]](card)}'
            f'<div class="foot"><div class="fl">{esc(foot_left or "")}</div>'
            f'<div class="fr">{foot_r}</div></div></div></body></html>')


def safe_name(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5_.-]", "_", str(s))


def main() -> int:
    global LIB, CUR_DIR
    ap = argparse.ArgumentParser(description="贴图卡片生成器（cards.json → 1500×2000 PNG）")
    ap.add_argument("--lib", default=os.environ.get("TIETU_LIB", "./内容库"),
                    help="内容库目录（默认 ./内容库）")
    ap.add_argument("--foot-left", default=None,
                    help="卡片左下角署名（默认读 cards.json 顶层 foot_left）")
    ap.add_argument("--foot-right", default=None,
                    help="卡片右下角默认文案（默认读 cards.json 顶层 foot_right）")
    ap.add_argument("--force", action="store_true", help="全部重渲染")
    ap.add_argument("--only", default=None, help="只渲染目录名含该关键字的内容")
    args = ap.parse_args()

    LIB = Path(args.lib).resolve()
    if not LIB.is_dir():
        print(f"❌ 内容库目录不存在：{LIB}")
        return 1
    CHROME = find_chrome()
    WORK = LIB / ".render-work"

    specs = sorted(p for p in LIB.glob("*/cards.json") if p.is_file())
    if args.only:
        specs = [p for p in specs if args.only in p.parent.name]
    if not specs:
        print(f"没有找到规格文件（{LIB}/*/cards.json）")
        return 1

    WORK.mkdir(parents=True, exist_ok=True)
    made = skipped = failed = 0

    for spec in specs:
        data = json.loads(spec.read_text(encoding="utf-8"))
        CUR_DIR = spec.parent
        batch = spec.parent.name
        cards = data["cards"]
        foot_left = args.foot_left if args.foot_left is not None else data.get("foot_left", "")
        foot_right = args.foot_right if args.foot_right is not None else data.get("foot_right", "")

        if data.get("pager"):
            seq = [c for c in cards if c["type"] in PAGED]
            for i, c in enumerate(seq, 1):
                c.setdefault("i", i)
                c.setdefault("n", len(seq))

        outdir = spec.parent / "img"
        outdir.mkdir(parents=True, exist_ok=True)
        print(f"\n【{batch}】{data.get('title', '')}")

        for order, card in enumerate(cards, 1):
            name = f"{order:02d}-{safe_name(card.get('name') or card['type'])}.png"
            out = outdir / name
            if out.exists() and not args.force:
                print(f"  {name:34s} 跳过（已存在）")
                skipped += 1
                continue
            try:
                html = render_html(card, foot_left, foot_right)
            except Exception as exc:
                print(f"  {name:34s} FAIL  {exc}")
                failed += 1
                continue
            hp = WORK / f"{batch}-{order:02d}.html"
            hp.write_text(html, encoding="utf-8")
            cmd = [CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                   "--hide-scrollbars", "--force-device-scale-factor=1",
                   "--window-size=1500,2000", f"--screenshot={out}", f"file://{hp}"]
            subprocess.run(cmd, capture_output=True, text=True)
            ok = out.exists()
            print(f"  {name:34s} {'OK' if ok else 'FAIL'}")
            made += ok
            failed += (not ok)

    print(f"\n新增 {made} 张 · 跳过 {skipped} 张 · 失败 {failed} 张")
    print(f"输出 → {LIB}/*/img/")
    print("下一步：上传到公众号「新的创作 → 贴图」→（可选）插小程序链接 → 人工发布")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
