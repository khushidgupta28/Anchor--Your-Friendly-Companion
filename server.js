require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
const GNANI_API_KEY = process.env.GNANI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET missing in .env. Add one and restart.');
    process.exit(1);
}
if (!GEMINI_API_KEY) console.error('CRITICAL: Missing GEMINI_API_KEY in .env');
if (!GNANI_API_KEY) console.error('CRITICAL: Missing GNANI_API_KEY in .env');

// ---------------------------------------------------------------
// JSON database
// ---------------------------------------------------------------
const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
    if (!fs.existsSync(DB_FILE)) return { users: [], messages: [] };
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error('DB READ ERROR:', e.message);
        return { users: [], messages: [] };
    }
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DB_FILE)) writeDB({ users: [], messages: [] });

// ---------------------------------------------------------------
// App setup
// ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
const rateLimit = require('express-rate-limit');
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use('/api/signup', rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 };

// ---------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------
function auth(req, res, next) {
    try {
        const token = req.cookies.t;
        if (!token) return res.status(401).json({ error: 'login' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const dbData = readDB();
        const user = dbData.users.find(u => u.id === decoded.id);
        if (!user) return res.status(401).json({ error: 'login' });
        req.user = user;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'login' });
    }
}

// ---------------------------------------------------------------
// Signup: email + password (password is set here)
// ---------------------------------------------------------------
app.post('/api/signup', (req, res) => {
    const email = String(req.body.email || req.body.username || req.body.mail || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim() || (email ? email.split('@')[0] : 'User');

    if (!/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const dbData = readDB();
    if (dbData.users.find(u => u.email === email)) {
        return res.status(409).json({ error: 'That email is already registered.' });
    }

    const newUser = {
        id: Date.now(),
        email,
        hash: bcrypt.hashSync(password, 10),
        name,
        notes: ''
    };
    dbData.users.push(newUser);
    writeDB(dbData);

    const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('t', token, COOKIE_OPTS);
    res.json({ name: newUser.name });
});

// ---------------------------------------------------------------
// Login: only email + password
// ---------------------------------------------------------------
app.post('/api/login', (req, res) => {
    const email = String(req.body.email || req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const dbData = readDB();
    const user = dbData.users.find(u => u.email === email);
    if (!user || !bcrypt.compareSync(password, user.hash)) {
        return res.status(401).json({ error: 'Wrong email or password.' });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('t', token, COOKIE_OPTS);
    res.json({ name: user.name });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('t');
    res.json({ ok: true });
});

// 401 here simply means "not logged in yet" (frontend uses it to show the login screen)
app.get('/api/me', auth, (req, res) => {
    res.json({ name: req.user.name });
});

app.delete('/api/memory', auth, (req, res) => {
    const dbData = readDB();
    const user = dbData.users.find(u => u.id === req.user.id);
    if (user) {
        user.notes = '';
        writeDB(dbData);
    }
    res.json({ ok: true });
});

// ---------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------

// Gemini needs roles "user"/"model", alternating, starting with "user"
function toContents(messages) {
    const out = [];
    for (const m of messages) {
        if (!m || !m.content) continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (out.length && out[out.length - 1].role === role) {
            out[out.length - 1].parts[0].text += '\n' + m.content;
        } else {
            out.push({ role, parts: [{ text: String(m.content) }] });
        }
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let useThinkingCfg = false;

async function callGemini(model, sys, messages, max_tokens, temperature, signal) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: toContents(messages),
            generationConfig: { maxOutputTokens: max_tokens, temperature }
        }),
        signal
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${model}: ${j.error?.message || 'Gemini error'}`);
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error(`${model}: empty reply`);
    return { text, model };
}

async function gemini(systemInstruction, messages, max_tokens = 300, temperature = 0.9) {
    const sys = Array.isArray(systemInstruction)
        ? systemInstruction.filter(Boolean).join('\n\n')
        : String(systemInstruction || '');
    const models = [...new Set([GEMINI_MODEL, FALLBACK_MODEL])];

    for (let round = 1; round <= 2; round++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);   // generous: only gives up on truly stuck requests
        try {
            const winner = await Promise.any(
                models.map(m => callGemini(m, sys, messages, Math.max(max_tokens, 1024), temperature, controller.signal))
            );
            clearTimeout(timer);
            controller.abort();   // cancel the slower request
            console.log(`GEMINI ok: winner=${winner.model}, round=${round}`);
            return winner.text;
        } catch (e) {
            clearTimeout(timer);
            const why = e.errors ? e.errors.map(x => x.message).join(' | ') : e.message;
            console.error(`GEMINI round ${round} failed:`, why);
            await sleep(300);
        }
    }
    throw new Error('Gemini is busy right now');
}
// ---------------------------------------------------------------
// Friend personality + modes
// ---------------------------------------------------------------
const BASE_PROMPT = `You are Anchor, the user's close friend, talking with them by voice.
Talk like a real person: warm, curious, a bit playful, natural and casual. React to the specific things they said.
- Reply in 1 to 3 short spoken sentences. No lists, no markdown, no emojis, because your words are read aloud.
- Answer anything they ask: random questions, advice, jokes, homework, plans. You are a friend, not only a feelings bot.
- Do not use stock therapy lines like "I'm here for you", "that's valid", "it's okay to feel that way", or "I hear you". Never sound like a customer-support script.
- Match their mood. If they're joking, joke back. If they're venting, listen first and don't rush to fix things. Only get gentle and serious if they are really hurting.
- Vary your wording every time. Ask a natural follow-up question only sometimes, not every turn.
- If they mention wanting to hurt themselves or being in danger, slow down, be warm and direct, and encourage them to reach a trusted person or a local helpline right now.
- Reply in the same language style the user speaks. If they speak Hinglish (Hindi mixed with English), reply in natural Hinglish written in Roman script, the way friends text each other`;

// keys must match the values of your mode dropdown in index.html
const MODE_HINTS = {
    friend: '',
    calm: 'The user may be stressed. Keep a steady, slow, grounding tone, but still sound like a friend.',
    blind: 'The user is blind. Be clear and descriptive in words, give step-by-step spoken guidance, and never refer to anything visual on screen.',
    autism: 'The user is autistic. Be literal, clear and predictable. Avoid sarcasm and idioms, and say exactly what you mean.',
    support: 'The user wants emotional support. Be a patient, caring listener who lets them talk, but stay casual and human, never scripted.'
};

const CRISIS_LINE = process.env.CRISIS_LINE || 'a local helpline';

//crisis detection patterns (English, Hindi, Hinglish)
const { isCrisis, isConcerning } = require('./crisis');

const CRISIS_HINT = 'The user may be in real distress or danger. Slow down, be warm, direct and human, ask gently what is going on, and encourage them to reach someone they trust right now. Do not lecture.';
const CRISIS_APPEND = `If you might be in danger, please contact ${CRISIS_LINE}, or your local emergency number.`;
const CRISIS_FALLBACK = `I'm really glad you told me. I want you to be safe right now. Please reach out to someone you trust, or contact ${CRISIS_LINE}. If you're in immediate danger, call your local emergency number. I'm still here with you.`;

// Saves lasting facts about the person (runs in the background, never in incognito)
async function updateNotes(userId, userText, reply) {
    const dbData = readDB();
    const user = dbData.users.find(u => u.id === userId);
    if (!user) return;

    const prompt = `Current notes about the person:\n${user.notes || '(none)'}\n\nLatest exchange:\nThem: ${userText}\nFriend: ${reply}\n\nUpdate the notes. Keep only lasting facts worth remembering (name, people in their life, likes, worries, ongoing situations, goals). Max 8 short lines. Return only the notes.`;
    const notes = await gemini(
        'You maintain brief memory notes for a friend. Output only the notes.',
        [{ role: 'user', content: prompt }],
        400,
        0.2
    );

    const fresh = readDB();
    const u2 = fresh.users.find(u => u.id === userId);
    if (u2) {
        u2.notes = notes;
        writeDB(fresh);
    }
}

// ---------------------------------------------------------------
// Chat endpoint
// ---------------------------------------------------------------
app.post('/api/chat', auth, async (req, res) => {
    const { text, mode = 'friend', incognito = false, history = [] } = req.body;
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'empty text' });

    const crisis = isCrisis(text);
    const concerning = !crisis && isConcerning(text);
    try {
        const system = [
            BASE_PROMPT,
            MODE_HINTS[mode] || '',
            req.user.name ? `The person's name is ${req.user.name}.` : '',
            !incognito && req.user.notes ? `Things you remember about them from past chats:\n${req.user.notes}\nBring these up naturally only when relevant.` : '',
            incognito ? 'This is a private incognito chat. Nothing from it is saved.' : '',
            (crisis || concerning) ? CRISIS_HINT : ''].filter(Boolean).join('\n\n');

        const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
        const t0 = Date.now();
        let reply = await gemini(system, [...safeHistory, { role: 'user', content: String(text) }], 150);
        console.log(`GEMINI took ${Date.now() - t0} ms`);

        if (crisis) reply += ' ' + CRISIS_APPEND;   // the helpline is always included
        res.json({ reply, speed: crisis || mode === 'calm' ? 0.9 : 1.0, crisis: crisis || concerning });

        if (!incognito && !crisis) {
            req.user._n = (global.chatCount = (global.chatCount || 0) + 1);
            if (global.chatCount % 3 === 0) {
                updateNotes(req.user.id, String(text), reply).catch(e => console.error('NOTES ERROR:', e.message));
            }
        }
    } catch (e) {
        console.error('CHAT ROUTE ERROR:', e.message);
        if (crisis) return res.json({ reply: CRISIS_FALLBACK, speed: 0.9, crisis: true });
        res.status(502).json({ error: e.message });
    }
});
// ---------------------------------------------------------------
// Gnani STT
// ---------------------------------------------------------------
app.post('/api/stt', auth, express.raw({ type: 'audio/wav', limit: '10mb' }), async (req, res) => {
    try {
        const formData = new FormData();
        const blob = new Blob([req.body], { type: 'audio/wav' });
        formData.append('audio_file', blob, 'speech.wav');
        formData.append('language_code', process.env.STT_LANG || 'en-IN');

        const r = await fetch('https://api.vachana.ai/stt/v3', {
            method: 'POST',
            headers: { 'X-API-Key-ID': GNANI_API_KEY },
            body: formData
        });
        const j = await r.json();
        console.log('STT RESPONSE:', JSON.stringify(j)); // remove once everything works
        res.json({ text: j.transcript || '' });
    } catch (e) {
        console.error('STT ERROR:', e.message);
        res.status(502).json({ error: 'stt failed' });
    }
});

// ---------------------------------------------------------------
// Gnani TTS
// ---------------------------------------------------------------
app.post('/api/tts', auth, async (req, res) => {
    try {
        const { text, speed = 1.0 } = req.body;
        const r = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key-ID': GNANI_API_KEY
            },
            body: JSON.stringify({
                text,
                voice: process.env.TTS_VOICE || 'Nalini',
                model: process.env.TTS_MODEL || 'timbre-v2.5',
                language: process.env.TTS_LANG || 'en-IN',
                speed,
                audio_config: { sample_rate: 48000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'wav' }
            })
        });

        if (!r.ok) {
            const errText = await r.text();
            console.error('TTS API ERROR:', errText);
            return res.status(502).end();
        }
        res.type('audio/wav').send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
        console.error('TTS ERROR:', e.message);
        res.status(502).end();
    }
});

app.listen(PORT, () => console.log(`Anchor running on http://localhost:${PORT}`));
