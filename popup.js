// wilwid popup: edit the two keyword lists and a few switches.
// Everything is saved to chrome.storage; content scripts react on their own.

const DEFAULTS = { enabled: true, likes: [], dislikes: [], hideStyle: 'pill', strictSites: {} };
const $ = (sel) => document.querySelector(sel);

let prefs;
let host = '';

const save = (patch) => {
  Object.assign(prefs, patch);
  return chrome.storage.sync.set(patch);
};

// "#Machine-Learning," -> "machine-learning"
const normalize = (word) =>
  word.toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}+#.'_-]/gu, '').slice(0, 40);

// ---------- tag inputs (GitHub topics style) ----------

function renderTags(box) {
  const list = box.dataset.list;
  box.querySelectorAll('.tag').forEach((t) => t.remove());
  const input = box.querySelector('input');
  for (const word of prefs[list]) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = word;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = `Remove ${word}`;
    x.onclick = (e) => {
      e.stopPropagation();
      tag.classList.add('bye');
      tag.addEventListener('animationend', () => removeWord(list, word), { once: true });
    };
    tag.append(x);
    box.insertBefore(tag, input);
  }
  input.placeholder = prefs[list].length ? 'add…' : input.dataset.empty;
}

function addWords(list, words) {
  const other = list === 'likes' ? 'dislikes' : 'likes';
  const add = words.map(normalize).filter((w) => w && !prefs[list].includes(w));
  if (!add.length) return;
  // A word can't be both liked and disliked: the newest opinion wins.
  save({ [list]: [...prefs[list], ...add], [other]: prefs[other].filter((w) => !add.includes(w)) });
  document.querySelectorAll('.tags').forEach(renderTags);
}

function removeWord(list, word) {
  save({ [list]: prefs[list].filter((w) => w !== word) });
  renderTags(document.querySelector(`.tags[data-list=${list}]`));
}

for (const box of document.querySelectorAll('.tags')) {
  const list = box.dataset.list;
  const input = box.querySelector('input');
  input.dataset.empty = input.placeholder;
  box.onclick = () => input.focus();

  // Whitespace or a comma finishes a word, just like GitHub topics.
  input.addEventListener('input', () => {
    const parts = input.value.split(/[\s,]+/);
    if (parts.length < 2) return;
    input.value = parts.pop();
    addWords(list, parts);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addWords(list, [input.value]);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && prefs[list].length) {
      removeWord(list, prefs[list].at(-1));
    }
  });
  input.addEventListener('blur', () => {
    addWords(list, [input.value]);
    input.value = '';
  });
}

// ---------- switches ----------

function renderSwitches() {
  $('#enabled').checked = prefs.enabled;
  document.body.classList.toggle('off', !prefs.enabled);
  $('#strict').checked = !!prefs.strictSites[host];
  for (const b of document.querySelectorAll('#hideStyle button')) {
    b.classList.toggle('on', b.dataset.value === prefs.hideStyle);
  }
}

$('#enabled').onchange = (e) => {
  save({ enabled: e.target.checked });
  renderSwitches();
};
$('#strict').onchange = (e) => {
  const strictSites = { ...prefs.strictSites };
  if (e.target.checked) strictSites[host] = true;
  else delete strictSites[host];
  save({ strictSites });
};
for (const b of document.querySelectorAll('#hideStyle button')) {
  b.onclick = () => {
    save({ hideStyle: b.dataset.value });
    renderSwitches();
  };
}

// ---------- API key & status ----------

function renderKey(apiKey) {
  $('#key-state').textContent = apiKey ? '· saved ✓' : '· needed';
  $('#key-box').open = !apiKey;
}

$('#apiKey').addEventListener('change', (e) => {
  const apiKey = e.target.value.trim();
  chrome.storage.local.set({ apiKey, lastError: '' });
  e.target.value = '';
  e.target.placeholder = apiKey ? '•••••••• saved' : 'Paste your TypeSafe key';
  renderKey(apiKey);
});

function renderError(message) {
  $('#error').hidden = !message;
  $('#error').textContent = message ? `😬 ${message}` : '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'lastError' in changes) renderError(changes.lastError.newValue);
});

async function renderStats(tabId) {
  const stat = $('#stat');
  try {
    const { hidden, checked } = await chrome.tabs.sendMessage(tabId, { type: 'stats' });
    if (!prefs.likes.length && !prefs.dislikes.length) {
      stat.textContent = '👋 Add a few words above and watch this page change.';
    } else if (!prefs.enabled) {
      stat.textContent = '😴 wilwid is napping. Flip the switch to wake it up.';
    } else if (hidden) {
      stat.innerHTML = `🙈 Hid <b>${hidden}</b> of ${checked} things on <b></b>`;
      stat.querySelector('b:last-child').textContent = host;
    } else {
      stat.innerHTML = `✨ Checked ${checked} things on <b></b>, all good.`;
      stat.querySelector('b').textContent = host;
    }
  } catch {
    stat.textContent = '🚧 wilwid can’t run on this page.';
    $('#strict-row').hidden = true;
  }
}

(async () => {
  prefs = await chrome.storage.sync.get(DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  $('#strict-hint').textContent = `Hide anything on ${host || 'this site'} that isn't on my likes list.`;

  const { apiKey, lastError } = await chrome.storage.local.get(['apiKey', 'lastError']);
  if (apiKey) $('#apiKey').placeholder = '•••••••• saved';
  renderKey(apiKey);
  renderError(lastError);

  document.querySelectorAll('.tags').forEach(renderTags);
  renderSwitches();
  renderStats(tab.id);
  setInterval(() => renderStats(tab.id), 1000);
})();
