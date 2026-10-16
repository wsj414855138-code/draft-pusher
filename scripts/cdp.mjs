#!/usr/bin/env node
// cdp.mjs — 极简 CDP 客户端（Node 18+ 原生 WebSocket，零依赖）
//
// 一个「瑞士军刀」：通过 Chrome DevTools Protocol 直接驱动调试 Chrome（默认端口 9223）。
// 相比 GUI 坐标点击的两个关键优势：
//   · 不受锁屏 / 窗口焦点影响（事件直接进渲染进程）
//   · 文件上传可以绕过系统原生文件选择框（DOM.setFileInputFiles）
//
// 用法：
//   node cdp.mjs list                         列所有标签页
//   node cdp.mjs eval "<js>"                  在目标页执行 JS 并打印结果
//   node cdp.mjs url "<url>"                  导航
//   node cdp.mjs shot "<file.png>"            截图
//   node cdp.mjs click <x> <y>                真实鼠标点击（窗口坐标）
//   node cdp.mjs dropfiles <x> <y> <file...>  以拖拽事件投送文件
//   node cdp.mjs upload <x> <y> <file...>     点元素→拦截文件框→塞文件（绕过原生框）
//   node cdp.mjs setfiles <idx> <file...>     直接给第 idx 个 <input type=file> 塞文件
//   node cdp.mjs type "<text>"                Input.insertText 可信文本输入
//   node cdp.mjs focus "<selector>"           滚动到元素并真实点击聚焦
//
// 目标页选择：默认取第一个 page；设 CDP_PAGE_MATCH=<url子串> 可限定（如 "token=123"）。
// 端口：CDP_PORT 环境变量，默认 9223。

const PORT = process.env.CDP_PORT || 9223;
const BASE = `http://127.0.0.1:${PORT}`;

