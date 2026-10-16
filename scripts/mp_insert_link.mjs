#!/usr/bin/env node
// mp_insert_link.mjs — 在贴图编辑器里插入小程序链接（每步校验，失败即停）
//
// 为什么单独一个脚本：实测「内容推送」与「插链接」必须分开跑 ——
// 合进批量循环会因面板展开时序对不上而失败。
//
// 流程（每步都读页面校验，不盲串）：
//   ① 找「链接」行的说明文字 div.wording → 真实点击 → 校验面板是否打开
//   ② 在面板里切到「小程序」标签（默认是「内容链接」）→ 校验出现「小程序链接」
//   ③ 填小程序链接 + 卡片标题（用原生 setter 清空，Cmd+A 在受控 input 里不可靠）
//   ④ 点「确定」→ 校验链接区出现「小程序：xxx」
//   ⑤ 面板若还开着 → 主动关掉（否则后续「保存为草稿」会失效）
//   ⑥ 保存为草稿
//
// 用法:
//   node mp_insert_link.mjs "<小程序链接>" ["<卡片标题>"]
//
//   小程序链接格式必须带 # 前缀，如：
//     "#小程序://你的小程序名称/AbCdEfG123456"
//   （后台报「请输入正确的小程序的链接」基本都是少了 # 号）
//
// 前置：贴图编辑器页面已打开（先用 mp_push_drafts.mjs 推内容，或手动打开草稿编辑）

