// Wingman: a private personal dating wingman. All data stays on this device (localStorage).
const KEY = 'wingman-data-v1';
const blank = { settings: { apiKey: '', model: 'gemini-2.5-flash' }, voice: { about: '', examples: '', values: '' }, people: [], training: [] };
let db = load();
let tab = 'chat';

function load() { try { return Object.assign({}, blank, JSON.parse(localStorage.getItem(KEY)) || {}); } catch { return structuredClone(blank); } }
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
function $(s, el = document) { return el.querySelector(s); }
function esc(s = '') { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1800); }
function uid() { return Math.random().toString(36).slice(2, 10); }

// ---------- AI ----------
const RULES = `You are a personal dating wingman for one man. Help him meet, talk to and attract a woman for a serious, loyal relationship.
Rules: honest only, never manipulation, pickup tactics or lies. Replies must sound like HIM: short, natural texting, calm, warm, a little playful.
No cheesy lines, no over-flattery, emojis only if she uses them. Match her length and energy; ask about her; never make him over-text.
He trusts people easily, so flag real red flags plainly: love-bombing, money requests, flaking, lies, inconsistency, pushing off-platform fast, avoiding video calls.
Never invent facts about him. If a reply needs a fact you do not have, say so in "need".`;

function context(person) {
  const liked = db.training.filter(t => t.rating === 'up' || t.better).slice(-15)
    .map(t => `- ${t.better ? 'He would actually say' : 'He liked'}: "${t.better || t.text}"`).join('\n');
  const disliked = db.training.filter(t => t.rating === 'down' && !t.better).slice(-8).map(t => `- Avoid replies like: "${t.text}"`).join('\n');
  let c = `ABOUT HIM:\n${db.voice.about || '(not filled in)'}\n\nHIS VALUES AND DEAL-BREAKERS:\n${db.voice.values || '(not filled in)'}\n\nHOW HE TEXTS (examples):\n${db.voice.examples || '(none yet)'}\n`;
  if (liked) c += `\nLEARNED FROM HIS FEEDBACK (copy this style):\n${liked}\n`;
  if (disliked) c += `\n${disliked}\n`;
  if (person) c += `\nABOUT HER (${person.name}):\nMet: ${person.met || '?'}\nLikes: ${person.likes || '?'}\nNotes: ${person.notes || ''}\nRed flags noted: ${person.flags || 'none'}\nNext step: ${person.next || ''}\n`;
  return c;
}

async function ask(task, person) {
  const { apiKey, model } = db.settings;
  if (!apiKey) { toast('Add your Gemini key in Settings first'); throw new Error('no key'); }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [{ text: context(person) + '\n\nTASK:\n' + task }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.9 }
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { toast((j.error && j.error.message) || 'AI error'); throw new Error('ai'); }
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
  try { return JSON.parse(txt); } catch { return { replies: [txt] }; }
}

function busy(btn, on, label) { btn.disabled = on; btn.innerHTML = on ? '<span class="spin"></span>Thinking…' : label; }

