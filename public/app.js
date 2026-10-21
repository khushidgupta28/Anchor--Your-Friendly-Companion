const $ = s => document.querySelector(s);
const SPEEDS = { friend: 1, calm: 0.9, support: 0.95, blind: 1, autism: 0.9 };
let mode = 'friend', incognito = false, history = [];
let running = false, state = 'idle', pendingForget = false, userName = '';
let ctx, stream, proc;

// ---------- auth ----------
async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.includes('/login')) { showAuth(); throw new Error('auth'); }
  return r;
}
function showAuth() { stop(); $('#auth').classList.remove('hidden'); $('#talk').classList.add('hidden'); $('#email').focus(); }
function showTalk() {
  $('#auth').classList.add('hidden'); $('#talk').classList.remove('hidden');
  $('#hello').textContent = userName ? `Hi ${userName}. Press the big button once. After that, everything is by voice.` : $('#hello').textContent;
  $('#start').focus();
}
async function authenticate(path) {
  $('#error').textContent = '';
  const body = JSON.stringify({ name: $('#name').value.trim(), email: $('#email').value, password: $('#password').value });
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const j = await r.json();
  if (!r.ok) { $('#error').textContent = j.error || 'Something went wrong.'; return; }
  userName = j.name || ''; showTalk();
}
$('#authForm').addEventListener('submit', e => { e.preventDefault(); authenticate('/api/login'); });
$('#signupBtn').addEventListener('click', () => authenticate('/api/signup'));
$('#logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); showAuth(); });
fetch('/api/me').then(r => r.ok ? r.json() : Promise.reject()).then(j => { userName = j.name || ''; showTalk(); }).catch(() => $('#email').focus());

// ---------- UI ----------
function setState(s, text) { state = s; $('#orb').className = s; if (text) $('#status').textContent = text; }
function renderToggles() {
  $('#incognito').textContent = `Incognito: ${incognito ? 'on' : 'off'}`;
  $('#incognito').setAttribute('aria-pressed', incognito);
  $('#mode').value = mode;
}
$('#mode').addEventListener('change', e => { mode = e.target.value; });
$('#incognito').addEventListener('click', () => { incognito = !incognito; history = []; renderToggles(); });
$('#start').addEventListener('click', start);

// ---------- speaking ----------
async function fetchAudio(text, speed) {
  try {
    const r = await api('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speed: speed || SPEEDS[mode] })
    });
    if (!r.ok) return null;
    return URL.createObjectURL(await r.blob());
  } catch { return null; }
}

async function say(text, speed) {
  setState('speaking', 'Speaking…');
  const parts = (text.match(/[^.!?।]+[.!?।]*\s*/g) || [text]).map(s => s.trim()).filter(Boolean);
  let next = parts.length ? fetchAudio(parts[0], speed) : null;
  for (let i = 0; i < parts.length; i++) {
    const url = await next;
    next = i + 1 < parts.length ? fetchAudio(parts[i + 1], speed) : null; // prefetch just one ahead
    if (!url) continue;
    const audio = new Audio(url);
    await new Promise(res => { audio.onended = res; audio.onerror = res; audio.play().catch(res); });
    URL.revokeObjectURL(url);
  }
}

// ---------- listening (voice activity detection) ----------
let chunks = [], speaking = false, lastVoice = 0, startT = 0;
const THRESHOLD = 0.015, SILENCE_MS = 800, MAX_MS = 50000;

function listen() { chunks = []; speaking = false; if (running) setState('listening', 'Listening…'); }

function onFrame(e) {
  if (state !== 'listening') return;
  const d = e.inputBuffer.getChannelData(0);
  let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const now = performance.now();
  if (Math.sqrt(s / d.length) > THRESHOLD) { if (!speaking) { speaking = true; startT = now; } lastVoice = now; }
  chunks.push(new Float32Array(d));
  if (!speaking) { if (chunks.length > 3) chunks.shift(); return; }   // keep a short pre-roll
  if (now - lastVoice > SILENCE_MS || now - startT > MAX_MS) {
    const c = chunks, dur = lastVoice - startT;
    chunks = []; speaking = false;
    if (dur > 350) handle(c); // ignore tiny noises
  }
}