const PORT = process.env.CDP_PORT || 9223;
const LINK = process.argv[2];
const CARD = process.argv[3] || '点这里';
if (!LINK) {
  console.log('用法: node mp_insert_link.mjs "<小程序链接（带 #）>" ["<卡片标题>"]');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = ts.find((t) => t.type === 'page' && t.url.includes('appmsg_edit'));
if (!page) { console.log('❌ 当前不在贴图编辑器页面（先推内容或手动打开草稿编辑）'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 1; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (me, pp = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pp })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
const body = () => ev('document.body.innerText');
// ★ 面板是否打开：看 .btm-card-link_item 是否可见（w>0）。
//   不能用 innerText.includes('内容链接')——页面上「支持内容链接、小程序、小店商品」本身就含这四个字。
const panelOpen = () => ev(`(()=>{const t=[...document.querySelectorAll('.btm-card-link_item')].find(e=>e.getBoundingClientRect().width>0);return t?t.id:'';})()`);
// 「插入小程序」模态框是否已开（开了就别再去点 wording，会把下层面板关掉）
const modalOpen = () => ev(`(()=>{const t=document.body.innerText;return t.includes('插入小程序')&&t.includes('小程序链接');})()`);
const clickXY = async (x, y) => {
  for (const t of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
  await sleep(500);
};
// 点一个元素：先滚 → 等 → 重新量坐标 → 点
const clickEl = async (expr) => {
  const found = await ev(`(()=>{const e=${expr};if(!e)return false;e.scrollIntoView({block:'center'});return true;})()`);
  if (!found) return false;
  await sleep(700);
  const p = await ev(`(()=>{const e=${expr};if(!e)return null;const b=e.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`);
  if (!p) return false;
  const { x, y } = JSON.parse(p);
  await clickXY(x, y);
  return true;
};

// ★ 关键：面板/标签这类元素，CDP 真实鼠标点不动，必须用 JS .click()；
//   而「确定」按钮反过来，必须用真实鼠标事件。两个都要。
const jsClick = async (expr) => ev(`(()=>{const e=${expr};if(!e)return false;e.click();return true;})()`);
const log = (...a) => console.log(...a);

// ① 打开链接面板（三种已开状态都要认，否则会误点 wording 把下层面板关掉）
let modal = await modalOpen();
let openedId = await panelOpen();
if (modal) log('① 「插入小程序」模态框已开');
else if (openedId) log('① 面板已开：', openedId);
else {
  const ok = await jsClick(`[...document.querySelectorAll('div.wording')].find(x=>(x.innerText||'').includes('支持添加内容链接')&&x.offsetParent!==null)`);
  await sleep(1500);
  openedId = await panelOpen(); modal = await modalOpen();
  log(ok && (openedId || modal) ? `① 面板已打开（${openedId || '模态框'}）` : `① 打开失败（wording=${ok}）`);
  if (!openedId && !modal) { const t = await body(); console.log('   尾部：' + t.replace(/\s+/g, ' ').slice(-140)); ws.close(); process.exit(2); }
}

let t;
// ② 切到「小程序」标签（实测 id = btm-card-link_mini-program；默认 tab 是「内容链接」）
t = await body();
modal = await modalOpen();
if (!t.includes('小程序链接')) {
  const clicked = await jsClick(`[...document.querySelectorAll('.btm-card-link_item')].find(x=>x.offsetParent!==null&&x.innerText.trim()==='小程序')`);
  await sleep(1500);
  t = await body();
  log(clicked && t.includes('小程序链接') ? '② 已切到「小程序」' : `② 切换失败（点击=${clicked}）`);
  if (!t.includes('小程序链接')) { ws.close(); process.exit(3); }
} else log('② 已在「小程序」标签');

// ③ 填两个框
const INP = `[...document.querySelectorAll('input.weui-desktop-form__input')].filter(x=>x.offsetParent!==null)`;
const setVal = (i, v) => ev(`(()=>{const e=${INP}[${i}];if(!e)return false;
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
await clickEl(`${INP}[0]`); await sleep(300);
const a1 = await setVal(0, LINK);
await clickEl(`${INP}[1]`); await sleep(300);
const a2 = await setVal(1, CARD);
await sleep(500);
const vals = await ev(`JSON.stringify(${INP}.map(x=>x.value))`);
log('③ 已填：', vals, a1 && a2 ? '' : '（有字段没找到）');

// ④ 点确定
// ★ 确定按钮是 <button class="weui-desktop-btn weui-desktop-btn_primar">。
//   模态框是 fixed 定位 → offsetParent 为 null，所以**不能按 offsetParent 过滤**；
//   而且要点 button 本身，点外层 span 无效。
const ok4 = await ev(`(()=>{const bs=[...document.querySelectorAll('button')].filter(e=>(e.innerText||'').trim()==='确定');if(!bs.length)return false;bs[bs.length-1].click();return true;})()`);
await sleep(2000);
t = await body();
const done = /小程序：\S+/.test(t);
log(ok4 && done ? '④ 链接已插入' : `④ 插入失败（点确定=${ok4}）`);

// ⑤ 面板若仍开着，主动关掉（否则后续保存会失效）
t = await body();
if (t.includes('小程序链接')) {
  await clickEl(`[...document.querySelectorAll('a,button,span,i,div')].filter(e=>e.offsetParent!==null&&((e.className||'')+'').match(/close|icon-close/)).pop()`)
    || await ev(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}));return 1})()`);
  await sleep(800);
  t = await body();
  log('⑤ 面板残留：', t.includes('小程序链接') ? '仍在' : '已关闭');
}
// ⑥ 保存为草稿（★ 也必须用 JS .click()，坐标点击点不中）
const saved = await ev(`(()=>{const b=[...document.querySelectorAll('button,span,a')]
  .filter(e=>(e.innerText||'').trim()==='保存为草稿'&&e.offsetParent!==null);
  if(!b.length)return false; b[b.length-1].scrollIntoView({block:'center'}); b[b.length-1].click(); return true;})()`);
await sleep(4000);
const ok6 = await ev(`/appmsgid/.test(location.href)`);
log(ok6 ? '⑥ 已存草稿' : (saved ? '⑥ 点了保存但 URL 无 appmsgid' : '⑥ 保存按钮未找到'));

ws.close();
process.exit(ok6 ? 0 : 5);
