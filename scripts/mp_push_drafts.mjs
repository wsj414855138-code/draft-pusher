#!/usr/bin/env node
// mp_push_drafts.mjs — 批量把「贴图」内容推进公众号草稿箱（CDP 驱动，不受锁屏影响）
//
// 已验证流程（2026-10 实测定型）：
//   ① 打开 appmsg_edit_v2 贴图编辑器（★ 必须 _v2；appmsg_edit + type=77 是「图文」，长得不一样）
//   ② 图片注入：DOM.setFileInputFiles 直接给隐藏的 <input type=file multiple> 塞文件
//      · 后台标签（不抢前台窗口）里 Input.dispatchDragEvent 拖拽无效 → 拖拽仅作兜底
//      · 上传区只吃 drop 事件、不响应 click 唤起文件框
//   ③ Input.insertText 填标题 / 描述（两个都是 ProseMirror；页面上 textarea 只是隐藏镜像，写它无效）
//      · ProseMirror 会吞掉 \n → 必须逐段 insertText + 段间按 Enter
//   ④（可选）插入小程序链接 —— 需要 --mini-link
//   ⑤ 点「保存为草稿」（保存前后都要清一遍引导弹窗，否则按钮被遮挡、保存静默失败）
//
// 用法：
//   node mp_push_drafts.mjs [--lib <内容库目录>] [--token <token>] [--page <url子串>]
//                           [--mini-link "<小程序链接>"] [--mini-card "<卡片标题>"]
//                           <内容目录名> [内容目录名...]
//
//   内容目录约定（每个目录 = 一条内容）：
//     标题.txt   第一行即标题（公众号限 20 字）
//     文案.txt   描述正文
//     img/       图片，按文件名排序，首张即封面
//
//   前置：调试 Chrome 已启动（scripts/start-chrome.sh）并已登录公众号后台。
//   token 不传时自动从已打开的 mp.weixin.qq.com 页面 URL 中提取。
//   --page 用于多账号场景：指定目标标签的 URL 子串（如 "token=123456789"，即目标账号的 token），
//   配合后台标签使用时不会抢你正在看的前台窗口。

import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 参数解析 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const LIB = path.resolve(opt('--lib', process.env.MP_LIB || './内容库'));
const PAGE_MATCH = opt('--page', process.env.CDP_PAGE_MATCH || '');
const MINI_LINK = opt('--mini-link', process.env.MINI_LINK || '');
const MINI_CARD = opt('--mini-card', process.env.MINI_CARD || '点这里');
let TOKEN = opt('--token', process.env.MP_TOKEN || '');
const PIECES = argv.filter((a) => a && !a.startsWith('--'));

if (!PIECES.length) {
  console.log('用法: node mp_push_drafts.mjs [--lib 目录] [--token T] [--page 子串] [--mini-link 链接] <内容目录名...>');
  process.exit(1);
}

async function listTargets() {
  return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

// token：参数 > 匹配页 > 任意已登录的 mp 后台页
async function resolveToken() {
  if (TOKEN) return TOKEN;
  const ts = await listTargets();
  const pages = ts.filter((t) => t.type === 'page' && (t.url || '').includes('mp.weixin.qq.com'));
  const ordered = PAGE_MATCH
    ? [...pages.filter((p) => p.url.includes(PAGE_MATCH)), ...pages]
    : pages;
  for (const p of ordered) {
    const m = p.url.match(/token=(\d+)/);
    if (m) return m[1];
  }
  return '';
}

async function connect(match) {
  const ts = await listTargets();
  const p = ts.find((t) => t.type === 'page' && (!match || t.url.includes(match)));
  if (!p) throw new Error('找不到目标页面（确认调试 Chrome 已启动且已登录公众号后台）');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let id = 1;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(220);
  };
  const clickSel = async (sel) => {
    const ok = await ev(`(()=>{const e=${sel};if(!e)return false;e.scrollIntoView({block:'center'});return true;})()`);
    if (!ok) return false;
    await sleep(700);                                   // ★ 等滚动真正生效再量坐标
    const p = await ev(`(()=>{const e=${sel};if(!e)return null;const b=e.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`);
    if (!p) return false;
    const { x, y } = JSON.parse(p);
    await clickAt(x, y);
    await ev(`(()=>{const e=${sel};if(e&&e.focus)e.focus();return true;})()`);   // ★ 显式聚焦
    await sleep(200);
    return true;
  };
  // 填文本并校验，失败重试一次（焦点丢失是最常见失败模式）
  const fill = async (sel, text) => {
    for (let i = 0; i < 2; i++) {
      await clickSel(sel);
      await send('Input.insertText', { text });
      await sleep(500);
      const got = await ev(`(()=>{const e=${sel};return e?(e.innerText||'').trim():'';})()`);
      if (got && got.length > 0) return true;
    }
    return false;
  };
  return { ws, send, ev, clickAt, clickSel, fill };
}

