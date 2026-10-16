# CDP 基础设施笔记

> 这套工具为什么长这样：一个决策 + 一摞踩坑换来的。

## 一、为什么是 CDP，不是坐标点击 / 也不是 Playwright

| 通道 | 受锁屏影响 | 登录态 | 结论 |
|---|---|---|---|
| 坐标点击（CGEvents / macOS AX） | ❌ 必须屏幕解锁 + 前台会话 | 用当前屏幕上的浏览器 | 笔记本一锁屏就废 |
| Playwright / Selenium 驱动新实例 | ✅ | ❌ 要模拟登录 / 存 Cookie / 过验证码 | 重、脆、碰账号密码 |
| **CDP 接管「你自己已登录的 Chrome」** | ✅ 事件直接进渲染进程 | ✅ 就用你的登录态 | **本工具的选择** |

附带好处：**文件上传不用跟系统原生文件框搏斗**——`DOM.setFileInputFiles` 直接塞。

## 二、调试 Chrome 的启动

```bash
./scripts/start-chrome.sh        # 脚本里已封装；核心参数如下
```

```bash
"/path/to/Chrome" \
  --remote-debugging-port=9223 '--remote-allow-origins=*' \
  --user-data-dir="$HOME/.draft-pusher/chrome-profile" \
  --no-sandbox --disable-gpu --no-first-run --no-default-browser-check \
  --window-size=1512,950 "https://mp.weixin.qq.com/"
```

- `--user-data-dir` 独立 profile：不污染日常浏览器；**登录态存在 profile 里，下次免登录**
- `--no-sandbox --disable-gpu`：让 Chrome 在受限环境（沙箱 / 部分自动化环境）也能启动；
  自己电脑上不需要可以去掉
- 端口 9223 是惯例，`CDP_PORT` 可覆盖
- ⚠️ **别把这个实例暴露到公网**——调试端口能看到登录态

## 三、后台标签（本工具的核心纪律）

```js
// 建一个「后台标签」：不抢焦点、用户完全无感
await send('Target.createTarget', { url: 'about:blank', background: true });
await send('Target.attachToTarget', { targetId, flatten: true });
// ...干活（导航 / 截图 / 执行 JS / 真实点击）...
await send('Target.closeTarget', { targetId });   // 用完即关
```

**为什么重要**：脚本运行时用户可能正在看别的页面。后台标签让自动化对用户「无感」，
也避免抢焦点导致用户操作被打断。`scripts/mp_bg.mjs` 就是这条纪律的载体。

### 后台标签里的两个坑（实测）

| 坑 | 症状 | 正解 |
|---|---|---|
| `Input.dispatchDragEvent` 拖拽失效 | 文件拖不进去（图片 0/N），其他操作正常 | 拖拽只在前台标签可用；改用 `DOM.setFileInputFiles` |
| 部分站点的懒加载计数骗人 | 数 `img` 元素报 0，实际已上传 | 读页面自己的状态文本（如「已就绪 总数」） |

## 四、实用技巧集

1. **可信输入**：`Input.insertText` 等价于逐字敲入，React 受控组件能收到；`el.value=` 不行
2. **受控输入清空**：原生 setter + 派发 `input` 事件（见 `references/wechat-console.md` 坑 2）
3. **点击前先滚动、滚动后重新量坐标**：
   ```js
   el.scrollIntoView({block:'center'}); await sleep(700);
   const b = el.getBoundingClientRect();   // 滚完再量！
   ```
4. **JS `.click()` vs 真实鼠标**：面板/标签类元素 JS click 有效、坐标点击点不中；
   确定/提交按钮反过来——两种都备着，按元素试
5. **iframe 里的元素**：`Page.getFrameTree` 找 frame → `Page.createIsolatedWorld` → 带 `contextId` evaluate
   （mp_bg.mjs 的 `--match <子串>` 已封装）

## 五、环境坑

| 坑 | 症状 | 正解 |
|---|---|---|
| 本地代理 | curl / fetch 连不上 `127.0.0.1:9223` | `--noproxy '*'`；或检查 `HTTP_PROXY` 环境变量 |
| zsh 通配符 | `--remote-allow-origins=*` 报 no matches | 加引号 `'--remote-allow-origins=*'` |
| Node 版本 | 脚本报 `fetch is not defined` / `WebSocket is not defined` | 需要 Node 18+（用原生 fetch / WebSocket，零依赖） |

## 六、安全边界

- 调试实例 = 你登录态的化身：**只在本机跑**，不要端口转发、不要局域网暴露
- 本仓库脚本**不读取、不存储、不传输**任何账号凭证；不碰 Cookie、不碰密码
- 不做验证码绕过；遇到验证/风控提示 → 停下、报告、人工处理
