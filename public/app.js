const $ = (id) => document.getElementById(id);
const dlg = $('dlg');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[c]));

let token = null;
let me = null;
let tasks = [];
try { token = localStorage.getItem('lf_token'); } catch (e) {}

function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem('lf_token', t);
    else localStorage.removeItem('lf_token');
  } catch (e) {}
}

// Talks to the backend
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}

/* ---------- Home page demo ---------- */
const demo = [
  'Write the weekly plan',
  'Send the reminder',
  'Book the free slot'
];
$('demoList').innerHTML = demo.map((t, i) =>
  `<label class="task"><input type="checkbox" data-i="${i}">` +
  `<span>${t}</span></label>`
).join('');
$('demoList').addEventListener('change', (e) => {
  e.target.parentNode.classList.toggle('done', e.target.checked);
  $('fire').textContent = e.target.checked
    ? `Automation fired: recap queued for "${demo[e.target.dataset.i]}"`
    : 'Automation paused.';
});

/* ---------- Session and dashboard ---------- */
async function load() {
  me = null;
  tasks = [];
  if (token) {
    try {
      me = await api('/me');
      tasks = await api('/tasks');
    } catch (e) {
      setToken(null);
    }
  }
  render();
}

function openAuth() {
  if (me) location.hash = 'dashboard';
  else dlg.showModal();
}

function render() {
  $('auth').textContent = me ? 'Sign out' : 'Sign in';
  if (!me) {
    $('dashBody').innerHTML =
      '<p>Sign in to see your tasks and automations.</p>' +
      '<button class="p" onclick="openAuth()">Sign in</button>';
    return;
  }
  const list = tasks.length
    ? tasks.map((k) =>
        `<div class="task ${k.done ? 'done' : ''}">` +
        `<input type="checkbox" data-k="${k.id}" ` +
        `${k.done ? 'checked' : ''} aria-label="Done">` +
        `<span style="flex:1">${esc(k.title)}</span>` +
        `<button data-x="${k.id}">Delete</button></div>`
      ).join('')
    : '<p>No tasks yet. Add your first one above.</p>';

  $('dashBody').innerHTML = `
    <p>Signed in as <strong>${esc(me.email)}</strong></p>
    <form class="row" id="tf">
      <input type="text" id="ti" placeholder="Add a task"
        aria-label="New task" required>
      <button class="p">Add task</button>
    </form>
    <div>${list}</div>
    <h3 style="margin-top:20px">Automations</h3>
    <div class="sw"><span>Email a recap when all tasks are done</span>
      <input type="checkbox" data-a="recap"
        ${me.recap ? 'checked' : ''}></div>
    <div class="sw"><span>Remind me at 9:00 about open tasks</span>
      <input type="checkbox" data-a="remind"
        ${me.remind ? 'checked' : ''}></div>`;

  $('tf').onsubmit = async (e) => {
    e.preventDefault();
    await api('/tasks', { method: 'POST',
      body: { title: $('ti').value } });
    load();
  };
  $('dashBody').querySelectorAll('[data-k]').forEach((c) => {
    c.onchange = async () => {
      await api('/tasks/' + c.dataset.k, { method: 'PATCH',
        body: { done: c.checked } });
      load();
    };
  });
  $('dashBody').querySelectorAll('[data-x]').forEach((b) => {
    b.onclick = async () => {
      await api('/tasks/' + b.dataset.x, { method: 'DELETE' });
      load();
    };
  });
  $('dashBody').querySelectorAll('[data-a]').forEach((c) => {
    c.onchange = async () => {
      await api('/settings', { method: 'PATCH',
        body: { key: c.dataset.a, value: c.checked } });
      me[c.dataset.a] = c.checked ? 1 : 0;
    };
  });
}

/* ---------- Sign in, create account, sign out ---------- */
$('auth').onclick = () => {
  if (me) { setToken(null); load(); }
  else dlg.showModal();
};

async function authGo(path) {
  $('aerr').textContent = '';
  try {
    const d = await api(path, { method: 'POST', body: {
      email: $('ae').value, password: $('ap').value
    } });
    setToken(d.token);
    dlg.close();
    await load();
    location.hash = 'dashboard';
  } catch (e) {
    $('aerr').textContent = e.message;
  }
}
$('af').onsubmit = (e) => { e.preventDefault(); authGo('/login'); };
$('su').onclick = () => authGo('/signup');

/* ---------- Contact form ---------- */
$('cf').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/contact', { method: 'POST', body: {
      email: $('ce').value, message: $('cm').value
    } });
    $('cstat').textContent = 'Message sent. We reply within a day.';
    e.target.reset();
  } catch (err) {
    $('cstat').textContent = err.message;
  }
};

/* ---------- Menu, theme, scroll effects ---------- */
$('burger').onclick = () => {
  const open = $('links').classList.toggle('open');
  $('burger').setAttribute('aria-expanded', open);
};
$('links').addEventListener('click', (e) => {
  if (e.target.tagName === 'A') $('links').classList.remove('open');
});
$('theme').onclick = () => {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
};
addEventListener('scroll', () => {
  const h = document.documentElement;
  const pct = scrollY / (h.scrollHeight - innerHeight) * 100;
  $('bar').style.width = pct + '%';
}, { passive: true });

const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

/* ---------- Chatbot ---------- */
function say(text, cls) {
  const d = document.createElement('div');
  d.className = 'm ' + cls;
  d.textContent = text;
  $('msgs').append(d);
  $('msgs').scrollTop = 1e9;
}
say('Hi! I can add tasks, explain pricing or show you around. ' +
  'Try "add task buy chalk".', 'b');

$('chatBtn').onclick = () => $('chat').classList.toggle('open');
$('cform').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('cin').value.trim();
  if (!q) return;
  say(q, 'u');
  $('cin').value = '';
  try {
    if (q.toLowerCase().startsWith('add task ')) {
      if (!me) return say('Sign in first and I will add it.', 'b');
      await api('/tasks', { method: 'POST',
        body: { title: q.slice(9) } });
      await load();
      return say('Done, task added.', 'b');
    }
    const d = await api('/chat', { method: 'POST',
      body: { message: q } });
    say(d.reply, 'b');
  } catch (err) {
    say(err.message, 'b');
  }
};

load();