async function pressEnter(send) {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
  });
  await send('Input.dispatchKeyEvent', {
    type: 'char', text: '\r', unmodifiedText: '\r',
    key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    key: 'Enter', code: 'Enter',
  });
  await sleep(90);
}

async function dropFiles(send, x, y, files) {
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const items = files.map((f) => ({
    mimeType: MIME[path.extname(f).toLowerCase()] || 'image/png',
    data: fs.readFileSync(f).toString('base64'),
    title: path.basename(f), baseURL: '',
  }));
  const data = { items, files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send('Input.dispatchDragEvent', { type, x, y, data });
    await sleep(type === 'drop' ? 200 : 150);
  }
}

// 主路径：DOM.setFileInputFiles 直接给隐藏的 <input type=file multiple> 注入文件
// （后台标签可用、不抢前台窗口；拖拽在后台标签里无效，仅作兜底）
async function uploadByInput(send, files) {
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const root = doc.result?.root?.nodeId;
  if (!root) return false;
  let q = await send('DOM.querySelector', { nodeId: root, selector: '.image-selector input[type=file]' });
  if (!q.result?.nodeId) q = await send('DOM.querySelector', { nodeId: root, selector: 'input[type=file]' });
  if (!q.result?.nodeId) return false;
  await send('DOM.setFileInputFiles', { files, nodeId: q.result.nodeId });
  return true;
}

// 图片就绪计数：.image-selector 内显示「已就绪 总数」两个数字（如 "7 7"）。
// 不要数 img 元素——懒加载/卡片态会漏计，会报假阴性 0/N。
async function countImgs(ev) {
  return await ev(`(()=>{
    const sel = document.querySelector('.image-selector');
    if (!sel) return 0;
    const m = (sel.innerText || '').match(/(\\d+)\\s+(\\d+)/);
    if (m && +m[2] > 0) return +m[1];
    return [...sel.querySelectorAll('img')].filter(i => {
      const s = i.getAttribute('src') || i.getAttribute('data-src') || '';
      return s && !s.includes('icon_msg');
    }).length;
  })()`);
}

