'use strict';
// โหลดไฟล์ .env (ในโฟลเดอร์เดียวกับ server.js) เข้า process.env โดยไม่ต้องติดตั้งแพ็กเกจเพิ่ม
// ต้องอยู่ก่อน require('./llm') เพราะ llm.js อ่านค่าตั้งต้นตอนโหลด
(function loadDotEnv() {
  const file = require('path').join(__dirname, '.env');
  let text;
  try { text = require('fs').readFileSync(file, 'utf8'); }
  catch { console.warn(`[env] ไม่พบไฟล์ ${file} (ถ้าตั้งค่าผ่านระบบโฮสติ้งอยู่แล้วให้ข้ามข้อความนี้)`); return; }
  let n = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined && v !== '') { process.env[m[1]] = v; n++; }
  }
  console.log(`[env] อ่าน ${file} สำเร็จ (${n} ค่า)`);
})();
/**
 * Meow Tarot server
 * - บัญชีผู้ใช้แบบ username + password (เก็บใน SQLite, รหัสผ่านถูก hash ด้วย scrypt)
 * - Session ผ่าน HttpOnly cookie
 * - สุ่มไพ่ที่ฝั่งเซิร์ฟเวอร์ ผู้ใช้ที่ล็อกอินดูดวงได้ไม่จำกัดจำนวนครั้ง (ต้องล็อกอินก่อน)
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { generateNarrative, llmEnabled, llmStatus } = require('./llm');

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TZ = process.env.APP_TZ || 'Asia/Bangkok';
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const CARD_COUNT = 78;
const REVERSED_CHANCE = 0.35;
// จำกัดการเรียก LLM เพื่อไม่ให้โควตา free tier หมดเร็ว (เกินแล้วจะใช้คำทำนายแบบเดิมจากฐานข้อมูลแทน)
const LLM_DAILY_CAP = parseInt(process.env.LLM_DAILY_CAP || '300', 10);
const LLM_USER_HOURLY_CAP = parseInt(process.env.LLM_USER_HOURLY_CAP || '10', 10);

const TOPICS = {
  daily:   { title: 'ดูดวงประจำวัน', desc: 'ดวงชะตารายวัน 1 ใบ วันนี้ชีวิตจะปังหรือพัง', cards: 1 },
  love:    { title: 'ดูดวงความรัก',  desc: 'ความรัก ความสัมพันธ์ หัวใจจะนุ่มฟูหรือต้องพักผ่อน', cards: 3 },
  work:    { title: 'ดูดวงการงาน',  desc: 'ทิศทางการทำงาน ภาระหน้าที่ และความสำเร็จ', cards: 3 },
  wealth:  { title: 'ดูดวงการเงิน',  desc: 'โชคลาภ การเงิน หรือเสียเงินกับขนมแมวเลีย', cards: 3 },
  monthly: { title: 'ดูดวงรายเดือน', desc: 'ภาพรวมชีวิตตลอดทั้งเดือน สิ่งที่ต้องรับมือ', cards: 3 },
  custom:  { title: 'หัวข้อตามใจคุณ', desc: 'คำถามตามใจคุณ', cards: 3 }
};

// ---------- Database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'meow-tarot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS readings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    topic_title TEXT NOT NULL,
    topic_desc TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );
`);
// เพิ่มคอลัมน์เก็บคำทำนายจาก LLM (ฐานข้อมูลเก่าจะถูกอัปเกรดอัตโนมัติ)
try { db.exec('ALTER TABLE readings ADD COLUMN narrative_json TEXT'); } catch (_) { /* มีอยู่แล้ว */ }

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, display_name, pass_salt, pass_hash, created_at) VALUES (?,?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)'),
  sessionUser: db.prepare(`SELECT u.id, u.username, u.display_name, s.expires_at
                           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  getReading: db.prepare('SELECT * FROM readings WHERE user_id = ? AND day = ?'),
  insertReading: db.prepare(`INSERT OR REPLACE INTO readings (user_id, day, topic_key, topic_title, topic_desc, cards_json, created_at, narrative_json)
                             VALUES (?,?,?,?,?,?,?,?)`)
};

// ---------- Helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, saltHex, hashHex) {
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// hash หลอกไว้ใช้ตอนไม่พบ username เพื่อให้เวลาตอบใกล้เคียงกัน (กันการเดาชื่อผู้ใช้)
const DUMMY = hashPassword('dummy-password-for-timing');

// วันที่ (YYYY-MM-DD) ตามเขตเวลาที่ตั้งไว้
function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function validateUsername(u) {
  return typeof u === 'string' && /^[\p{L}\p{N}_.-]{3,20}$/u.test(u.trim());
}
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 72;
}

function shuffleDraw(count) {
  const pool = Array.from({ length: CARD_COUNT }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).map((id) => ({ id, reversed: crypto.randomInt(10000) < REVERSED_CHANCE * 10000 }));
}

// Rate limit ง่าย ๆ แบบ in-memory (ต่อ IP) สำหรับ login/register
const attempts = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    const rec = attempts.get(key);
    if (!rec || rec.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return next(); }
    rec.count++;
    if (rec.count > max) {
      res.set('Retry-After', Math.ceil((rec.reset - now) / 1000));
      return res.status(429).json({ error: 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

// ---------- Cookies / Sessions ----------
const COOKIE = 'meow_sid';
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(req, res, token) {
  const secure = IS_PROD || req.secure;
  res.append('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400 * 1000);
  setSessionCookie(req, res, token);
}
function authenticate(req, _res, next) {
  const token = parseCookies(req)[COOKIE];
  req.user = null;
  if (token) {
    const row = q.sessionUser.get(sha256(token));
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, name: row.display_name };
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  next();
}

// ป้องกัน CSRF: คำขอที่เปลี่ยนข้อมูลต้องมาจาก origin เดียวกัน
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) return res.status(403).json({ error: 'คำขอไม่ถูกต้อง' });
  }
  next();
}

function publicUser(u) { return { username: u.username, name: u.name || u.display_name }; }
function readingPayload(row) {
  return {
    topicKey: row.topic_key,
    topicTitle: row.topic_title,
    topicDesc: row.topic_desc,
    cards: JSON.parse(row.cards_json),
    narrative: row.narrative_json ? JSON.parse(row.narrative_json) : null,
    day: row.day
  };
}

// ---------- Tarot data (ใช้สร้าง prompt ให้ LLM) ----------
let TAROT_BY_ID = new Map();
let READING_GUIDES = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'tarot_database.json'), 'utf8'));
  TAROT_BY_ID = new Map(raw.cards.map((c) => [c.id, c]));
  READING_GUIDES = raw.reading_guides || {};
} catch (e) {
  console.warn('โหลด public/tarot_database.json ไม่สำเร็จ จะไม่ใช้ LLM:', e.message);
}
const TOPIC_TO_GUIDE = { love: 'love_reading', work: 'career_reading', wealth: 'finance_reading', monthly: 'monthly_reading' };
const TOPIC_TO_CATEGORY = { daily: 'daily', love: 'love', work: 'career', wealth: 'finance', monthly: 'monthly' };
const DEFAULT_POSITIONS = ['ไพ่อดีต / พื้นฐาน', 'ไพ่ปัจจุบัน / ปัญหา', 'ไพ่อนาคต / ทางออก'];

function positionsFor(topicKey, count) {
  if (count === 1) return ['ไพ่หลักประจำดวงชะตา'];
  const guide = READING_GUIDES[TOPIC_TO_GUIDE[topicKey]];
  if (guide?.spread_positions?.length >= count) {
    return guide.spread_positions.slice(0, count).map((p) => p.replace(/^ใบที่\s*\d+:\s*/, ''));
  }
  return DEFAULT_POSITIONS.slice(0, count);
}

// โควตา LLM: รวมต่อวัน + ต่อผู้ใช้ต่อชั่วโมง (in-memory)
const llmUsage = { day: '', count: 0 };
const llmUserUsage = new Map();
function llmAllowed(userId) {
  const today = dayKey();
  if (llmUsage.day !== today) { llmUsage.day = today; llmUsage.count = 0; }
  if (llmUsage.count >= LLM_DAILY_CAP) return false;
  const now = Date.now();
  const u = llmUserUsage.get(userId);
  if (!u || u.reset < now) llmUserUsage.set(userId, { count: 1, reset: now + 3600 * 1000 });
  else if (u.count >= LLM_USER_HOURLY_CAP) return false;
  else u.count++;
  llmUsage.count++;
  return true;
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // อยู่หลัง reverse proxy / hosting (Render, Railway, nginx ฯลฯ)
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  next();
});
app.use(authenticate);
app.use('/api', sameOrigin);
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.post('/api/register', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const { username, password } = req.body || {};
  if (!validateUsername(username)) {
    return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องยาว 3-20 ตัว ใช้ได้เฉพาะตัวอักษร ตัวเลข _ . -' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'รหัสผ่านต้องยาว 8-72 ตัวอักษร' });
  }
  const name = username.trim();
  const { salt, hash } = hashPassword(password);
  try {
    const info = q.insertUser.run(name, name, salt, hash, Date.now());
    createSession(req, res, info.lastInsertRowid);
    res.status(201).json({ user: { username: name, name } });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
    console.error(e);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดของเซิร์ฟเวอร์' });
  }
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }
  const user = q.userByName.get(username.trim());
  const ok = user
    ? verifyPassword(password, user.pass_salt, user.pass_hash)
    : (verifyPassword(password, DUMMY.salt, DUMMY.hash), false);
  if (!ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) q.deleteSession.run(sha256(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/draw', requireAuth, async (req, res) => {
  const { topicKey, customQuestion } = req.body || {};
  const topic = TOPICS[topicKey];
  if (!topic) return res.status(400).json({ error: 'หัวข้อไม่ถูกต้อง' });

  const today = dayKey();

  let desc = topic.desc;
  let question = null;
  if (topicKey === 'custom') {
    const t = typeof customQuestion === 'string' ? customQuestion.trim().slice(0, 200) : '';
    desc = t || topic.desc;
    question = t || null;
  }
  const cards = shuffleDraw(topic.cards);

  // ให้ LLM เรียบเรียงคำทำนาย ถ้าไม่สำเร็จจะส่ง narrative = null แล้วหน้าเว็บใช้ข้อความจากฐานข้อมูลแทน
  let narrative = null;
  let useLlm = false;
  if (!llmEnabled()) console.log('[llm] ข้าม: ไม่มี API key ที่ใช้งานได้');
  else if (!TAROT_BY_ID.size) console.log('[llm] ข้าม: ยังไม่ได้โหลด public/tarot_database.json');
  else if (!llmAllowed(req.user.id)) console.log('[llm] ข้าม: เกินโควตาที่ตั้งไว้ (LLM_DAILY_CAP / LLM_USER_HOURLY_CAP)');
  else useLlm = true;
  if (useLlm) {
    try {
      const full = cards.map((c) => ({ ...TAROT_BY_ID.get(c.id), reversed: c.reversed }));
      narrative = await generateNarrative({
        topicTitle: topic.title,
        question,
        cards: full,
        positions: positionsFor(topicKey, cards.length),
        categoryKey: TOPIC_TO_CATEGORY[topicKey] || null
      });
    } catch (e) {
      console.warn('LLM ล้มเหลว ใช้คำทำนายสำรอง:', e.message);
    }
  }

  try {
    // เก็บผลล่าสุดของวัน (ดูดวงได้ไม่จำกัด จึงเขียนทับรายการเดิมของวันนั้น)
    q.insertReading.run(req.user.id, today, topicKey, topic.title, desc, JSON.stringify(cards), Date.now(),
      narrative ? JSON.stringify(narrative) : null);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดของเซิร์ฟเวอร์' });
  }
  res.status(201).json({ reading: readingPayload(q.getReading.get(req.user.id, today)) });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));

// ไฟล์หน้าเว็บ + tarot_database.json + images/ อยู่ในโฟลเดอร์ public/
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Meow Tarot running on http://localhost:${PORT}  (data: ${DATA_DIR}, tz: ${TZ})`);
  console.log(`[llm] ผู้ให้บริการ -> ${llmStatus()} | โหลดไพ่ ${TAROT_BY_ID.size}/78 ใบ | ใช้งานได้: ${llmEnabled() && TAROT_BY_ID.size > 0}`);
});