// ---------- Views ----------
const views = {
  chat() {
    const opts = db.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    return `<h2>Chat helper</h2>
    <div class="card">
      <label>Who are you talking to?</label>
      <select id="who"><option value="">Someone new</option>${opts}</select>
      <label>Paste your latest messages</label>
      <textarea id="convo" placeholder="Her: hey, love your bike videos!&#10;Me: thanks! ..."></textarea>
      <button class="btn" id="go">Get replies</button>
    </div>
    <div id="out"></div>`;
  },
  people() {
    const list = db.people.map(p => `<div class="person"><div><b>${esc(p.name)}</b><span class="muted">${esc(p.met || '')}</span></div><button class="btn small ghost" data-edit="${p.id}">Open</button></div>`).join('') || '<p class="muted">No one yet. Add the first person you are talking to.</p>';
    return `<h2>People</h2>${list}<button class="btn" data-edit="new">Add person</button>`;
  },
  person(id) {
    const p = db.people.find(x => x.id === id) || { id: '', name: '', met: '', likes: '', notes: '', flags: '', next: '' };
    const f = (k, l, ta) => `<label>${l}</label>${ta ? `<textarea id="p-${k}">${esc(p[k])}</textarea>` : `<input id="p-${k}" value="${esc(p[k])}">`}`;
    return `<h2>${p.id ? esc(p.name) : 'New person'}</h2><div class="card">
      ${f('name', 'Name')}${f('met', 'Where you met')}${f('likes', 'What she likes', 1)}${f('notes', 'Notes (what she told you, vibe)', 1)}${f('flags', 'Red flags', 1)}${f('next', 'Next step')}
      <button class="btn" id="psave" data-id="${p.id}">Save</button>
      ${p.id ? `<button class="btn ghost" id="pdel" data-id="${p.id}">Delete</button>` : ''}
      <button class="btn ghost" data-tabgo="people">Back</button></div>`;
  },
  ideas() {
    const opts = db.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    return `<h2>Openers and date ideas</h2><div class="card">
      <label>For</label><select id="iwho"><option value="">Someone new</option>${opts}</select>
      <label>Her bio, or describe her posts</label>
      <textarea id="bio" placeholder="Posts gym videos and cooking, loves her dog, from Norfolk..."></textarea>
      <div class="row"><button class="btn" id="openers">3 openers</button><button class="btn ghost" id="dates">Date ideas</button></div>
    </div><div id="iout"></div>`;
  },
  voice() {
    const v = db.voice;
    return `<h2>My voice</h2><p class="muted">This is how the app learns you. The more real examples, the more it sounds like you.</p><div class="card">
      <label>About me</label><textarea id="v-about" placeholder="Calm, funny, honest. I ride a GSX-R, make masked-rider TikToks, cook healthy food, have a python named Nyx...">${esc(v.about)}</textarea>
      <label>Values and deal-breakers</label><textarea id="v-values" placeholder="Looking for something serious and loyal. No drama, liars or flakes...">${esc(v.values)}</textarea>
      <label>10 to 20 real texts I've sent (one per line)</label><textarea id="v-examples" style="min-height:180px">${esc(v.examples)}</textarea>
      <button class="btn" id="vsave">Save</button></div>
      <div class="card"><b>Training so far</b><p class="muted">${db.training.filter(t => t.rating === 'up').length} liked, ${db.training.filter(t => t.rating === 'down').length} disliked, ${db.training.filter(t => t.better).length} corrections.</p></div>`;
  },
  settings() {
    const s = db.settings;
    return `<h2>Settings</h2><div class="card">
      <label>Gemini API key</label><input id="s-key" type="password" value="${esc(s.apiKey)}" placeholder="Paste key from aistudio.google.com">
      <p class="muted">Get a free key at aistudio.google.com → Get API key. It stays on this device only.</p>
      <label>Model</label><input id="s-model" value="${esc(s.model)}">
      <button class="btn" id="ssave">Save</button></div>
      <div class="card"><b>Move to another device</b><p class="muted">Your data lives on this device. Export here, then import on your phone or computer.</p>
      <button class="btn ghost" id="exp">Export my data</button>
      <label>Import</label><input type="file" id="imp" accept="application/json">
      <button class="btn ghost" id="wipe" style="border-color:var(--bad);color:var(--bad)">Erase everything</button></div>`;
  }
};

function render(name, arg) {
  tab = name;
  $('#view').innerHTML = views[name](arg);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === (name === 'person' ? 'people' : name)));
  window.scrollTo(0, 0);
}

function replyCard(text, person) {
  const id = uid();
  return `<div class="reply" data-rid="${id}" data-person="${person ? person.id : ''}"><p>${esc(text)}</p>
    <div class="acts"><button class="chip" data-copy>Copy</button><button class="chip" data-rate="up">👍</button><button class="chip" data-rate="down">👎</button><button class="chip" data-better>What I'd say</button></div></div>`;
}

function showResult(out, res, person) {
  let h = '';
  (res.replies || []).forEach(r => h += replyCard(r, person));
  if (res.interest) h += `<div class="read"><b>Her interest:</b> ${esc(res.interest)}</div>`;
  (res.red_flags || []).forEach(f => h += `<div class="flag">⚠ ${esc(f)}</div>`);
  if (res.need) h += `<div class="read"><b>I need to know:</b> ${esc(res.need)}</div>`;
  (res.ideas || []).forEach(r => h += replyCard(r, person));
  out.innerHTML = h || '<p class="muted">No answer, try again.</p>';
}

