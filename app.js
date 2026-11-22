// Wingman v3: private chat-style dating wingman. Data stays on this device (IndexedDB), with optional encrypted sync through a secret GitHub Gist.
const KEY = 'wingman-data-v2';
const MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];
const OR_DEFAULT = 'deepseek/deepseek-v4.1-flash';
const hasKey = () => (db.settings.provider === 'openrouter' ? db.settings.orKey : db.settings.apiKey);
const TONES = ['Calm and wise', 'Playful and funny', 'Hype man', 'Straight talker', 'Romantic', 'Big brother'];
const blank = () => ({
  settings: { apiKey: '', model: MODELS[0], provider: 'gemini', orKey: '', orModel: OR_DEFAULT },
  me: { about: '', values: '', examples: '' },
  memories: [],
  wingman: { name: 'Wingman', tones: ['Calm and wise', 'Playful and funny'], style: '', language: 'English' },
  people: [], training: [], chats: [], current: null, deleted: [], stamps: {}
});
const LOCK = 'wingman-lock', ENC = 'wingman-data-enc';
let db = blank();
let cryptoKey = null, hiddenAt = 0;
let pendingImg = null;

// ---------- Storage: IndexedDB (much bigger than localStorage), moves old data over ----------
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('wingman', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = (mode, fn) => open().then(d => new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
  return { get: k => tx('readonly', st => st.get(k)), set: (k, v) => tx('readwrite', st => st.put(v, k)), del: k => tx('readwrite', st => st.delete(k)) };
})();
const hasIdb = () => { try { return !!window.indexedDB; } catch { return false; } };
async function getItem(k) {
  if (hasIdb()) {
    try {
      const v = await idb.get(k);
      if (v !== undefined && v !== null) return v;
      const old = localStorage.getItem(k);
      if (old !== null) { await idb.set(k, old); localStorage.removeItem(k); }
      return old;
    } catch {}
  }
  return localStorage.getItem(k);
}
async function setItem(k, v) {
  if (hasIdb()) { try { await idb.set(k, v); localStorage.removeItem(k); return; } catch {} }
  localStorage.setItem(k, v);
}
async function removeItem(k) { localStorage.removeItem(k); if (hasIdb()) { try { await idb.del(k); } catch {} } }
async function wipeAll() { for (const k of [KEY, 'wingman-data-v1', ENC]) await removeItem(k); localStorage.removeItem(LOCK); }
function fixup(d) { const b = blank(); const x = Object.assign(b, d || {}); x.settings = Object.assign(blank().settings, (d && d.settings) || {}); x.stamps = x.stamps || {}; x.deleted = x.deleted || []; return x; }

async function load() {
  try {
    const v2 = JSON.parse(await getItem(KEY));
    if (v2) return fixup(v2);
    const v1 = JSON.parse(await getItem('wingman-data-v1'));
    const d = blank();
    if (v1) { // migrate v1
      d.settings.apiKey = v1.settings?.apiKey || '';
      d.me = { about: v1.voice?.about || '', values: v1.voice?.values || '', examples: v1.voice?.examples || '' };
      d.people = v1.people || []; d.training = v1.training || [];
    }
    return d;
  } catch { return blank(); }
}
let saving = Promise.resolve();
function save(noSync) {
  const snap = JSON.stringify(db), key = cryptoKey;
  saving = saving.then(async () => {
    try {
      if (key) await setItem(ENC, await encrypt(snap, key));
      else await setItem(KEY, snap);
    } catch { toast('Could not save. Phone storage may be full.'); }
  });
  if (!noSync) syncSoon();
  return saving;
}