const rpc = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const t = setTimeout(() => reject(new Error(`${method} 超时`)), 60000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        clearTimeout(t);
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
      } else if (m.method) {
        // 事件（如 Page.fileChooserOpened）转给等待者
        (waiters[m.method] || []).forEach((fn) => fn(m.params));
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

const waiters = {};
const waitEvent = (name, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等 ${name} 超时`)), ms);
    (waiters[name] = waiters[name] || []).push((p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`${BASE}/json/list`);
  return r.json();
}

async function pickPage(match) {
  const ts = await targets();
  const pages = ts.filter((t) => t.type === 'page');
  const hit = (match ? pages.find((t) => t.url.includes(match)) : null) || pages[0];
  if (!hit) throw new Error('找不到 page target');
  return hit;
}

async function withPage(fn) {
  const match = process.env.CDP_PAGE_MATCH || '';
  const t = await pickPage(match);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  try {
    await fn(ws, t);
  } finally {
    ws.close();
  }
}

const cmd = process.argv[2];
const arg = process.argv[3];

if (cmd === 'list') {
  const ts = await targets();
  for (const t of ts) {
    console.log(`  ${t.type} | ${(t.title || '').slice(0, 34)} | ${(t.url || '').slice(0, 68)}`);
  }
} else if (cmd === 'eval') {
  await withPage(async (ws) => {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: arg,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      console.log('❌ JS 异常:', r.exceptionDetails.text,
        r.exceptionDetails.exception?.description || '');
      process.exitCode = 1;
    } else {
      const v = r.result?.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
  });
} else if (cmd === 'url') {
  await withPage(async (ws) => {
    await rpc(ws, 'Page.navigate', { url: arg });
    await sleep(2500);
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    });
    console.log('当前 URL:', r.result.value);
  });
} else if (cmd === 'shot') {
  const fs = await import('node:fs');
  const out = arg || '/tmp/cdp.png';
  await withPage(async (ws) => {
    const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log('已保存', out);
  });
} else if (cmd === 'click') {
  const x = Number(process.argv[3]);
  const y = Number(process.argv[4]);
  await withPage(async (ws) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await rpc(ws, 'Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(0.06);
    }
    console.log(`clicked ${x},${y}`);
  });
} else if (cmd === 'dropfiles') {
  // 用 CDP 拖拽事件投送文件（部分上传区只接受 drop，不响应 click 唤起文件框）
  const x = Number(process.argv[3]);
  const y = Number(process.argv[4]);
  const files = process.argv.slice(5);
  const fs = await import('node:fs');
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  await withPage(async (ws) => {
    const items = files.map((f) => ({
      mimeType: MIME[f.slice(f.lastIndexOf('.')).toLowerCase()] || 'image/png',
      data: fs.readFileSync(f).toString('base64'),
      title: f.split('/').pop(),
      baseURL: '',
    }));
    const data = { items, files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver']) {
      await rpc(ws, 'Input.dispatchDragEvent', { type, x, y, data });
      await sleep(0.15);
    }
    await rpc(ws, 'Input.dispatchDragEvent', { type: 'drop', x, y, data });
    console.log(`✅ 已拖入 ${files.length} 个文件 @ (${x},${y})`);
  });
} else if (cmd === 'upload') {
  // 拦截系统文件选择器 → 直接把文件塞进去
  const x = Number(process.argv[3]);
  const y = Number(process.argv[4]);
  const files = process.argv.slice(5);
  await withPage(async (ws) => {
    await rpc(ws, 'Page.enable');                       // 必须先 enable，否则收不到 fileChooserOpened
    await rpc(ws, 'DOM.enable');
    await rpc(ws, 'Page.setInterceptFileChooserDialog', { enabled: true });
    const chooser = waitEvent('Page.fileChooserOpened', 10000);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await rpc(ws, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(0.06);
    }
    const info = await chooser;
    await rpc(ws, 'DOM.setFileInputFiles', {
      files,
      backendNodeId: info.backendNodeId,
    });
    await rpc(ws, 'Page.setInterceptFileChooserDialog', { enabled: false });
    console.log(`✅ 已上传 ${files.length} 个文件（绕过原生文件框）`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${f.split('/').pop()}`));
  });
} else if (cmd === 'setfiles') {
  // 直接给 <input type=file> 塞文件——绕过系统原生文件选择框（GUI 自动化的老大难）
  const idx = Number(process.argv[3]);
  const files = process.argv.slice(4);
  await withPage(async (ws) => {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: `document.querySelectorAll('input[type=file]')[${idx}]`,
      returnByValue: false,
    });
    if (!r.result?.objectId) throw new Error(`找不到 input[type=file][${idx}]`);
    await rpc(ws, 'DOM.setFileInputFiles', { files, objectId: r.result.objectId });
    console.log(`✅ 已把 ${files.length} 个文件塞进 input#${idx}`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${f.split('/').pop()}`));
  });
} else if (cmd === 'type') {
  // Input.insertText 是可信输入，等价于逐字敲进去，React 受控组件能正常接收
  const text = arg ?? process.argv.slice(3).join(' ');
  await withPage(async (ws) => {
    await rpc(ws, 'Input.insertText', { text });
    console.log(`✅ 已输入 ${text.length} 字`);
  });
} else if (cmd === 'focus') {
  // 聚焦某个元素（先滚到中心，再真实点击）
  const sel = arg;
  await withPage(async (ws) => {
    const r = await rpc(ws, 'Runtime.evaluate', {
      expression: `(()=>{const e=${sel}; if(!e) return null; e.scrollIntoView({block:'center'}); e.focus(); const b=e.getBoundingClientRect(); return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`,
      returnByValue: true,
    });
    if (!r.result?.value) { console.log('❌ 元素不存在'); process.exitCode = 1; return; }
    const { x, y } = JSON.parse(r.result.value);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await rpc(ws, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(0.05);
    }
    await sleep(0.2);
    console.log(`✅ 已聚焦 ${sel.slice(0, 60)} @ (${x},${y})`);
  });
} else {
  console.log('用法: node cdp.mjs list|eval <js>|url <url>|shot <file>|click <x> <y>|dropfiles <x> <y> <files...>|upload <x> <y> <files...>|setfiles <idx> <files...>|type <text>|focus <selector>');
}
