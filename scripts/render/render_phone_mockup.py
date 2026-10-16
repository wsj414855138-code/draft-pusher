#!/usr/bin/env python3
"""render_phone_mockup.py — 「手机壳营销图」生成器（真实 iPhone 15 Pro 几何）

把 App / 小程序截图放进一台用几何参数画出来的 iPhone 15 Pro 里，配大标题文案，
输出 1242×1660（3:4）营销图 —— 小红书 / 公众号导流场景通用。

几何推导（iPhone 15 Pro）：
    机身 70.6×146.6mm → 宽高比 0.4816 ｜ 屏幕 393×852pt → 宽高比 0.4613
    机身宽 880px → 机身高 1827px；屏幕 811×1758px；边框 20px（含灵动岛 / Home 条）

用法：
    python3 render_phone_mockup.py --config mockup.json

配置文件示例（mockup.json）：
{
  "screens": "./screens",            ← 截图目录
  "out": "./out",                    ← 输出目录
  "cards": [
    {
      "file": "1-首页.png",           ← 截图文件名（相对 screens）
      "l1": "录一段讲解",              ← 大标题第一行
      "l2": "AI 当场给分",             ← 大标题第二行（浅绿强调）
      "sub": "录音 → 转写 → 四维点评"   ← 副标题
    }
  ]
}

依赖：Chrome（HTML → 截图；CHROME_PATH 可指定可执行文件）
"""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def find_chrome() -> str:
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


# ── 设备几何（iPhone 15 Pro）─────────────────────────────────────────
BODY_W = 880
BODY_H = round(BODY_W / 0.4816)        # 1827
SCR_W = round(BODY_W * 0.955)          # 840
SCR_H = round(SCR_W / 0.4613)          # 1822
BEZEL = (BODY_W - SCR_W) // 2          # 20
BODY_R = round(BODY_W * 0.170)         # 150
SCR_R = BODY_R - BEZEL                 # 130
PHONE_TOP = 366
PHONE_LEFT = (1242 - BODY_W) // 2

# 灵动岛 / Home 条（按 393pt 基准换算）
ISL_W = round(125 / 393 * SCR_W)       # ≈258
ISL_H = round(37 / 852 * SCR_H)        # ≈76
ISL_TOP = round(11 / 852 * SCR_H)      # ≈23
BAR_W = round(139 / 393 * SCR_W)       # ≈287
BAR_H = round(5 / 852 * SCR_H)         # ≈10
BAR_BOT = round(8 / 852 * SCR_H)       # ≈17