// ---------- Sync between devices: encrypted file in a secret GitHub Gist ----------
// GitHub only ever sees scrambled data. Text syncs; screenshots stay on the device they were sent from.
const GIST_FILE = 'wingman-sync.json';
let syncTimer = null, syncing = false;
const syncOn = () => !!(db.settings.sync?.token && db.settings.sync?.gistId && cryptoKey);
function syncSoon() { if (!syncOn()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 4000); }
async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, Object.assign({}, opts, { headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${db.settings.sync.token}`, 'Content-Type': 'application/json' } }));
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('GitHub token is wrong or expired');
  if (r.status === 404) throw new Error('Sync code not found (or token lacks gist access)');
  if (!r.ok) throw new Error(j.message || 'GitHub error ' + r.status);
  return j;
}
function syncPayload() {
  const c = structuredClone(db);
  delete c.settings; delete c.current;
  c.chats.forEach(ch => ch.msgs.forEach(m => { if (m.img) m.img = { mime: m.img.mime }; }));
  return c;
}
async function readGist(id) {
  const g = await gh('/gists/' + encodeURIComponent(id));
  const f = g.files?.[GIST_FILE];
  if (!f) throw new Error('That sync code is not a Wingman sync file');
  if (!f.truncated) return JSON.parse(f.content);
  const r = await fetch(f.raw_url); return JSON.parse(await r.text());
}
const newer = (a, b) => ((b.at || 0) > (a.at || 0) ? b : a);
function mergeList(a = [], b = [], idOf, pick) {
  const m = new Map(a.map(x => [idOf(x), x]));
  b.forEach(x => { const k = idOf(x); m.set(k, m.has(k) ? pick(m.get(k), x) : x); });
  return [...m.values()];
}
function mergeInto(r) {
  const dead = new Set([...(db.deleted || []), ...(r.deleted || [])]);
  db.deleted = [...dead].slice(-500);
  const alive = x => !dead.has(x.id);
  db.chats = mergeList(db.chats, r.chats, x => x.id, (a, b) => {
    const w = newer(a, b); if (w === a) return a;
    // keep screenshots we still have on this device
    b.msgs.forEach((m, i) => { const l = a.msgs[i]; if (m.img && l?.img?.data && l.text === m.text) m.img = l.img; });
    return b;
  }).filter(alive).sort((x, y) => (y.at || 0) - (x.at || 0));
  db.people = mergeList(db.people, r.people, x => x.id, newer).filter(alive);
  db.memories = mergeList(db.memories, r.memories, x => x.id, a => a).filter(alive);
  db.training = mergeList(db.training, r.training, x => x.mid, newer);
  const st = db.stamps || {}, rs = r.stamps || {};
  if ((rs.me || 0) > (st.me || 0)) { db.me = r.me; st.me = rs.me; }
  if ((rs.wingman || 0) > (st.wingman || 0)) { db.wingman = r.wingman; st.wingman = rs.wingman; }
  db.stamps = st;
  if (!db.chats.some(c => c.id === db.current)) db.current = db.chats[0]?.id || null;
}
async function pushGist() {
  const { salt } = JSON.parse(localStorage.getItem(LOCK));
  const blob = JSON.parse(await encrypt(JSON.stringify(syncPayload())));
  const content = JSON.stringify({ app: 'wingman', v: 1, salt, iv: blob.iv, ct: blob.ct });
  await gh('/gists/' + encodeURIComponent(db.settings.sync.gistId), { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content } } }) });
}
async function syncNow(quiet = true) {
  if (!syncOn() || syncing) return;
  syncing = true;
  try {
    const remote = await readGist(db.settings.sync.gistId);
    if (remote.ct) {
      let data;
      try { data = JSON.parse(await decrypt(cryptoKey, JSON.stringify({ iv: remote.iv, ct: remote.ct }))); }
      catch { throw new Error('Sync password differs on another device. Connect again in Settings.'); }
      mergeInto(data);
    }
    await pushGist();
    db.settings.sync.at = Date.now();
    await save(true);
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (!typing && !document.body.classList.contains('locked')) {
      if ($('#synccard')) render('settings');
      else if ($('#view').classList.contains('chatmode') && !$('#typing') && !$('#input')?.value && !pendingImg) render('chat');
    }
    if (!quiet) toast('Synced');
  } catch (e) { if (!quiet || navigator.onLine) toast('Sync: ' + e.message); }
  syncing = false;
}
async function startSync(token) {
  if (!cryptoKey) throw new Error('Turn on the password first');
  db.settings.sync = { token, gistId: '' };
  const { salt } = JSON.parse(localStorage.getItem(LOCK));
  const blob = JSON.parse(await encrypt(JSON.stringify(syncPayload())));
  const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Wingman sync (encrypted)', public: false, files: { [GIST_FILE]: { content: JSON.stringify({ app: 'wingman', v: 1, salt, iv: blob.iv, ct: blob.ct }) } } }) });
  db.settings.sync = { token, gistId: g.id, at: Date.now() };
  await save(true);
}
async function connectSync(token, code, pw) {
  db.settings.sync = { token, gistId: code };
  let remote;
  try { remote = await readGist(code); } catch (e) { db.settings.sync = {}; throw e; }
  if (!remote.salt) { db.settings.sync = {}; throw new Error('That sync code is not a Wingman sync file'); }
  const key = await deriveKey(pw, unb64(remote.salt));
  let data;
  try { data = JSON.parse(await decrypt(key, JSON.stringify({ iv: remote.iv, ct: remote.ct }))); }
  catch { db.settings.sync = {}; throw new Error("Wrong password: use the same Wingman password as your other device"); }
  // this device now uses the same password as the other one
  await saving;
  cryptoKey = key;
  localStorage.setItem(LOCK, JSON.stringify({ salt: remote.salt }));
  mergeInto(data);
  db.settings.sync = { token, gistId: code, at: Date.now() };
  await save(true);
  await removeItem(KEY); await removeItem('wingman-data-v1');
  await pushGist();
}

// ---------- Screenshots: shrink before saving/sending ----------
function shrinkImage(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const max = 1400, k = Math.min(1, max / Math.max(im.width, im.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      res({ mime: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.8).split(',')[1] });
    };
    im.onerror = () => { URL.revokeObjectURL(url); const r = new FileReader(); r.onload = () => res({ mime: file.type || 'image/jpeg', data: String(r.result).split(',')[1] }); r.readAsDataURL(file); };
    im.src = url;
  });
}

// ---------- Password lock (AES-GCM, key from password via PBKDF2) ----------
const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(text, key = cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ iv: b64(iv), ct: b64(ct) });
}
async function decrypt(key, blob) {
  const { iv, ct } = JSON.parse(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return new TextDecoder().decode(pt);
}
async function setPassword(pw) {
  pw = pw.trim();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  cryptoKey = await deriveKey(pw, salt);
  await saving;
  await setItem(ENC, await encrypt(JSON.stringify(db)));
  localStorage.setItem(LOCK, JSON.stringify({ salt: b64(salt) }));
  // verify the password really opens the saved data before removing the plain copy
  const check = await deriveKey(pw, unb64(JSON.parse(localStorage.getItem(LOCK)).salt));
  JSON.parse(await decrypt(check, await getItem(ENC)));
  await removeItem(KEY); await removeItem('wingman-data-v1');
  if (db.settings.sync?.gistId) { db.settings.sync.gistId = ''; await save(true); toast('Password changed: turn sync on again'); }
}
async function removePassword() { await saving; cryptoKey = null; localStorage.removeItem(LOCK); await removeItem(ENC); await setItem(KEY, JSON.stringify(db)); }
function showLock() {
  db = blank(); cryptoKey = null;
  document.body.classList.add('locked');
  $('#lock').style.display = 'flex'; $('#lockpw').value = ''; setTimeout(() => $('#lockpw').focus(), 100);
}
async function unlock() {
  const pw = $('#lockpw').value.trim(); if (!pw) return;
  $('#unlockbtn').textContent = 'Unlocking…';
  try {
    const { salt } = JSON.parse(localStorage.getItem(LOCK));
    const key = await deriveKey(pw, unb64(salt));
    let data;
    const stored = await getItem(ENC);
    try { data = JSON.parse(await decrypt(key, stored)); }
    catch (err) {
      // fallback: older build didn't trim spaces
      const raw = $('#lockpw').value;
      if (raw === pw) throw err;
      const k2 = await deriveKey(raw, unb64(salt));
      data = JSON.parse(await decrypt(k2, stored));
    }
    cryptoKey = key; db = fixup(data);
    $('#lock').style.display = 'none'; document.body.classList.remove('locked');
    hiddenAt = 0;
    render(hasKey() ? 'chat' : 'settings');
    syncNow();
  } catch (err) {
    if (!window.crypto?.subtle) toast('This browser blocks encryption. Open Wingman in Chrome.');
    else toast('Wrong password. Tap the eye to check what you typed.');
  }
  $('#unlockbtn').textContent = 'Unlock';
}
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2000); }
function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>'); }
function chat() { let c = db.chats.find(x => x.id === db.current); if (!c) { c = { id: uid(), title: 'New chat', msgs: [], at: Date.now() }; db.chats.unshift(c); db.current = c.id; } return c; }

// ---------- AI ----------
function systemPrompt() {
  const w = db.wingman, m = db.me;
  const liked = db.training.filter(t => t.better || t.rating === 'up').slice(-15).map(t => `- ${t.better ? 'He would actually say' : 'He liked'}: "${t.better || t.text}"`).join('\n');
  const disliked = db.training.filter(t => t.rating === 'down' && !t.better).slice(-8).map(t => `- Avoid answers like: "${t.text.slice(0, 200)}"`).join('\n');
  const people = db.people.map(p => `- ${p.name}: met ${p.met || '?'}; likes ${p.likes || '?'}; notes ${p.notes || ''}; red flags ${p.flags || 'none'}; next ${p.next || ''}`).join('\n');
  return `You are ${w.name}, a personal dating wingman and close friend to one man. You chat with him like a real friend in a messaging app.
Your personality: ${w.tones.join(', ') || 'calm'}. ${w.style}
Reply in ${w.language || 'English'} unless he writes in another language.

What you help with: meeting women, what to text, reading her interest, openers, date ideas, his profile and TikTok presence, confidence, and any life question he brings.
Rules: honest only, never manipulation, pickup tactics or lies. He wants a serious, loyal relationship.
When you draft a text for him to send, make it sound like HIM (see his examples): short, natural, no cheesy lines, emojis only if she uses them. Give 2 options when drafting.
He trusts people easily, so flag real red flags plainly: love-bombing, money requests, flaking, lies, inconsistency, pushing off-platform fast, avoiding video calls.
Keep chat replies short like texting (under 120 words) unless he asks for more. Never invent facts about him; ask instead.
If he sends a screenshot of a conversation, read it and help him reply.

IMAGES: if he asks you to make, draw or create a picture/image/photo, set "image_prompt" to a detailed English description for an image generator, and say something short in "reply". Otherwise leave image_prompt empty.
VIDEOS: you cannot make videos yet; offer an image or a TikTok video idea/script instead.
MEMORY: if he tells you a new lasting fact about himself or someone he's talking to, put a short third-person line in "remember" (e.g. "Loves sushi"). Don't repeat facts already known.

ABOUT HIM:
${m.about || '(not filled in yet: ask him about himself when natural)'}
HIS VALUES AND DEAL-BREAKERS:
${m.values || '(unknown)'}
THINGS YOU'VE LEARNED ABOUT HIM:
${db.memories.map(x => '- ' + x.text).join('\n') || '(none yet)'}
HOW HE TEXTS (examples):
${m.examples || '(none yet)'}
${liked ? 'HIS FEEDBACK, copy this style:\n' + liked : ''}
${disliked}
WOMEN HE'S TALKING TO:
${people || '(none saved)'}`;
}

async function callGemini(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(db.settings.apiKey)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

async function thinkOpenRouter(c) {
  const messages = [{ role: 'system', content: systemPrompt() + '\n\nAnswer ONLY with a JSON object: {"reply": string, "image_prompt": string (empty if no image needed), "remember": [short facts about George worth saving]}.' }];
  c.msgs.slice(-24).forEach(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (m.img?.data && m.role === 'user') messages.push({ role, content: [{ type: 'text', text: m.text || '(image)' }, { type: 'image_url', image_url: { url: `data:${m.img.mime};base64,${m.img.data}` } }] });
    else messages.push({ role, content: m.text || '(image)' });
  });
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${db.settings.orKey}`, 'X-Title': 'Wingman' },
    body: JSON.stringify({ model: db.settings.orModel || OR_DEFAULT, messages, temperature: 0.9, response_format: { type: 'json_object' } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 402) throw new Error('OpenRouter needs credit on your account (openrouter.ai → Credits)');
    throw new Error(j.error?.message || 'Could not reach OpenRouter');
  }
  let txt = j.choices?.[0]?.message?.content || '';
  txt = txt.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(txt); } catch { return { reply: txt || 'Hmm, I got nothing. Try again?' }; }
}

