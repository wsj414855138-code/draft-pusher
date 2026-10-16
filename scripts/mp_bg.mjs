#!/usr/bin/env node
// mp_bg.mjs — 「后台标签」CDP 探针（建一个不抢焦点的隐藏标签，跑完即关）
//
// 用途：在**不影响你当前操作**的前提下，打开任意页面做核验：
//   读页面结构 / 执行 JS / 真实点击 / 截图 / 列出 iframe。
//   典型场景：推完草稿后去后台「发表记录」「草稿箱」核验时，
//   不要抢走用户正在看的标签（用户可能正在干别的）。
//
// 纪律：只用 Target.createTarget({background:true}) 建标签，核验完即关。
//      禁止前台开页、禁止导航/切换用户正在看的标签。
//
// 用法:
//   node mp_bg.mjs --url <url> [--wait 8000] [--show "<js>"] [--shot out.png] [--keep]
//   node mp_bg.mjs --url <url> --frames                        列出所有 frame
//   node mp_bg.mjs --url <url> --match <子串> --show "<js>"    在匹配 frame 内执行
//   node mp_bg.mjs --url <url> --click "<文字>" [--shot out.png]  真实点击（按文字找元素）
//
// 环境变量: CDP_PORT（默认 9223）

import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9223;
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const url = argOf('--url');
const waitMs = parseInt(argOf('--wait') || '9000', 10);
const frameMatch = argOf('--match') || '';
const shot = argOf('--shot') || '';
const jsExpr = argOf('--show') || '';
const clickText = argOf('--click') || '';
const keep = argv.includes('--keep');
const wantFrames = argv.includes('--frames');
const doReload = argv.includes('--reload');
if (!url) { console.log('缺少 --url'); process.exit(1); }

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 1; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const DBG = process.env.DBG === '1';
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const i = id++; pend.set(i, r);
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
}).then((m) => {
  if (DBG) console.log(`  · ${method} →`, JSON.stringify(m).slice(0, 400));
  return m;
});

let targetId = null;
try {
  const cr = await send('Target.createTarget', { url: 'about:blank', background: true });
  targetId = cr.result && cr.result.targetId;
  if (!targetId) throw new Error('createTarget failed: ' + JSON.stringify(cr).slice(0, 300));
  const att = await send('Target.attachToTarget', { targetId, flatten: true });
  const sid = att.result && att.result.sessionId;
  if (!sid) throw new Error('attach failed');
  const S = (method, params = {}) => send(method, params, sid);

  const ev = async (expr, ctxId) => {
    const res = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...(ctxId ? { contextId: ctxId } : {}) });
    const r = res.result || {};
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails).slice(0, 400) };
    return r.result ? r.result.value : undefined;
  };

  await S('Page.enable'); await S('Runtime.enable');
  await S('Page.navigate', { url });

  // 等待加载完成
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const st = await ev('document.readyState').catch(() => null);
    if (st === 'complete') break;
    await sleep(500);
  }
  await sleep(1500);
  if (doReload) { await S('Page.reload', { ignoreCache: true }); await sleep(9000); }

  const collectFrames = async () => {
    const tree = await S('Page.getFrameTree');
    const frames = [];
    (function walk(n, d) { frames.push({ id: n.frame.id, url: (n.frame.url || '').slice(0, 160), d }); (n.childFrames || []).forEach((c) => walk(c, d + 1)); })(tree.result.frameTree, 0);
    return frames;
  };
  let frames = await collectFrames();

  const takeShot = async () => {
    if (!shot) return;
    const cap = await S('Page.captureScreenshot', { format: 'png' });
    if (cap.result && cap.result.data) { fs.writeFileSync(shot, Buffer.from(cap.result.data, 'base64')); console.log('截图已存:', shot); }
  };

  // 真实鼠标点击（按最内层文本匹配）
  if (clickText) {
    const posRaw = await ev(`(()=>{const es=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim().includes(${JSON.stringify(clickText)}));if(!es.length)return '';const e=es[0];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
    if (posRaw) {
      const { x, y } = JSON.parse(posRaw);
      for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await S('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
      console.log('已点击:', clickText, `(${x},${y})`);
      await sleep(6000);
    } else console.log('未找到可点击元素:', clickText);
  }

  if (wantFrames || !jsExpr) {
    const curl = await ev('location.href');
    console.log('页面:', String(curl).slice(0, 160));
    console.log('frames:', frames.length);
    frames.forEach((f, i) => console.log(`  [${i}] d${f.d} ${f.url}`));
  }

  if (jsExpr) {
    let ctxId = null;
    if (frameMatch) {
      let tgt = frames.find((f) => f.d > 0 && f.url.includes(frameMatch));
      if (!tgt) { await sleep(5000); frames = await collectFrames(); tgt = frames.find((f) => f.d > 0 && f.url.includes(frameMatch)); }
      if (tgt) {
        const w = await S('Page.createIsolatedWorld', { frameId: tgt.id, worldName: 'wb_bg', grantUniveralAccess: true });
        ctxId = w.result && w.result.executionContextId;
        console.log('frame:', tgt.url);
      } else { console.log('未匹配到 frame，改用主世界'); }
    }
    const v = await ev(jsExpr, ctxId);
    if (v && v.__err) console.log('JS 异常:', v.__err);
    else console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  }
  await takeShot();
} catch (e) {
  console.log('ERR:', e.message);
} finally {
  if (targetId && !keep) await send('Target.closeTarget', { targetId });
  ws.close();
}
