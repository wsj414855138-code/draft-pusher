# 这是渲染输出目录

`render_tietu.py` 会把 `cards.json` 里定义的卡片渲染成 PNG 放进这里。
第一次跑之前这个目录是空的，属正常。运行：

```bash
python3 scripts/render/render_tietu.py --lib examples --only sample
```

应当生成三张图：`01-封面.png`、`02-避坑.png`、`03-情绪.png`（1500×2000）。
