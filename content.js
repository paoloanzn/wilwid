// wilwid content script.
// 1. Find content blocks: the natural "units" of a page (feed items, cards,
//    comments, search results, paragraphs) — purely from DOM structure.
// 2. When a block nears the viewport, batch it off to Jev (via background.js).
// 3. Hide blocks about things you don't like; in strict mode, anything not
//    about things you like.

const MIN_CHARS = 25; // shorter than this isn't worth judging
const MAX_CHARS = 3000; // a block bigger than this is a layout region, not a unit
const SEND_CHARS = 1200; // what Jev sees of each block
const BATCH = 12; // blocks per Jev request
const YES = 0.5; // Noul threshold for "this block is about keyword"

const SKIP = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'input', 'textarea', 'select', 'button', 'nav', 'header', 'footer', 'dialog',
  '[role=navigation]', '[role=banner]', '[role=contentinfo]', '[role=menu]', '[role=menubar]',
  '[role=tablist]', '[role=search]', '[role=dialog]', '[contenteditable]', '[aria-hidden=true]',
].join(',');
// Explicit "one item" markup wins over any heuristic.
const ITEM = 'article, [role=article], [role=listitem], li, tr, [itemscope]';
// Prose: good fallback units, but repeated paragraphs are not list items.
const PROSE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DD', 'FIGCAPTION']);
const INLINE = new Set(['A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'LABEL', 'CODE', 'TIME', 'MARK', 'ABBR', 'SUP', 'SUB']);

let prefs = { enabled: true, likes: [], dislikes: [], hideStyle: 'pill', strictSites: {} };
const blocks = new Map(); // element -> { text, scores, why }
const seen = new Set(); // blocks that reached the viewport at least once
let queue = new Set();
let flushTimer = 0;

const host = location.hostname;
const keywords = () => [...prefs.likes, ...prefs.dislikes];
const strict = () => !!prefs.strictSites[host];
const active = () => prefs.enabled && keywords().length > 0;

// ---------- block detection ----------

// Per-scan caches: DOM shifts between scans, so they're rebuilt each time.
let lengths = new WeakMap();
let siblingSigs = new WeakMap();
let skips = new WeakMap();

// Inside nav, header, a form control…? Memoized: thousands of text nodes share ancestors.
function skipped(el) {
  if (!el || el === document.body) return false;
  let v = skips.get(el);
  if (v === undefined) skips.set(el, (v = el.matches(SKIP) || skipped(el.parentElement)));
  return v;
}

function textLength(el) {
  let n = lengths.get(el);
  if (n === undefined) lengths.set(el, (n = el.textContent.trim().length));
  return n;
}

// Tag + test id or first class: the stable "component name" on most sites
// (later classes tend to be variants or hashes, e.g. styled-components).
const signature = (el) => `${el.tagName}.${el.dataset.testid ?? el.classList[0] ?? ''}`;

// Does el have ≥2 look-alike siblings? That's how feeds, results and comment
// threads show up, whatever the site calls them.
function isRepeated(el) {
  const parent = el.parentElement;
  if (!parent) return false;
  let counts = siblingSigs.get(parent);
  if (!counts) {
    counts = new Map();
    for (const child of parent.children) {
      const sig = signature(child);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    siblingSigs.set(parent, counts);
  }
  return counts.get(signature(el)) >= 3;
}

function isBlockish(el) {
  return !INLINE.has(el.tagName) || getComputedStyle(el).display !== 'inline';
}

// The unit a piece of text belongs to, or null.
function unitFor(el) {
  const item = el.closest(ITEM);
  if (item && textLength(item) >= MIN_CHARS && textLength(item) <= MAX_CHARS) return item;

  let prose = null;
  for (let a = el; a && a !== document.body; a = a.parentElement) {
    const len = textLength(a);
    if (len > MAX_CHARS) break;
    if (len < MIN_CHARS) continue;
    if (PROSE.has(a.tagName)) prose ??= a;
    else if (isRepeated(a) && isBlockish(a)) return a;
  }
  return prose;
}

function scan(root) {
  if (!active() || !root.isConnected) return;
  lengths = new WeakMap();
  siblingSigs = new WeakMap();
  skips = new WeakMap();

  const parents = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    if (node.parentElement && node.data.trim()) parents.add(node.parentElement);
  }
  for (const el of parents) {
    if (skipped(el) || el.closest('[data-wilwid]')) continue;
    const unit = unitFor(el);
    if (unit && !unit.closest('[data-wilwid]') && !unit.querySelector('[data-wilwid]')) {
      unit.dataset.wilwid = 'new';
      blocks.set(unit, { text: '', scores: null, why: '' });
      nearViewport.observe(unit);
    }
  }
}

// ---------- classification ----------

const nearViewport = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      nearViewport.unobserve(target);
      seen.add(target);
      enqueue(target);
    }
  },
  { rootMargin: '800px 0px' },
);

