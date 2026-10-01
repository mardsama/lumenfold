require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
const KEY = process.env.JWT_KEY || 'dev-only-change-me';
const db = new Database(process.env.DB_PATH || 'lumenfold.db');

// Create the database tables the first time
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  recap INTEGER DEFAULT 1,
  remind INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  uid INTEGER NOT NULL,
  title TEXT NOT NULL,
  done INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  email TEXT,
  message TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const makeToken = (uid) =>
  jwt.sign({ uid }, KEY, { expiresIn: '14d' });

// Blocks requests from people who are not signed in
function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').slice(7);
    req.uid = jwt.verify(t, KEY).uid;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please sign in first.' });
  }
}

function validCreds(b) {
  return /^\S+@\S+\.\S+$/.test(b.email || '') &&
    (b.password || '').length >= 6;
}

// ---------- Accounts ----------
app.post('/api/signup', (req, res) => {
  if (!validCreds(req.body)) {
    return res.status(400).json({
      error: 'Use a valid email and a 6+ character password.'
    });
  }
  try {
    const r = db
      .prepare('INSERT INTO users (email, hash) VALUES (?, ?)')
      .run(
        req.body.email.toLowerCase(),
        bcrypt.hashSync(req.body.password, 10)
      );
    res.json({ token: makeToken(r.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({
      error: 'That email already has an account. Sign in instead.'
    });
  }
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const u = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  res.json({ token: makeToken(u.id) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db
    .prepare('SELECT email, recap, remind FROM users WHERE id = ?')
    .get(req.uid);
  if (!u) return res.status(401).json({ error: 'Account not found.' });
  res.json(u);
});

// ---------- Tasks ----------
app.get('/api/tasks', auth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, done FROM tasks WHERE uid = ? ORDER BY id')
    .all(req.uid);
  res.json(rows);
});

app.post('/api/tasks', auth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) {
    return res.status(400).json({ error: 'Task title is empty.' });
  }
  db.prepare('INSERT INTO tasks (uid, title) VALUES (?, ?)')
    .run(req.uid, title);
  res.json({ ok: true });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  db.prepare('UPDATE tasks SET done = ? WHERE id = ? AND uid = ?')
    .run(req.body.done ? 1 : 0, req.params.id, req.uid);

  // Automation 1: recap email when every task is finished
  const left = db
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE uid = ? AND done = 0')
    .get(req.uid).n;
  const u = db
    .prepare('SELECT email, recap FROM users WHERE id = ?')
    .get(req.uid);
  if (left === 0 && u.recap) {
    sendEmail(u.email, 'All done today', 'Every task is finished!');
  }
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND uid = ?')
    .run(req.params.id, req.uid);
  res.json({ ok: true });
});

// ---------- Automation switches ----------
app.patch('/api/settings', auth, (req, res) => {
  const key = req.body.key;
  if (!['recap', 'remind'].includes(key)) {
    return res.status(400).json({ error: 'Unknown setting.' });
  }
  db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`)
    .run(req.body.value ? 1 : 0, req.uid);
  res.json({ ok: true });
});

// ---------- Contact form ----------
app.post('/api/contact', (req, res) => {
  const { email, message } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '') || !message) {
    return res.status(400).json({
      error: 'Please enter your email and a message.'
    });
  }
  db.prepare('INSERT INTO contacts (email, message) VALUES (?, ?)')
    .run(email, String(message).slice(0, 1000));
  res.json({ ok: true });
});

// ---------- Chatbot ----------
function fallback(m) {
  const l = m.toLowerCase();
  if (/price|cost|free/.test(l)) {
    return 'Free is $0, Pro is $6 a month, Team is $12 per user.';
  }
  if (/automat/.test(l)) {
    return 'Automations send a recap when you finish all tasks, ' +
      'and a reminder every day at 9:00.';
  }
  return 'I can add tasks (try "add task buy chalk") and explain ' +
    'pricing or automations.';
}

app.post('/api/chat', async (req, res) => {
  const m = String(req.body.message || '').slice(0, 500);
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
          max_tokens: 300,
          system: 'You are the helper chat for Lumenfold, a daily ' +
            'planner with tasks and automations. Plans: Free $0, ' +
            'Pro $6/mo, Team $12/user. Be brief and friendly.',
          messages: [{ role: 'user', content: m }]
        })
      });
      const d = await r.json();
      if (d.content && d.content[0]) {
        return res.json({ reply: d.content[0].text });
      }
    } catch (e) {
      console.error('Chat error:', e.message);
    }
  }
  res.json({ reply: fallback(m) });
});

// ---------- Automations ----------
// For now emails only print in the terminal. Later, connect a real
// email service (Resend, Nodemailer) inside this function.
function sendEmail(to, subject, body) {
  console.log(`[email] to=${to} | ${subject} | ${body}`);
}

// Automation 2: every day at 9:00, remind people with open tasks
cron.schedule('0 9 * * *', () => {
  const rows = db.prepare(`
    SELECT u.email, COUNT(t.id) AS n
    FROM users u JOIN tasks t ON t.uid = u.id
    WHERE u.remind = 1 AND t.done = 0
    GROUP BY u.id
  `).all();
  rows.forEach((r) => {
    sendEmail(r.email, 'Your open tasks',
      `You have ${r.n} open task(s) today.`);
  });
});

app.listen(PORT, () => {
  console.log(`Lumenfold running on http://localhost:${PORT}`);
});