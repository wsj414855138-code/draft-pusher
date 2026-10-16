---
name: draft-pusher
description: 把内容（标题/文案/图片目录）推进微信公众号「贴图」与小红书「草稿箱」的推送流水线；含卡片渲染（贴图卡片 9 卡型 + 手机壳营销图）。用 CDP 驱动一个已登录的 Chrome——不模拟登录、不碰账号密码、不受锁屏影响。触发词：推草稿、草稿箱、公众号贴图、贴图号、小红书草稿、draft-pusher、多平台推送、开始推稿。
---

# draft-pusher — 多平台「内容 → 草稿箱」推送流水线

把「一条内容」推进多个平台的草稿箱。**发表始终由人完成**——这是本工具的定位，不是缺陷。

## 0. 工作模型

一条内容 = 一个目录（三个渠道共用同一套约定）：

```
内容库/
└── 001-示例内容/
    ├── 标题.txt      标题（公众号限 20 字）
    ├── 文案.txt      正文 / 描述
    └── img/          图片，按文件名排序（首张即封面）
```

三个出口（两个平台）：

| 出口 | 脚本 | 内容形态 |
|---|---|---|
| 微信公众号 · 贴图 | `scripts/mp_push_drafts.mjs` | 图片卡片（newspic，编辑器 type=77） |
| 微信公众号 · 小程序链接 | `scripts/mp_insert_link.mjs` | 给贴图插小程序卡片（单独跑） |
| 微信 · 数据回收 | `scripts/mp_fetch_stats.mjs` | 读发表记录 + 账号概览 |
| 小红书 | `scripts/xhs_push_direct.mjs` | 图文笔记（`封面-主.png` + `img/`）|

> 微信公众号的「图文（长文章）」形态：编辑器结构已探明（见 `references/wechat-console.md` 末尾），
> 完整推送脚本以**贴图**形态为先；图文可用 `cdp.mjs`/`mp_bg.mjs` 按同样方法论操作。

## 1. 铁律（先读这一段）

- **只推到草稿箱，绝不自动发表** —— 发布动作永远由人工在 App / 网页上完成
- **单篇串行** —— 不要并发多标签同时推
- **后台标签纪律** —— 核验/多账号切换用后台标签，不抢用户正在看的窗口
- **不模拟登录、不绕验证码** —— 用你自己已登录的 Chrome；找不到按钮/出验证码就停下报告

## 2. 一次性准备

```bash
# ① 启动调试 Chrome（独立 profile，首次要在窗口里登录两个平台）
./scripts/start-chrome.sh
#    · 登录 mp.weixin.qq.com（公众号后台）
#    · 登录 creator.xiaohongshu.com（小红书创作平台）

# ② 验证连通（应列出标签列表）
node scripts/cdp.mjs list
```

环境要求：Node 18+（原生 fetch / WebSocket）、Chrome、Python 3.8+（仅渲染脚本需要）。

## 3. 日常流程

### 3.1 微信公众号 · 贴图

```bash
# 推一条（token 自动从已登录页面提取，无需手填）
node scripts/mp_push_drafts.mjs --lib ./内容库 001-示例内容

# 多篇依次推
node scripts/mp_push_drafts.mjs --lib ./内容库 001-xxx 002-xxx 003-xxx

# 带小程序链接（一条命令内插好）
node scripts/mp_push_drafts.mjs --lib ./内容库 \
  --mini-link "#小程序://你的小程序/AbCdEfG" --mini-card "点这里" \
  001-示例内容
```

### 3.2 小程序链接补充（贴图先推、链接后补；两步必须分开跑）

```bash
node scripts/mp_insert_link.mjs "#小程序://你的小程序/AbCdEfG" "卡片标题"
```

### 3.3 小红书

```bash
# 标题默认读 标题.txt 第一行；可用 --title 覆盖（小红书标题上限 20 字）
node scripts/xhs_push_direct.mjs --lib ./内容库 001-示例内容
node scripts/xhs_push_direct.mjs --lib ./内容库 --title "短一点更好" 001-示例内容
```

### 3.4 数据回收（公众号贴图）

```bash
node scripts/mp_fetch_stats.mjs                     # 人类可读
node scripts/mp_fetch_stats.mjs --json --out s.json # 入库用
```

## 4. 渲染（可选前置步骤）

```bash
# 贴图卡片：cards.json → 1500×2000 PNG（9 卡型，见 scripts/render/render_tietu.py 头部）
python3 scripts/render/render_tietu.py --lib ./内容库
python3 scripts/render/render_tietu.py --lib ./内容库 --only 005   # 只渲染目录名含 005 的

# 手机壳营销图：App 截图 → 1242×1660（配置驱动，样例见 examples/mockup.example.json）
python3 scripts/render/render_phone_mockup.py --config mockup.json
```

## 5. 核验（推荐习惯）

```bash
# 后台标签无感核验：建一个不抢焦点的隐藏标签，跑完即关
node scripts/mp_bg.mjs --url "https://mp.weixin.qq.com/cgi-bin/appmsgpublish?...&show_type=8&token=..." --shot check.png
node scripts/mp_bg.mjs --url "<任意页面>" --show "document.body.innerText.slice(0, 600)"
node scripts/mp_bg.mjs --url "<任意页面>" --click "草稿箱" --shot after.png
```

## 6. 速查与排错

| 需要什么 | 去哪看 |
|---|---|
| 公众号后台参数 / DOM / 全量坑点 | `references/wechat-console.md` |
| 小红书流程 / 发布按钮技术 / 排查清单 | `references/xhs-publish.md` |
| CDP 基础设施（为什么这么设计、常见问题） | `references/cdp-notes.md` |
| 通用 CDP 操作（eval / click / 截图 / 塞文件） | `node scripts/cdp.mjs`（不带参数看用法） |

平台改版会让选择器失效：先用 `cdp.mjs eval` / `mp_bg.mjs --show` 探查，再改脚本里的选择器；改前先 `--shot` 截图确认现状。

## 7. 边界

- 不自动发表 · 不删除草稿 · 不做批量骚扰式互动
- 工具会以「用户自己的浏览器、正常的操作节奏」运行（单篇串行、带间隔）——请保持这个用法
- 所有自动化都基于**你自己已登录的账号**，工具不存储、不传输任何账号凭证