function toWav(parts, inRate) {
  const n = parts.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
  let o = 0; for (const c of parts) { all.set(c, o); o += c.length; }
  const ratio = inRate / 16000, len = Math.floor(n / ratio), pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j];
    pcm[i] = Math.max(-1, Math.min(1, s / Math.max(1, b - a))) * 32767;
  }
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
  const w = (p, t) => [...t].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * 2, true); new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- one conversational turn ----------
async function handle(parts) {
  setState('thinking', 'Thinking…');
  try {
    const sr = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(parts, ctx.sampleRate) });
    const { text } = await sr.json();
    if (!text || !text.trim()) return listen();
    if (await command(text.trim())) return running ? listen() : null;

    const cr = await api('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode, incognito, history: incognito ? history : [] }),
    });
    const j = await cr.json();
    if (!cr.ok) throw new Error(j.error);
    if (incognito) history.push({ role: 'user', content: text }, { role: 'assistant', content: j.reply });
    await say(j.reply, j.speed);
  } catch (e) {
    if (e.message === 'auth') return;
    await say("Hmm, I'm having trouble on my side. Give me a moment and say that again");
  }
  if (running) listen();
}

// ---------- voice commands ----------
async function command(t) {
  const s = t.toLowerCase();
  if (pendingForget) {
    pendingForget = false;
    if (/\b(yes|yeah|yep|confirm|do it)\b/.test(s)) { await api('/api/memory', { method: 'DELETE' }); await say("Done. I've cleared everything I remembered about our chats."); }
    else await say("Okay, I've kept everything.");
    return true;
  }
  if (/incognito/.test(s)) {
    const off = /(off|stop|exit|leave|disable|turn off)/.test(s);
    incognito = !off; history = []; renderToggles();
    await say(incognito ? "Incognito is on. I won't save or remember anything until you turn it off." : "Incognito is off. I'll remember our chats again.");
    return true;
  }
  const m = s.match(/(friend|calm|support|blind|autis\w*)/);
  if (m && /\bmode\b/.test(s) && /\b(switch|change|use|go|set|put)\b/.test(s)) {
    mode = m[1].startsWith('autis') ? 'autism' : m[1]; renderToggles();
    await say(`Okay, switching to ${mode} mode.`);
    return true;
  }
  if (/(forget|delete|clear|erase).*(everything|memor|all|chats)/.test(s)) {
    pendingForget = true;
    await say("This will erase everything I remember about you. Say yes to confirm, or anything else to cancel.");
    return true;
  }
  if (/^(stop|goodbye|bye|pause|end)\b/.test(s) && s.split(/\s+/).length < 5) {
    await say("Okay. I'm here whenever you want to talk again. Take care.");
    stop(); return true;
  }
  return false;
}

// ---------- start / stop ----------
async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch { $('#status').textContent = 'I need microphone permission to hear you.'; return; }
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = onFrame;
  src.connect(proc); proc.connect(ctx.destination);
  running = true; $('#start').classList.add('hidden');
  const names = { friend: 'friend', calm: 'calm', support: 'support', blind: 'blind and low vision', autism: 'autism-friendly' };
  await say(`Hi${userName ? ' ' + userName : ''}, I'm Anchor. I'm here and I'm listening. We're in ${names[mode]} mode. You can say incognito on, or switch to another mode, any time.`);
  listen();
}

function stop() {
  running = false;
  try { proc && proc.disconnect(); stream && stream.getTracks().forEach(t => t.stop()); ctx && ctx.close(); } catch {}
  setState('idle', 'Ready'); $('#start').classList.remove('hidden');
}
renderToggles();
