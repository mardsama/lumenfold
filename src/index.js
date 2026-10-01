import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

const app = new Hono();
const enc = new TextEncoder();

// ---------- Password helpers ----------
const toHex = (buf) =>
  [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return toHex(salt) + ':' + toHex(bits);
}

async function checkPassword(password, stored) {
  const saltHex = stored.split(':')[0];
  return (await hashPassword(password, saltHex)) === stored;
}

// ---------- Login tokens ----------
const makeToken = (uid, env) =>
  sign(
    { uid, exp: Math.floor(Date.now() / 1000) + 14 * 86400 },
    env.JWT_KEY
  );

async function auth(c, next) {
  try {
    const t = (c.req.header('Authorization') || '').slice(7);
    const p = await verify(t, c.env.JWT_KEY, 'HS256');
    c.set('uid', p.uid);
  } catch (e) {
    return c.json({ error: 'Please sign in first.' }, 401);
  }
  await next();
}

const body = (c) => c.req.json().catch(() => ({}));
const validEmail = (e) => /^\S+@\S+\.\S+$/.test(e || '');

// ---------- Accounts ----------
app.post('/api/signup', async (c) => {
  const b = await body(c);
  if (!validEmail(b.email) || (b.password || '').length < 6) {
    return c.json({
      error: 'Use a valid email and a 6+ character password.'
    }, 400);
  }
  try {
    const hash = await hashPassword(b.password);
    const r = await c.env.DB
      .prepare('INSERT INTO users (email, hash) VALUES (?, ?)')
      .bind(b.email.toLowerCase(), hash)
      .run();
    return c.json({ token: await makeToken(r.meta.last_row_id, c.env) });
  } catch (e) {
    return c.json({
      error: 'That email already has an account. Sign in instead.'
    }, 400);
  }
});

app.post('/api/login', async (c) => {
  const b = await body(c);
  const u = await c.env.DB
    .prepare('SELECT * FROM users WHERE email = ?')
    .bind(String(b.email || '').toLowerCase())
    .first();
  if (!u || !(await checkPassword(b.password || '', u.hash))) {
    return c.json({ error: 'Wrong email or password.' }, 401);
  }
  return c.json({ token: await makeToken(u.id, c.env) });
});

app.get('/api/me', auth, async (c) => {
  const u = await c.env.DB
    .prepare('SELECT email, recap, remind FROM users WHERE id = ?')
    .bind(c.get('uid'))
    .first();
  if (!u) return c.json({ error: 'Account not found.' }, 401);
  return c.json(u);
});

// ---------- Tasks ----------
app.get('/api/tasks', auth, async (c) => {
  const r = await c.env.DB
    .prepare('SELECT id, title, done FROM tasks WHERE uid = ? ORDER BY id')
    .bind(c.get('uid'))
    .all();
  return c.json(r.results);
});

app.post('/api/tasks', auth, async (c) => {
  const b = await body(c);
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return c.json({ error: 'Task title is empty.' }, 400);
  await c.env.DB
    .prepare('INSERT INTO tasks (uid, title) VALUES (?, ?)')
    .bind(c.get('uid'), title)
    .run();
  return c.json({ ok: true });
});

app.patch('/api/tasks/:id', auth, async (c) => {
  const b = await body(c);
  const uid = c.get('uid');
  const db = c.env.DB;
  await db
    .prepare('UPDATE tasks SET done = ? WHERE id = ? AND uid = ?')
    .bind(b.done ? 1 : 0, c.req.param('id'), uid)
    .run();

  // Automation 1: recap when every task is finished
  const left = await db
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE uid = ? AND done = 0')
    .bind(uid)
    .first();
  const u = await db
    .prepare('SELECT email, recap FROM users WHERE id = ?')
    .bind(uid)
    .first();
  if (left.n === 0 && u.recap) {
    sendEmail(u.email, 'All done today', 'Every task is finished!');
  }
  return c.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, async (c) => {
  await c.env.DB
    .prepare('DELETE FROM tasks WHERE id = ? AND uid = ?')
    .bind(c.req.param('id'), c.get('uid'))
    .run();
  return c.json({ ok: true });
});

// ---------- Automation switches ----------
app.patch('/api/settings', auth, async (c) => {
  const b = await body(c);
  if (!['recap', 'remind'].includes(b.key)) {
    return c.json({ error: 'Unknown setting.' }, 400);
  }
  await c.env.DB
    .prepare(`UPDATE users SET ${b.key} = ? WHERE id = ?`)
    .bind(b.value ? 1 : 0, c.get('uid'))
    .run();
  return c.json({ ok: true });
});

// ---------- Contact form ----------
app.post('/api/contact', async (c) => {
  const b = await body(c);
  if (!validEmail(b.email) || !b.message) {
    return c.json({
      error: 'Please enter your email and a message.'
    }, 400);
  }
  await c.env.DB
    .prepare('INSERT INTO contacts (email, message) VALUES (?, ?)')
    .bind(b.email, String(b.message).slice(0, 1000))
    .run();
  return c.json({ ok: true });
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

app.post('/api/chat', async (c) => {
  const b = await body(c);
  const m = String(b.message || '').slice(0, 500);
  if (c.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': c.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: c.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
          max_tokens: 300,
          system: 'You are the helper chat for Lumenfold, a daily ' +
            'planner with tasks and automations. Plans: Free $0, ' +
            'Pro $6/mo, Team $12/user. Be brief and friendly.',
          messages: [{ role: 'user', content: m }]
        })
      });
      const d = await r.json();
      if (d.content && d.content[0]) {
        return c.json({ reply: d.content[0].text });
      }
    } catch (e) {
      console.error('Chat error:', e.message);
    }
  }
  return c.json({ reply: fallback(m) });
});

// ---------- Automations ----------
// Emails only print to the log for now. Connect a real email
// service (like Resend) inside this function later.
function sendEmail(to, subject, text) {
  console.log(`[email] to=${to} | ${subject} | ${text}`);
}

// Automation 2: daily reminder for people with open tasks
async function dailyReminders(env) {
  const r = await env.DB.prepare(`
    SELECT u.email, COUNT(t.id) AS n
    FROM users u JOIN tasks t ON t.uid = u.id
    WHERE u.remind = 1 AND t.done = 0
    GROUP BY u.id
  `).all();
  r.results.forEach((row) => {
    sendEmail(row.email, 'Your open tasks',
      `You have ${row.n} open task(s) today.`);
  });
}

export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReminders(env));
  }
};