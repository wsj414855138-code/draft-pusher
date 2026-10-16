#!/usr/bin/env node
// xhs_push_direct.mjs — 把一条内容推进小红书「草稿箱」（CDP 直连，不受锁屏影响）
//
// 流程（2026-10 实测）：
//   ① 导航到创作平台发布页，切「上传图文」tab
//   ② 注入图片：base64 → File 对象 → DataTransfer → input.upload-input → change 事件
//      （绕过系统文件框；图片名从路径取，顺序即发布顺序）
//   ③ 填标题（原生 setter 写受控 input）+ 正文（tiptap ProseMirror，逐行
//      insertText + insertParagraph；小红书没有帖子标题输入之外的富文本怪癖）
//   ④ 点击底部操作按钮 → 内容落入草稿箱
//
//   ⚠️ 发布动作始终由人工完成（在 App / 网页上核对后手动发布）。
//      本脚本只负责「把内容填好并保存」，不做公开发布。
//
// 用法:
//   node xhs_push_direct.mjs [--lib <内容库目录>] [--title "<≤20字标题>"] <内容目录名>
//
//   内容目录约定（每个目录 = 一条内容）：
//     封面-主.png    封面图（可选；存在则排在第一位）
//     img/           内页图，按文件名排序
//     文案.txt        正文
//     标题.txt        标题（--title 未给时读第一行）
//
// 前置：调试 Chrome 已启动（scripts/start-chrome.sh）且已登录 creator.xiaohongshu.com

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9223);
const PUB_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';

// ── 参数解析 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const LIB = resolve(opt('--lib', process.env.XHS_LIB || './内容库'));
let title = opt('--title', '');
const folder = argv.find((a) => a && !a.startsWith('--'));
if (!folder) {
  console.log('用法: node xhs_push_direct.mjs [--lib 目录] [--title "标题"] <内容目录名>');
  process.exit(1);
}

const dir = join(LIB, folder);
if (!existsSync(dir)) { console.log(`❌ 目录不存在: ${dir}`); process.exit(1); }

// 图片顺序：封面-主.png 优先，然后 img/ 按文件名排序
const imgs = [];
const cover = join(dir, '封面-主.png');
if (existsSync(cover)) imgs.push(cover);
const imgDir = join(dir, 'img');
if (existsSync(imgDir)) {
  for (const f of readdirSync(imgDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()) {
    imgs.push(join(imgDir, f));
  }
}
if (!imgs.length) { console.log('❌ 没找到图片（封面-主.png 或 img/*.png）'); process.exit(1); }

if (!title) {
  const tf = join(dir, '标题.txt');
  if (existsSync(tf)) title = readFileSync(tf, 'utf8').splitlines()[0].trim();
}
if (!title) { console.log('❌ 没有标题（--title 或 标题.txt）'); process.exit(1); }
const body = readFileSync(join(dir, '文案.txt'), 'utf8');
console.log(`▶ ${folder}`);
console.log(`   标题：${title}（${title.length}字）｜图 ${imgs.length} 张｜文案 ${body.length} 字`);

// ── 连接 / 开标签 ─────────────────────────────────────────────────────
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let tgt = list.find((t) => t.type === 'page' && (t.url || '').includes('creator.xiaohongshu.com'));
if (!tgt) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?url=${encodeURIComponent(PUB_URL)}`, { method: 'PUT' });
  tgt = await r.json();
}
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
await new Promise(r => ws.onopen = r);
const ev = async (expr, t = 60000) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: t })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, label, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await ev(expr).catch(() => null);
    if (v && v !== 'null' && v !== 'false' && v !== '') return v;
    await sleep(800);
  }
  console.log('  (超时未就绪:', label, ')');
  return null;
};

// 1. 导航到发布页
await send('Page.enable');
await send('Page.navigate', { url: PUB_URL });
await sleep(7000);
console.log('acct:', await ev('(()=>{const m=document.body.innerText.match(/^(?:创作服务平台\\s*)([^\\n]+)/);return m?m[1].trim().slice(0,20):"?";})()'));

// 2. 切到「上传图文」
const tabHit = await waitFor(`(()=>{const els=[...document.querySelectorAll("div,span,a,button")].filter(e=>(e.innerText||"").replace(/\\s+/g,"")==="上传图文");if(!els.length)return false;els[els.length-1].click();return "ok";})()`, '上传图文', 25000);
console.log('tab:', tabHit);
await waitFor(`(()=>{const i=document.querySelector("input.upload-input");return i?"ready":false;})()`, 'upload-input', 20000);

// 3. 注入图片（base64 → File → DataTransfer → input.files → change）
await ev('window.__dt=new DataTransfer();"init"');
for (const p of imgs) {
  const b64 = readFileSync(p).toString('base64');
  const name = basename(p);
  const r = await ev(`(()=>{const b="${b64}";const bin=atob(b);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);const f=new File([a],"${name}",{type:"image/png"});window.__dt.items.add(f);return "added:"+window.__dt.files.length;})()`, 120000);
  console.log(' ', name, r);
}
console.log('attach:', await ev('(()=>{const inp=document.querySelector("input.upload-input");if(!inp)return "no-input";inp.files=window.__dt.files;inp.dispatchEvent(new Event("change",{bubbles:true}));return "assigned:"+inp.files.length;})()'));
await sleep(6000);
console.log('imgs:', await ev('(()=>{const m=document.body.innerText.match(/图片编辑 (\\d+)\\/\\d+/);return m?m[1]+" uploaded":"?";})()'));

// 4. 标题 + 正文
await waitFor(`(()=>{return document.querySelector('input[placeholder*="标题"]')?"ok":false;})()`, 'title-input', 20000);
console.log('title:', await ev(`(()=>{const i=document.querySelector('input[placeholder*="标题"]');if(!i)return "no-title";const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;set.call(i,${JSON.stringify(title)});i.dispatchEvent(new Event("input",{bubbles:true}));return i.value.length;})()`));
const bodyJson = JSON.stringify(body.replace(/\r/g, ''));
console.log('body:', await ev(`(()=>{const body=${bodyJson};const ed=document.querySelector(".tiptap.ProseMirror");if(!ed)return "no-editor";ed.focus();const lines=body.split("\\n").filter(l=>l.trim()!=="");for(let k=0;k<lines.length;k++){document.execCommand("insertText",false,lines[k]);if(k<lines.length-1)document.execCommand("insertParagraph");}return "lines:"+lines.length;})()`, 120000));

// 5. 点底部操作按钮 → 内容落入草稿箱
//    （实测：点击后页面出现「草稿箱」相关文案；如需确认，用 cdp.mjs 读页面或到后台核对）
await sleep(1200);
console.log('save:', await ev('(()=>{const b=[...document.querySelectorAll("div")].find(e=>e.className==="btn-wrapper");if(!b)return "no-btn";b.click();return "clicked";})()'));
await sleep(4000);
console.log('after:', await ev('(()=>{const m=document.body.innerText.match(/草稿箱[^\\n]{0,6}/);return m?m[0]:"?";})()'));
ws.close(); process.exit(0);