function enqueue(el) {
  if (!active() || !blocks.has(el)) return;
  if (el.dataset.wilwid !== 'hidden' && el.dataset.wilwid !== 'revealed') el.dataset.wilwid = 'pending';
  queue.add(el);
  if (queue.size >= BATCH) flush();
  else flushTimer ||= setTimeout(flush, 30);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  const els = [...queue].filter((el) => el.isConnected);
  queue = new Set();
  for (let i = 0; i < els.length; i += BATCH) classify(els.slice(i, i + BATCH));
}

// innerText is what a reader sees. A folded block shows nothing, so it keeps
// the text it had when it was last visible.
function textOf(el) {
  const block = blocks.get(el);
  if (el.dataset.wilwid !== 'hidden' || !block.text) {
    block.text = el.innerText.replace(/\s+/g, ' ').trim().slice(0, SEND_CHARS);
  }
  return block.text;
}

async function classify(els) {
  const kws = keywords();
  const texts = els.map(textOf);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'classify', texts, keywords: kws });
  } catch {
    res = { error: 'extension reloaded' };
  }
  els.forEach((el, i) => {
    const block = blocks.get(el);
    if (!block) return;
    if (res?.scores) block.scores = res.scores[i];
    apply(el, block);
  });
  report();
}

// ---------- decisions (pure code, no model calls) ----------

function best(list, scores) {
  let top = null;
  for (const k of list) if ((scores[k] ?? 0) >= YES && (!top || scores[k] > scores[top])) top = k;
  return top;
}

// Why a block should be hidden, or '' to show it. Likes beat dislikes.
function verdict(scores) {
  if (!scores || !active()) return '';
  if (best(prefs.likes, scores)) return '';
  const dislike = best(prefs.dislikes, scores);
  if (dislike) return dislike;
  if (strict() && prefs.likes.length) return 'not on your likes';
  return '';
}

function apply(el, block) {
  if (el.dataset.wilwid === 'revealed') return;
  block.why = verdict(block.scores);
  if (block.why) {
    el.dataset.wilwid = 'hidden';
    el.dataset.wilwidStyle = prefs.hideStyle;
    el.dataset.wilwidWhy = block.why.replace(/[-_]+/g, ' ');
  } else {
    el.dataset.wilwid = 'shown';
  }
}

// Count what's folded, forgetting blocks the page threw away (virtualized feeds).
function hiddenCount() {
  let hidden = 0;
  for (const el of blocks.keys()) {
    if (!el.isConnected) {
      blocks.delete(el);
      seen.delete(el);
    } else if (el.dataset.wilwid === 'hidden') hidden++;
  }
  return hidden;
}

function report() {
  chrome.runtime.sendMessage({ type: 'hidden', count: hiddenCount() }).catch(() => {});
}

// Peek at a hidden block by clicking its pill.
document.addEventListener(
  'click',
  (e) => {
    const el = e.target.closest?.('[data-wilwid=hidden]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    el.dataset.wilwid = 'revealed';
    report();
  },
  true,
);

// ---------- lifecycle ----------

function refresh() {
  hiddenCount(); // prunes detached blocks
  for (const [el, block] of blocks) {
    if (!active()) {
      el.dataset.wilwid = 'shown';
    } else if (seen.has(el)) {
      // Cached pairs come back instantly; new keywords cost one request per batch.
      if (block.scores && keywords().every((k) => k in block.scores)) apply(el, block);
      else enqueue(el);
    }
  }
  if (active()) scan(document.body);
  report();
}

// Infinite scroll, SPA navigation, lazy hydration: scan whatever gets added.
let added = new Set();
let scanTimer = 0;
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el && !el.closest('[data-wilwid]')) added.add(el);
    }
  }
  scanTimer ||= setTimeout(() => {
    scanTimer = 0;
    const roots = added;
    added = new Set();
    for (const root of roots) scan(root);
  }, 120);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const [key, { newValue }] of Object.entries(changes)) if (key in prefs) prefs[key] = newValue;
    refresh();
  } else if (changes.apiKey?.newValue) {
    refresh(); // retry blocks that failed for lack of a (valid) key
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'stats') {
    reply({ host, hidden: hiddenCount(), checked: seen.size });
  }
});

chrome.storage.sync.get(prefs).then((stored) => {
  prefs = stored;
  scan(document.body);
  observer.observe(document.body, { childList: true, subtree: true });
});