async function main() {
  TOKEN = await resolveToken();
  if (!TOKEN) {
    console.log('❌ 拿不到 token：请确认调试 Chrome 已登录公众号后台（浏览器里随便打开一个后台页即可）');
    process.exit(1);
  }
  console.log(`内容库：${LIB}\ntoken：${TOKEN}${PAGE_MATCH ? ` ｜ 目标标签：*${PAGE_MATCH}*` : ''}\n`);

  for (const name of PIECES) {
    const dir = path.join(LIB, name);
    if (!fs.existsSync(dir)) { console.log(`❌ ${name} 目录不存在`); continue; }
    const title = fs.readFileSync(path.join(dir, '标题.txt'), 'utf8').trim();
    const copy = fs.readFileSync(path.join(dir, '文案.txt'), 'utf8').trim();
    const imgDir = path.join(dir, 'img');
    const imgs = fs.readdirSync(imgDir)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .sort()
      .map((f) => path.join(imgDir, f));

    console.log(`\n▶ ${name}`);
    console.log(`   ${title}（${title.length}字）｜${imgs.length}张图｜文案${copy.length}字`);

    // ① 打开贴图编辑器
    let { ws, send, ev, clickAt, clickSel, fill } = await connect(PAGE_MATCH || undefined);
    await send('Page.navigate', {
      url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=8&token=${TOKEN}&lang=zh_CN`,
    });
    await sleep(6000);

    // ② 上传图片：优先 DOM.setFileInputFiles（后台标签可用），失败再退回拖拽
    //    ⚠️ 先清掉会遮挡按钮的引导弹窗（话题卡片 / 小店返佣 / 未授权切换账号）
    await ev(`(()=>{document.querySelectorAll('.education-dialog').forEach(d=>d.remove());return 1;})()`);
    await sleep(300);
    let nImg = 0;
    const injected = await uploadByInput(send, imgs).catch((e) => { console.log('   ⚠️ 文件注入异常:', e.message); return false; });
    if (injected) {
      for (let i = 0; i < 20; i++) {           // 最多等 40s
        await sleep(2000);
        nImg = await countImgs(ev);
        if (nImg >= imgs.length) break;
      }
    }
    if (nImg < imgs.length) {                  // 兜底：拖拽投送
      const zone = await ev(`(()=>{const e=[...document.querySelectorAll('*')].find(x=>(x.innerText||'').trim()==='选择或拖拽图片');if(!e)return null;const z=e.closest('.image-selector__add')||e;const b=z.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`);
      if (!zone) { console.log('   ❌ 找不到上传区'); ws.close(); continue; }
      const { x, y } = JSON.parse(zone);
      await dropFiles(send, x, y, imgs);
      await sleep(4000);
      nImg = await countImgs(ev);
    }
    console.log(`   图片：${nImg}/${imgs.length}`);

    // ③ 标题（ProseMirror[0]）+ 描述（ProseMirror[1]）
    //    ⚠️ ProseMirror 吞 \n → 逐段 insertText + 段间按 Enter，才能形成真段落
    const okTitle = await fill('document.querySelectorAll("div.ProseMirror")[0]', title);
    if (!okTitle) console.log('   ⚠️ 标题未填入');
    await clickSel('document.querySelectorAll("div.ProseMirror")[1]');
    const paras = copy.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < paras.length; i++) {
      if (i > 0) await pressEnter(send);
      const seg = paras[i];
      for (let k = 0; k < seg.length; k += 150) {   // 单段过长分片，片内不拆词
        await send('Input.insertText', { text: seg.slice(k, k + 150) });
        await sleep(40);
      }
      await sleep(120);
    }
    await sleep(600);
    const t2 = await ev('document.querySelectorAll("div.ProseMirror")[0].innerText');
    const d2 = await ev('document.querySelectorAll("div.ProseMirror")[1].innerText');
    const paraCount = await ev('document.querySelectorAll("div.ProseMirror")[1].querySelectorAll("p").length');
    console.log(`   标题✓(${t2.length}) 描述✓(${d2.length}字 / ${paraCount}段)`);

    // ④ 插入小程序链接（可选；实测：链接必须带 # 前缀，且要点「链接」行 cursor:pointer 的说明文字）
    if (MINI_LINK) {
      let linkOk = false;
      try {
        await clickSel(`[...document.querySelectorAll("div.wording")].find(x=>(x.innerText||"").includes("支持添加内容链接")&&x.offsetParent!==null)`);
        await sleep(1200);
        await clickSel(`[...document.querySelectorAll("*")].filter(x=>(x.innerText||"").trim()==="小程序"&&x.children.length===0&&x.offsetParent!==null).pop()`);
        await sleep(1500);
        const INP = `[...document.querySelectorAll("input.weui-desktop-form__input")].filter(x=>x.offsetParent!==null)`;
        const setVal = (i, text) => ev(`(()=>{const e=${INP}[${i}];if(!e)return;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await clickSel(`${INP}[0]`); await sleep(200); await setVal(0, MINI_LINK);
        await clickSel(`${INP}[1]`); await sleep(200); await setVal(1, MINI_CARD);
        await sleep(400);
        await clickSel(`[...document.querySelectorAll("a,button,span")].filter(e=>(e.innerText||"").trim()==="确定"&&e.offsetParent!==null).pop()`);
        await sleep(3000);
        linkOk = await ev(`/小程序：\\S+/.test(document.body.innerText)`);
      } catch (e) { console.log('   ⚠️ 链接步骤异常:', e.message); }
      console.log(`   小程序链接：${linkOk ? '✅ 已插入' : '❌ 未成功'}`);
    } else {
      console.log('   小程序链接：（未设置 --mini-link，跳过）');
    }

    // ⑤ 保存为草稿（保存前统一清掉可能遮挡按钮的引导弹窗/残留对话框）
    await ev(`(()=>{document.querySelectorAll('.education-dialog').forEach(d=>d.remove());return 1;})()`);
    await sleep(300);
    const ok = await clickSel(`[...document.querySelectorAll('span,button,a')].filter(e=>(e.innerText||'').trim()==='保存为草稿').pop()`);
    if (!ok) { console.log('   ❌ 找不到保存按钮'); ws.close(); continue; }
    await sleep(5000);
    const url = await ev('location.href');
    const hist = await ev(`(document.body.innerText.match(/\\d{2}-\\d{2} \\d{2}:\\d{2}[^|]{0,30}/)||[''])[0].replace(/\\s+/g,' ')`);
    console.log(`   ${/appmsgid/.test(url) ? '✅ 已存草稿' : '⚠️ 未见 appmsgid'}｜历史版本：${hist}`);
    ws.close();
    await sleep(2000);
  }
  console.log('\n全部完成。去「内容管理 → 草稿箱」核对：https://mp.weixin.qq.com');
}

main();