TPL = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  html, body {{ width:1242px; height:1660px; overflow:hidden; }}
  .card {{
    position:relative; width:1242px; height:1660px; overflow:hidden;
    background:
      radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 58%),
      linear-gradient(168deg, #0f6f57 0%, #0d614b 40%, #0a5240 72%, #083f31 100%);
    font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  }}
  /* ── 顶部文案 ── */
  .copy {{ position:absolute; top:84px; left:88px; right:88px; z-index:20; }}
  .copy h1 {{
    font-size:76px; font-weight:700; letter-spacing:1px; line-height:1.16;
    color:#ffffff;
  }}
  .copy h1 .l2 {{ color:#a9ecd1; }}
  .copy .sub {{
    margin-top:22px; font-size:31px; font-weight:400;
    color:rgba(255,255,255,.76); letter-spacing:.6px;
  }}
  /* ── 机身 ── */
  .phone {{
    position:absolute;
    left:{phone_left}px; top:{phone_top}px;
    width:{body_w}px; height:{body_h}px;
    border-radius:{body_r}px;
    background:
      linear-gradient(96deg,
        #8e8e93 0%, #d8d8dc 6%, #5a5a5e 14%, #3a3a3c 30%,
        #2a2a2c 50%, #3a3a3c 70%, #5a5a5e 86%, #d8d8dc 94%, #8e8e93 100%);
    box-shadow:
      0 3px 1px rgba(255,255,255,.28) inset,
      0 -3px 2px rgba(0,0,0,.55) inset,
      0 30px 70px rgba(0,0,0,.40),
      0 10px 26px rgba(0,0,0,.28);
    z-index:5;
  }}
  /* 侧边按键 */
  .btn {{
    position:absolute; width:5px; border-radius:3px;
    background:linear-gradient(90deg,#c9c9cd,#7c7c80 45%,#4a4a4e);
  }}
  .btn.power {{ right:-4px; top:474px; height:132px; }}
  .btn.volup {{ left:-4px; top:392px; height:104px;
    background:linear-gradient(90deg,#4a4a4e,#7c7c80 55%,#c9c9cd); }}
  .btn.voldn {{ left:-4px; top:516px; height:104px;
    background:linear-gradient(90deg,#4a4a4e,#7c7c80 55%,#c9c9cd); }}
  .btn.mute  {{ left:-4px; top:286px; height:60px;
    background:linear-gradient(90deg,#4a4a4e,#7c7c80 55%,#c9c9cd); }}
  /* ── 屏幕 ── */
  .screen {{
    position:absolute;
    left:{bezel}px; top:{bezel}px;
    width:{scr_w}px; height:{scr_h}px;
    border-radius:{scr_r}px;
    overflow:hidden;
    background:#f6f6f4;
    box-shadow:0 0 0 1px rgba(0,0,0,.85);
  }}
  .screen img {{ display:block; width:{scr_w}px; height:auto; }}
  /* 灵动岛 */
  .island {{
    position:absolute; top:{isl_top}px; left:50%; transform:translateX(-50%);
    width:{isl_w}px; height:{isl_h}px; border-radius:{isl_r}px;
    background:#000; z-index:12;
  }}
  .island::after {{  /* 前摄 */
    content:''; position:absolute; right:16px; top:50%; transform:translateY(-50%);
    width:{cam}px; height:{cam}px; border-radius:50%;
    background:radial-gradient(circle at 35% 35%, #2b2b3a 0%, #0a0a12 70%);
    box-shadow:0 0 0 1px rgba(90,90,120,.5);
  }}
  /* Home 指示条 */
  .bar {{
    position:absolute; bottom:{bar_bot}px; left:50%; transform:translateX(-50%);
    width:{bar_w}px; height:{bar_h}px; border-radius:{bar_h_half}px;
    background:rgba(0,0,0,.78); z-index:12;
  }}
  /* ── 顶部品牌标签 ── */
  .tag {{
    display:inline-block; margin-top:30px; padding:11px 26px;
    border:2px solid rgba(169,236,209,.45); border-radius:999px;
    font-size:25px; font-weight:500; letter-spacing:2px;
    color:rgba(169,236,209,.95);
  }}
  /* ── 底部渐隐（无文字，自然过渡）── */
  .scrim {{
    position:absolute; left:0; right:0; bottom:0; height:132px; z-index:15;
    background:linear-gradient(180deg,
      rgba(8,63,49,0) 0%, rgba(8,63,49,.62) 46%, rgba(8,63,49,1) 100%);
  }}
</style></head><body>
<div class="card">
  <div class="copy">
    <h1>{l1}<br><span class="l2">{l2}</span></h1>
    <div class="sub">{sub}</div>
  </div>

  <div class="phone">
    <div class="btn mute"></div>
    <div class="btn volup"></div>
    <div class="btn voldn"></div>
    <div class="btn power"></div>
    <div class="screen">
      <img src="file://{img}" alt="">
      <div class="island"></div>
      <div class="bar"></div>
    </div>
  </div>

  <div class="scrim"></div>
</div>
</body></html>'''


def main() -> int:
    ap = argparse.ArgumentParser(description="手机壳营销图生成器（1242×1660）")
    ap.add_argument("--config", required=True, help="配置文件路径（JSON）")
    ap.add_argument("--screens", default=None, help="覆盖配置里的截图目录")
    ap.add_argument("--out", default=None, help="覆盖配置里的输出目录")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    screens = Path(args.screens or cfg.get("screens", "./screens")).resolve()
    outdir = Path(args.out or cfg.get("out", "./out")).resolve()
    cards = cfg.get("cards", [])
    if not cards:
        print("❌ 配置里没有 cards")
        return 1

    CHROME = find_chrome()
    work = outdir / ".render-work"
    outdir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    okn = 0
    for i, card in enumerate(cards, 1):
        fname = card["file"]
        img = screens / fname
        if not img.exists():
            print(f'{i}-{fname:18s} FAIL  截图不存在: {img}')
            continue
        html = TPL.format(
            img=img, l1=card.get("l1", ""), l2=card.get("l2", ""), sub=card.get("sub", ""),
            phone_left=PHONE_LEFT, phone_top=PHONE_TOP,
            body_w=BODY_W, body_h=BODY_H, body_r=BODY_R, bezel=BEZEL,
            scr_w=SCR_W, scr_h=SCR_H, scr_r=SCR_R,
            isl_w=ISL_W, isl_h=ISL_H, isl_top=ISL_TOP, isl_r=round(ISL_H / 2),
            cam=round(ISL_H * 0.36),
            bar_w=BAR_W, bar_h=BAR_H, bar_bot=BAR_BOT, bar_h_half=round(BAR_H / 2),
        )
        hp = work / f"f{i}.html"
        hp.write_text(html, encoding="utf-8")
        out = outdir / f"{i}-{fname}"
        cmd = [CHROME, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
               "--force-device-scale-factor=1", "--window-size=1242,1660",
               f"--screenshot={out}", f"file://{hp}"]
        subprocess.run(cmd, capture_output=True, text=True)
        ok = out.exists()
        print(f'{i}-{fname:18s} {"OK" if ok else "FAIL"}')
        okn += ok

    print(f"\n成功 {okn}/{len(cards)} 张")
    print(f"几何: 机身 {BODY_W}×{BODY_H}  边框 {BEZEL}px  屏幕 {SCR_W}×{SCR_H}  圆角 {BODY_R}/{SCR_R}")
    print("输出 →", outdir)
    return 0 if okn == len(cards) else 2


if __name__ == "__main__":
    raise SystemExit(main())