// ---------- Events ----------
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.tab) return render(t.dataset.tab);
  if (t.dataset.tabgo) return render(t.dataset.tabgo);
  if (t.dataset.edit) return render('person', t.dataset.edit === 'new' ? '' : t.dataset.edit);

  if (t.id === 'go') {
    const person = db.people.find(p => p.id === $('#who').value);
    const convo = $('#convo').value.trim(); if (!convo) return toast('Paste the chat first');
    busy(t, true);
    try {
      const res = await ask(`Here is our latest conversation:\n${convo}\n\nReturn JSON: {"replies":[two different short reply options he could send next],"interest":"one line on how interested she seems and why","red_flags":[only real ones, else empty],"need":"a fact about him you needed but did not have, else empty string"}`, person);
      showResult($('#out'), res, person);
    } catch {} busy(t, false, 'Get replies');
  }
  if (t.id === 'openers' || t.id === 'dates') {
    const person = db.people.find(p => p.id === $('#iwho').value);
    const bio = $('#bio').value.trim();
    const label = t.textContent; busy(t, true);
    const task = t.id === 'openers'
      ? `Her bio/posts: ${bio || '(see her profile above)'}\nWrite 3 different opening messages tied to something specific about her. Return JSON {"ideas":[3 openers]}`
      : `Her bio/posts: ${bio || '(see her profile above)'}\nSuggest 3 first-date ideas that fit both of us, simple and safe, one line each. Return JSON {"ideas":[3 ideas]}`;
    try { showResult($('#iout'), await ask(task, person), person); } catch {} busy(t, false, label);
  }
  if (t.dataset.copy !== undefined) { const txt = t.closest('.reply').querySelector('p').textContent; navigator.clipboard?.writeText(txt); toast('Copied'); }
  if (t.dataset.rate) {
    const card = t.closest('.reply'); const text = card.querySelector('p').textContent;
    db.training = db.training.filter(x => x.rid !== card.dataset.rid);
    db.training.push({ rid: card.dataset.rid, text, rating: t.dataset.rate, person: card.dataset.person, at: Date.now() }); save();
    card.querySelectorAll('[data-rate]').forEach(b => b.className = 'chip');
    t.classList.add(t.dataset.rate === 'up' ? 'on-good' : 'on-bad'); toast('Learned');
  }
  if (t.dataset.better !== undefined) {
    const card = t.closest('.reply'); const text = card.querySelector('p').textContent;
    const better = prompt('How would you actually say it?', text);
    if (better && better.trim()) { db.training.push({ rid: uid(), text, better: better.trim(), rating: 'down', person: card.dataset.person, at: Date.now() }); save(); toast('Got it, learning your style'); }
  }
  if (t.id === 'psave') {
    const get = k => $('#p-' + k).value.trim();
    if (!get('name')) return toast('Add a name');
    let p = db.people.find(x => x.id === t.dataset.id);
    if (!p) { p = { id: uid() }; db.people.push(p); }
    ['name', 'met', 'likes', 'notes', 'flags', 'next'].forEach(k => p[k] = get(k)); save(); toast('Saved'); render('people');
  }
  if (t.id === 'pdel' && confirm('Delete this person?')) { db.people = db.people.filter(x => x.id !== t.dataset.id); save(); render('people'); }
  if (t.id === 'vsave') { db.voice = { about: $('#v-about').value, values: $('#v-values').value, examples: $('#v-examples').value }; save(); toast('Saved'); }
  if (t.id === 'ssave') { db.settings = { apiKey: $('#s-key').value.trim(), model: $('#s-model').value.trim() || 'gemini-2.5-flash' }; save(); toast('Saved'); }
  if (t.id === 'exp') {
    const copy = structuredClone(db); copy.settings.apiKey = '';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }));
    a.download = 'wingman-backup.json'; a.click();
  }
  if (t.id === 'wipe' && confirm('Erase all your data on this device?')) { localStorage.removeItem(KEY); db = load(); render('settings'); }
});

document.addEventListener('change', e => {
  if (e.target.id !== 'imp' || !e.target.files[0]) return;
  e.target.files[0].text().then(txt => { const d = JSON.parse(txt); d.settings = db.settings; db = Object.assign({}, blank, d); save(); toast('Imported'); render('people'); }).catch(() => toast('Could not read that file'));
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
render(db.settings.apiKey ? 'chat' : 'settings');