async function think(c) {
  if (db.settings.provider === 'openrouter') return thinkOpenRouter(c);
  const contents = c.msgs.slice(-24).map(m => {
    const parts = [{ text: m.text || '(image)' }];
    if (m.img?.data && m.role === 'user') parts.unshift({ inline_data: { mime_type: m.img.mime, data: m.img.data } });
    return { role: m.role === 'user' ? 'user' : 'model', parts };
  });
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] }, contents,
    generationConfig: {
      temperature: 0.9, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { reply: { type: 'STRING' }, image_prompt: { type: 'STRING' }, remember: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['reply'] }
    }
  };
  const tryList = [db.settings.model, ...MODELS.filter(m => m !== db.settings.model)];
  let last;
  for (const model of tryList) {
    last = await callGemini(model, body);
    if (last.ok) {
      if (model !== db.settings.model) { db.settings.model = model; save(); }
      const txt = last.j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      try { return JSON.parse(txt); } catch { return { reply: txt || 'Hmm, I got nothing. Try again?' }; }
    }
    if (![404, 400, 429].includes(last.status) || /API key/i.test(last.j.error?.message || '')) break;
  }
  throw new Error(last?.j?.error?.message || 'Could not reach the AI');
}

// ---------- Views ----------
const views = {
  chat() {
    $('#view').className = 'chatmode';
    const c = chat();
    const msgs = c.msgs.map((m, i) => msgHtml(m, i)).join('');
    const empty = `<div class="empty"><div class="big">Hey, I'm ${esc(db.wingman.name)}.</div>Ask me anything about her, what to text, or send a screenshot of your chat.
      <div class="sugg">
        <button data-s="She replied 'haha yeah' and nothing else. What do I send?">She replied "haha yeah". What now?</button>
        <button data-s="Give me 3 openers for a girl who posts gym and cooking videos">Openers for a girl into gym and cooking</button>
        <button data-s="Make an image of my blue and white GSX-R on the beach at night">Make an image of my bike at night</button>
        <button data-s="Ask me questions so you can get to know me better">Get to know me</button>
      </div></div>`;
    return `<div id="msgs">${msgs || empty}</div>
      <div class="preview" id="preview"></div>
      <div class="composer">
        <button class="attach" id="attach" aria-label="Add screenshot">📎</button>
        <input type="file" id="file" accept="image/*" hidden>
        <textarea id="input" rows="1" placeholder="Message ${esc(db.wingman.name)}…"></textarea>
        <button class="send" id="send" aria-label="Send">➤</button>
      </div>`;
  },
  me() {
    const mems = db.memories.map(x => `<div class="item"><span>${esc(x.text)}</span><button class="x" data-delmem="${x.id}">✕</button></div>`).join('') || '<p class="muted">Nothing yet. Tell your wingman about yourself in chat and it saves what matters here.</p>';
    return `<h2>About me</h2><p class="muted">Everything your wingman knows about you. The more here, the better it gets you.</p>
    <div class="card"><label>Who I am</label><textarea id="m-about" style="min-height:200px" placeholder="Name, where I'm from, what I do, hobbies, my bike, my pets, my goals...">${esc(db.me.about)}</textarea>
    <label>What I want in a partner, and deal-breakers</label><textarea id="m-values">${esc(db.me.values)}</textarea>
    <label>Real texts I've sent (one per line) so replies sound like me</label><textarea id="m-examples" style="min-height:160px">${esc(db.me.examples)}</textarea>
    <button class="btn" id="msave">Save</button></div>
    <h2>Learned from our chats</h2>${mems}
    <div class="card"><label>Add something</label><input id="newmem" placeholder="e.g. I'm 6'2&quot;"><button class="btn ghost" id="addmem">Add</button></div>`;
  },
  wingman() {
    const w = db.wingman;
    const tones = TONES.map(t => `<button class="chip ${w.tones.includes(t) ? 'sel' : ''}" data-tone="${t}">${t}</button>`).join('');
    return `<h2>How your wingman sounds</h2><p class="muted">Saved on this device and used in every chat.</p>
    <div class="card"><label>Name</label><input id="w-name" value="${esc(w.name)}">
    <label>Personality (pick any)</label><div class="chips">${tones}</div>
    <label>Anything else about how it should talk</label><textarea id="w-style" placeholder="e.g. Keep it real with me, use a bit of slang, call me bro, mix in some Portuguese...">${esc(w.style)}</textarea>
    <label>Language</label><input id="w-lang" value="${esc(w.language)}">
    <button class="btn" id="wsave">Save</button></div>
    <div class="card"><b>Training</b><p class="muted">${db.training.filter(t => t.rating === 'up').length} liked, ${db.training.filter(t => t.rating === 'down' && !t.better).length} disliked, ${db.training.filter(t => t.better).length} corrections. Use 👍 👎 and "Say it like me" under any reply.</p></div>`;
  },
  people() {
    const list = db.people.map(p => `<div class="item"><div><b>${esc(p.name)}</b><span class="muted">${esc(p.met || '')}</span></div><button class="btn small ghost" data-edit="${p.id}">Open</button></div>`).join('') || '<p class="muted">Add the women you\'re talking to so your wingman remembers them.</p>';
    return `<h2>People</h2>${list}<button class="btn" data-edit="new">Add person</button>`;
  },
  person(id) {
    const p = db.people.find(x => x.id === id) || { id: '', name: '', met: '', likes: '', notes: '', flags: '', next: '' };
    const f = (k, l, ta) => `<label>${l}</label>${ta ? `<textarea id="p-${k}">${esc(p[k])}</textarea>` : `<input id="p-${k}" value="${esc(p[k])}">`}`;
    return `<h2>${p.id ? esc(p.name) : 'New person'}</h2><div class="card">
      ${f('name', 'Name')}${f('met', 'Where you met')}${f('likes', 'What she likes', 1)}${f('notes', 'Notes', 1)}${f('flags', 'Red flags', 1)}${f('next', 'Next step')}
      <button class="btn" id="psave" data-id="${p.id}">Save</button>
      ${p.id ? `<button class="btn ghost" id="pdel" data-id="${p.id}">Delete</button>` : ''}
      <button class="btn ghost" data-tab="people">Back</button></div>`;
  },
  settings() {
    const s = db.settings;
    return `<h2>Settings</h2><div class="card">
      <label>AI provider</label><select id="s-prov"><option value="gemini" ${s.provider !== 'openrouter' ? 'selected' : ''}>Google Gemini (free)</option><option value="openrouter" ${s.provider === 'openrouter' ? 'selected' : ''}>OpenRouter (DeepSeek and others)</option></select>
      <p class="muted">Gemini's free tier may use chats to improve Google's products. OpenRouter needs a little credit for DeepSeek.</p>
      <label>Gemini API key</label><input id="s-key" type="password" value="${esc(s.apiKey)}" placeholder="Paste key from aistudio.google.com">
      <p class="muted">Free at aistudio.google.com → Get API key. Stays on this device only.</p>
      <label>Model</label><select id="s-model">${MODELS.map(m => `<option ${m === s.model ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <p class="muted">If one model doesn't work, the app tries the others automatically.</p>
      <label>OpenRouter API key</label><input id="s-orkey" type="password" value="${esc(s.orKey || '')}" placeholder="Paste key from openrouter.ai/keys">
      <label>OpenRouter model</label><input id="s-ormodel" value="${esc(s.orModel || OR_DEFAULT)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="muted">Default is DeepSeek V4.1 Flash, which reads screenshots too.</p>
      <button class="btn" id="ssave">Save</button></div>
      <div class="card"><b>Password lock</b>
      <p class="muted">${localStorage.getItem(LOCK) ? 'On. Your data is encrypted and the app asks for your password every time it opens, or after 5 minutes away.' : 'Off. Set a password so only you can open Wingman. Your data gets encrypted with it.'}</p>
      <label>${localStorage.getItem(LOCK) ? 'New password' : 'Password'}</label><input id="pw1" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
      <label>Type it again</label><input id="pw2" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
      <label class="muted" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="showpw" style="width:auto"> Show password</label>
      <p class="muted">There's no reset. If you forget it, the only way back in is to erase everything.</p>
      <button class="btn" id="setpw">${localStorage.getItem(LOCK) ? 'Change password' : 'Turn on password'}</button>
      ${localStorage.getItem(LOCK) ? '<button class="btn ghost" id="lockno">Lock now</button><button class="btn ghost" id="rmpw">Turn off password</button>' : ''}</div>
      <div class="card" id="synccard"><b>Sync between phone and computer</b>
      ${db.settings.sync?.gistId && cryptoKey ? `<p class="muted">On. Last synced ${db.settings.sync.at ? new Date(db.settings.sync.at).toLocaleString() : 'not yet'}. Screenshots stay on the device you sent them from.</p>
        <label>Your sync code (paste it on your other device)</label><input id="synccode" readonly value="${esc(db.settings.sync.gistId)}">
        <button class="btn ghost" id="copycode">Copy sync code</button><button class="btn" id="syncnow">Sync now</button><button class="btn ghost" id="syncoff">Turn off sync</button>`
      : `<p class="muted">Keeps your chats, About me, Wingman and People the same everywhere. It's saved in a secret file on your GitHub, scrambled with your Wingman password, so nobody else can read it.</p>
        <label>GitHub token</label><input id="ghtoken" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="ghp_..." value="${esc(db.settings.sync?.token || '')}">
        <p class="muted"><a href="https://github.com/settings/tokens/new?scopes=gist&description=Wingman%20sync" target="_blank" rel="noopener">Make a token here</a>: set Expiration to No expiration, keep only "gist" ticked, tap Generate token, copy it.</p>
        ${localStorage.getItem(LOCK) ? '<p class="muted"><b>First device:</b></p><button class="btn" id="syncstart">Turn on sync</button>' : '<p class="muted"><b>First device:</b> turn on the password above first.</p>'}
        <p class="muted"><b>Other device:</b> paste the sync code from your first device and your Wingman password.</p>
        <label>Sync code</label><input id="joincode" autocapitalize="off" autocorrect="off" spellcheck="false">
        <label>Wingman password (same as other device)</label><input id="joinpw" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
        <button class="btn ghost" id="syncjoin">Connect this device</button>`}
      </div>
      <div class="card"><b>Move to another device</b><p class="muted">Export here, then import on your phone or computer.</p>
      <button class="btn ghost" id="exp">Export my data</button>
      <label>Import</label><input type="file" id="imp" accept="application/json">
      <button class="btn ghost" id="wipe" style="border-color:var(--bad);color:var(--bad)">Erase everything</button></div>`;
  }
};

function msgHtml(m, i) {
  if (m.role === 'user') return `<div class="msg me"><div class="bubble">${m.imgUrl ? `<img class="att" src="${m.imgUrl}">` : m.img ? '<i class="muted">📷 screenshot</i><br>' : ''}${md(m.text)}</div></div>`;
  const img = m.image ? `<img class="gen" src="${esc(m.image)}" alt="generated image" loading="lazy">` : '';
  const mem = m.remembered?.length ? `<div class="memnote">✓ Saved to About me: ${esc(m.remembered.join('; '))}</div>` : '';
  const r = m.rating;
  return `<div class="msg ai" data-i="${i}"><div class="bubble">${md(m.text)}${img}${mem}
    <div class="acts"><button class="chip" data-copy>Copy</button><button class="chip ${r === 'up' ? 'on-good' : ''}" data-rate="up">👍</button><button class="chip ${r === 'down' ? 'on-bad' : ''}" data-rate="down">👎</button><button class="chip" data-better>Say it like me</button>${m.image ? `<a class="chip" href="${esc(m.image)}" target="_blank" download>Save image</a>` : ''}</div></div></div>`;
}

function render(name, arg) {
  $('#view').className = '';
  $('#view').innerHTML = views[name](arg);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === (name === 'person' ? 'people' : name)));
  $('#brandname').textContent = (db.wingman.name || 'Wingman').toUpperCase();
  if (name === 'chat') { scrollDown(); autosize(); } else $('#view').scrollTop = 0;
  $('#menu').style.visibility = $('#newchat').style.visibility = name === 'chat' ? 'visible' : 'hidden';
}
function scrollDown() { const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight; }
function autosize() { const t = $('#input'); if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

async function send(text) {
  if (!hasKey()) { toast('Add your AI key in Settings first'); return render('settings'); }
  text = (text || '').trim();
  if (!text && !pendingImg) return;
  const c = chat();
  const um = { role: 'user', text: text || 'Help me reply to this.' };
  if (pendingImg) { um.img = pendingImg; }
  c.msgs.push(um);
  if (c.title === 'New chat') c.title = (text || 'Screenshot').slice(0, 40);
  c.at = Date.now();
  const shownUrl = pendingImg ? `data:${pendingImg.mime};base64,${pendingImg.data}` : null;
  pendingImg = null;
  render('chat');
  if (shownUrl) { const b = [...document.querySelectorAll('.msg.me .bubble')].pop(); b.innerHTML = `<img class="att" src="${shownUrl}">` + md(um.text); }
  $('#msgs').insertAdjacentHTML('beforeend', '<div class="msg ai" id="typing"><div class="bubble typing"><span></span><span></span><span></span></div></div>');
  scrollDown();
  try {
    const res = await think(c);
    const am = { role: 'model', text: res.reply || '' };
    if (res.image_prompt) am.image = `https://image.pollinations.ai/prompt/${encodeURIComponent(res.image_prompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
    const newMems = (res.remember || []).map(s => s.trim()).filter(s => s && !db.memories.some(x => x.text.toLowerCase() === s.toLowerCase()));
    if (newMems.length) { newMems.forEach(t => db.memories.push({ id: uid(), text: t })); am.remembered = newMems; }
    c.msgs.push(am);
  } catch (e) {
    c.msgs.push({ role: 'model', text: '⚠ ' + e.message });
  }
  // keep storage small: drop screenshot data from older messages
  c.msgs.forEach((m, i) => { if (m.img && i < c.msgs.length - 4) delete m.img.data, m.img = { mime: m.img.mime }; });
  save(); render('chat');
}

function drawer(open) {
  $('#drawer').classList.toggle('open', open);
  if (!open) return;
  $('#chatlist').innerHTML = db.chats.map(c => `<div class="chatrow ${c.id === db.current ? 'cur' : ''}"><span data-open="${c.id}">${esc(c.title)}</span><button class="x" data-delchat="${c.id}">✕</button></div>`).join('') || '<p class="muted">No chats yet.</p>';
}
function newChat() { const c = { id: uid(), title: 'New chat', msgs: [], at: Date.now() }; db.chats.unshift(c); db.current = c.id; save(); drawer(false); render('chat'); }

// ---------- Events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button,span[data-open],a') || e.target;
  if (t.id === 'drawer' ) return drawer(false);
  if (t.dataset.tab) return render(t.dataset.tab);
  if (t.dataset.edit) return render('person', t.dataset.edit === 'new' ? '' : t.dataset.edit);
  if (t.id === 'menu') return drawer(true);
  if (t.id === 'newchat' || t.id === 'newchat2') return newChat();
  if (t.dataset.open) { db.current = t.dataset.open; save(); drawer(false); return render('chat'); }
  if (t.dataset.delchat) { if (confirm('Delete this chat?')) { db.deleted.push(t.dataset.delchat); db.chats = db.chats.filter(c => c.id !== t.dataset.delchat); if (db.current === t.dataset.delchat) db.current = db.chats[0]?.id || null; save(); drawer(true); } return; }
  if (t.dataset.s) return send(t.dataset.s);
  if (t.id === 'send') { const v = $('#input').value; $('#input').value = ''; return send(v); }
  if (t.id === 'attach') return $('#file').click();

  const aiMsg = t.closest && t.closest('.msg.ai');
  if (aiMsg && aiMsg.dataset.i !== undefined) {
    const c = chat(); const m = c.msgs[+aiMsg.dataset.i];
    if (t.dataset.copy !== undefined) { navigator.clipboard?.writeText(m.text); return toast('Copied'); }
    if (t.dataset.rate) {
      m.rating = t.dataset.rate; c.at = Date.now();
      db.training = db.training.filter(x => x.mid !== c.id + aiMsg.dataset.i);
      db.training.push({ mid: c.id + aiMsg.dataset.i, text: m.text, rating: m.rating, at: Date.now() });
      save(); render('chat'); return toast(m.rating === 'up' ? 'Got it, more like this' : 'Got it, less like this');
    }
    if (t.dataset.better !== undefined) {
      const better = prompt('How would you say it?', m.text);
      if (better && better.trim()) { db.training.push({ mid: uid(), text: m.text, better: better.trim(), rating: 'down', at: Date.now() }); save(); toast('Learning your style'); }
      return;
    }
  }
  if (t.dataset.delmem) { db.deleted.push(t.dataset.delmem); db.memories = db.memories.filter(x => x.id !== t.dataset.delmem); save(); return render('me'); }
  if (t.id === 'addmem') { const v = $('#newmem').value.trim(); if (v) { db.memories.push({ id: uid(), text: v }); save(); render('me'); } return; }
  if (t.id === 'msave') { db.me = { about: $('#m-about').value, values: $('#m-values').value, examples: $('#m-examples').value }; db.stamps.me = Date.now(); save(); return toast('Saved'); }
  if (t.dataset.tone) { const w = db.wingman; w.tones = w.tones.includes(t.dataset.tone) ? w.tones.filter(x => x !== t.dataset.tone) : [...w.tones, t.dataset.tone]; t.classList.toggle('sel'); return; }
  if (t.id === 'wsave') { Object.assign(db.wingman, { name: $('#w-name').value.trim() || 'Wingman', style: $('#w-style').value, language: $('#w-lang').value.trim() || 'English' }); db.stamps.wingman = Date.now(); save(); render('wingman'); return toast('Saved. Your wingman sounds like this now'); }
  if (t.id === 'psave') {
    const get = k => $('#p-' + k).value.trim();
    if (!get('name')) return toast('Add a name');
    let p = db.people.find(x => x.id === t.dataset.id); if (!p) { p = { id: uid() }; db.people.push(p); }
    ['name', 'met', 'likes', 'notes', 'flags', 'next'].forEach(k => p[k] = get(k)); p.at = Date.now(); save(); toast('Saved'); return render('people');
  }
  if (t.id === 'pdel' && confirm('Delete this person?')) { db.deleted.push(t.dataset.id); db.people = db.people.filter(x => x.id !== t.dataset.id); save(); return render('people'); }
  if (t.id === 'ssave') { db.settings = { sync: db.settings.sync, apiKey: $('#s-key').value.trim(), model: $('#s-model').value, provider: $('#s-prov').value, orKey: $('#s-orkey').value.trim(), orModel: $('#s-ormodel').value.trim() || OR_DEFAULT }; save(); toast('Saved'); return render('chat'); }
  if (t.id === 'exp') {
    const copy = structuredClone(db); copy.settings.apiKey = ''; copy.settings.orKey = ''; copy.settings.sync = {};
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }));
    a.download = 'wingman-backup.json'; a.click(); return;
  }
  if (t.id === 'wipe' && confirm('Erase all your data on this device?')) { cryptoKey = null; db = blank(); wipeAll().then(() => render('settings')); return; }
  if (t.id === 'syncstart') {
    const tok = $('#ghtoken').value.trim(); if (!tok) return toast('Paste your GitHub token first');
    t.textContent = 'Turning on…';
    startSync(tok).then(() => { toast('Sync is on'); render('settings'); }).catch(err => { toast('Sync: ' + err.message); render('settings'); });
    return;
  }
  if (t.id === 'syncjoin') {
    const tok = $('#ghtoken').value.trim(), code = $('#joincode').value.trim(), pw = $('#joinpw').value.trim();
    if (!tok || !code || !pw) return toast('Fill in token, sync code and password');
    t.textContent = 'Connecting…';
    connectSync(tok, code, pw).then(() => { toast('Connected. Your chats are here now'); render('settings'); }).catch(err => { toast(err.message); render('settings'); });
    return;
  }
  if (t.id === 'syncnow') { t.textContent = 'Syncing…'; return syncNow(false); }
  if (t.id === 'copycode') { navigator.clipboard?.writeText(db.settings.sync.gistId); return toast('Copied'); }
  if (t.id === 'syncoff' && confirm('Turn off sync on this device? Your data stays here.')) { db.settings.sync = {}; save(true); toast('Sync off'); return render('settings'); }
  if (t.id === 'unlockbtn') return unlock();
  if (t.id === 'forgot' && confirm('Erase everything and start over? This cannot be undone.')) { wipeAll().then(() => location.reload()); return; }
  if (t.id === 'setpw') {
    const a = $('#pw1').value.trim(), b = $('#pw2').value.trim();
    if (a.length < 4) return toast('Use at least 4 characters');
    if (a !== b) return toast("Passwords don't match");
    t.textContent = 'Saving…';
    setPassword(a).then(() => { toast('Password is on'); render('settings'); }).catch(err => { toast('Could not set password: ' + err.message); render('settings'); });
    return;
  }
  if (t.id === 'lockno') return showLock();
  if (t.id === 'showpw') { ['pw1', 'pw2'].forEach(i => $('#' + i).type = t.checked ? 'text' : 'password'); return; }
  if (t.id === 'lockeye') { const i = $('#lockpw'); i.type = i.type === 'password' ? 'text' : 'password'; return; }
  if (t.id === 'rmpw' && confirm('Turn off the password? Your data will no longer be encrypted, and sync stops.')) { removePassword().then(() => { toast('Password off'); render('settings'); }); return; }
});

document.addEventListener('keydown', e => { if (e.target.id === 'input' && e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#send').click(); } });
document.addEventListener('input', e => { if (e.target.id === 'input') autosize(); });
document.addEventListener('change', e => {
  if (e.target.id === 'file' && e.target.files[0]) {
    const f = e.target.files[0];
    shrinkImage(f).then(img => { pendingImg = img; $('#preview').textContent = '📷 Screenshot attached. Add a note or just send.'; });
  }
  if (e.target.id === 'imp' && e.target.files[0]) {
    e.target.files[0].text().then(txt => { const d = JSON.parse(txt); d.settings = db.settings; db = fixup(d); save(); toast('Imported'); render('chat'); }).catch(() => toast('Could not read that file'));
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (cryptoKey && hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) showLock();
  else syncNow();
});
document.addEventListener('keydown', e => { if (e.target.id === 'lockpw' && e.key === 'Enter') unlock(); });
if (localStorage.getItem(LOCK)) showLock(); else load().then(d => { db = fixup(d); render(hasKey() ? 'chat' : 'settings'); });
