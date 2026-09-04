import fs from 'node:fs';
const [port, tokenFile, cwd, prompt, model] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
let id = 0; const pending = new Map(); let text = ''; const kinds = new Set();
const call = (method, params) => new Promise((res, rej) => { const rid = ++id; pending.set(rid, {res, rej}); ws.send(JSON.stringify({jsonrpc:'2.0', id: rid, method, params})); setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); rej(new Error('timeout '+method)); } }, 90000); });
let done = false;
ws.onmessage = (m) => { for (const line of String(m.data).split('\n')) { if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.id !== undefined && pending.has(o.id)) {
    const p = pending.get(o.id); pending.delete(o.id);
    if (o.error) p.rej(new Error(JSON.stringify(o.error))); else p.res(o.result);
    continue;
  }
  if (o.method === 'event') { const p = o.params || {}; const ev = p.event || p.type || ''; kinds.add(ev);
    if (ev === 'token' || ev === 'message.delta' || ev === 'text.delta') text += (p.text ?? p.delta ?? p.content ?? '');
    if (ev === 'message.complete') { if (p.text || p.content) text = p.text || p.content; done = true; }
  } } };
ws.onerror = (e) => console.error('WS ERROR', e.message || e);
ws.onopen = async () => {
  try {
    const created = await call('session.create', { cwd, title: "knowl plugin test", source: "desktop", ...(model ? { model, provider: "openrouter" } : {}) });
    const sid = created.session_id; console.log('session:', sid, 'stored:', created.stored_session_id, 'cwd:', created.info?.cwd);
    await call('prompt.submit', { session_id: sid, text: prompt });
    for (let i = 0; i < 90 && !done; i++) await new Promise(r => setTimeout(r, 1000));
    console.log('events:', [...kinds].join(', '));
    console.log('ASSISTANT TEXT >>>', (text || '(no text captured)').slice(0, 600));
  } catch (e) { console.error('DRIVER ERROR', e.message); }
  ws.close(); setTimeout(() => process.exit(0), 300);
};
