#!/usr/bin/env node
// mp_fetch_stats.mjs — 回收公众号「贴图」已发表内容的数据（发布闭环的最后一环）
//
// 拉取来源（借用一个已登录的后台标签，依次导航）：
//   ① 发表记录 · 贴图视图：每篇可见 阅读/分享/留言/点赞/收藏/转发
//   ② 内容分析页：账号级 昨日/7天/30天 阅读 + 传播渠道分布
//
// 用法:
//   node mp_fetch_stats.mjs                     人类可读输出
//   node mp_fetch_stats.mjs --json              输出 JSON（便于入库）
//   node mp_fetch_stats.mjs --json --out x.json 同时写入文件
//   node mp_fetch_stats.mjs --token <token>     手动指定 token（默认自动抓）
//   node mp_fetch_stats.mjs --page <url子串>     指定借用的标签页（多账号场景）
//
// 前置：调试 Chrome 已启动并已登录公众号后台（脚本会导航页面上这个标签）。

import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9223;

// ── 参数解析 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const AS_JSON = argv.includes('--json');
const OUT = opt('--out', process.env.STATS_OUT || '');
const PAGE_MATCH = opt('--page', process.env.CDP_PAGE_MATCH || '');
const ACCOUNT = process.env.MP_ACCOUNT || '';
let TOKEN = opt('--token', process.env.MP_TOKEN || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = ts.filter((t) => t.type === 'page');
const page = (PAGE_MATCH ? pages.find((p) => (p.url || '').includes(PAGE_MATCH)) : null)
  || pages.find((p) => (p.url || '').includes('mp.weixin.qq.com'))
  || pages[0];
if (!page) { console.log('❌ 找不到标签页（调试 Chrome 没启动？）'); process.exit(1); }
if (!TOKEN) {
  for (const p of pages) {
    const m = (p.url || '').match(/token=(\d+)/);
    if (m) { TOKEN = m[1]; break; }
  }
}
if (!TOKEN) { console.log('❌ 拿不到 token：请确认调试 Chrome 已登录公众号后台'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 1; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;

async function go(url) {
  await send('Page.navigate', { url });
  await sleep(5500);
}

// ① 发表记录（贴图）—— URL 带 show_type=8 直接进贴图视图，再点一次标签做兜底
await go(`https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=20&show_type=8&token=${TOKEN}&lang=zh_CN`);
const tabPos = await ev(`(()=>{
  const t=[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim().startsWith('贴图')&&e.children.length<=1);
  if(!t) return null;
  t.scrollIntoView({block:'center'});
  const r=t.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
})()`);
if (tabPos) {
  const { x, y } = JSON.parse(tabPos);
  for (const t of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
  await sleep(3500);
}
const rows = await ev(`(()=>{
  // 发表记录·贴图 的 innerText 结构（实测）：
  //   <时间> / <状态> / <标题> / n×6（阅读 分享 留言 点赞 收藏 转发） / <下一条时间>...
  const lines=document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean);
  const isTime=s=>/^(今天|昨天|前天|\\d{1,2}月\\d{1,2}日)/.test(s);
  const isNum=s=>/^\\d+$/.test(s);
  const total=Number((document.body.innerText.match(/发表了\\s*(\\d+)\\s*篇贴图/)||[])[1]||0);
  const items=[];
  for(let i=0;i<lines.length;i++){
    if(!isTime(lines[i])) continue;
    const time=lines[i], status=lines[i+1]||'', title=lines[i+2]||'';
    const metrics=[]; let k=i+3;
    while(metrics.length<6 && isNum(lines[k])){ metrics.push(Number(lines[k])); k++; }
    if(metrics.length===6) items.push({time,status,title,metrics});
  }
  return JSON.stringify({total, items});
})()`);
const payload = JSON.parse(rows || '{}');
const list = payload.items || [];

// ② 账号概览（内容分析）
await go(`https://mp.weixin.qq.com/misc/appmsganalysis?action=report&indicatorSelect=read&type=daily_v2&token=${TOKEN}&lang=zh_CN`);
const overview = await ev(`(()=>{
  const t=document.body.innerText;
  const grab=(label)=>{const m=t.match(new RegExp(label+'\\\\s*([\\\\d.]+)'));return m?Number(m[1]):null;};
  const ch=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/^(全部|公众号消息|推荐|聊天|朋友圈|公众号主页|搜一搜|其它)$/.test((e.innerText||'').trim()));
  return JSON.stringify({read_yesterday:grab('阅读'), read7:grab('最近 7 天'), shares:grab('分享'), comments:grab('留言'), channels:ch.map(e=>e.innerText.trim())});
})()`);
const ov = JSON.parse(overview || '{}');

const out = { fetched_at: new Date().toISOString(), ...(ACCOUNT ? { account: ACCOUNT } : {}), overview: ov, published: list };
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`账号概览：昨日阅读 ${ov.read_yesterday ?? '—'} ｜ 7天 ${ov.read7 ?? '—'} ｜ 分享 ${ov.shares ?? '—'} ｜ 留言 ${ov.comments ?? '—'}`);
  console.log(`传播渠道维度：${(ov.channels || []).join(' / ') || '—'}\n`);
  console.log(`已发表贴图（${list.length} 篇）：`);
  console.log('  时间\t\t状态\t\t阅读/分享/留言/点赞/收藏/转发\t标题');
  for (const r of list) {
    const m = (r.metrics || []).slice(0, 6).join('/');
    console.log(`  ${(r.time || '').padEnd(14)}${(r.status || '').padEnd(6)}${(m || '—').padEnd(30)}${r.title}`);
  }
  const newest = list[0];
  if (newest) {
    const m = newest.metrics || [];
    console.log(`\n最新一篇《${newest.title}》：`);
    console.log(`  阅读 ${m[0] ?? 0} ｜ 分享 ${m[1] ?? 0} ｜ 留言 ${m[2] ?? 0} ｜ 点赞 ${m[3] ?? 0} ｜ 收藏 ${m[4] ?? 0} ｜ 转发 ${m[5] ?? 0}`);
    const total = (m || []).reduce((a, b) => a + b, 0);
    console.log(`  互动合计 ${total} —— 刚发布 1 小时内属正常冷启动，建议 T+1 与 T+7 各看一次`);
  }
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`\n已写入 ${OUT}`); }
ws.close();
