// wilwid background worker: the only place that talks to Jev.
// Content scripts send batches of block texts; we answer with one Noul
// probability per (block, keyword), asking only for pairs we haven't seen.

const API = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const REQUEST_CHARS = 60_000; // ~17k tokens of questions per request, well under Jev's 64k
const CACHE_LIMIT = 50_000;
const RETRIES = 3;

const cache = new Map(); // `${keyword}\n${text}` -> noul

// Each block travels inside its own question. Pointing at `blocks[i]` in a
// shared state made Jev mix up look-alike neighbours (e.g. Hacker News rows).
// "machine-learning" is typed as one tag but asked as "machine learning".
const question = (text, keyword) => ({
  type: 'noul',
  instructions: { content: text, question: `Is \`content\` about ${keyword.replace(/[-_]+/g, ' ')}?` },
});

async function askJev(apiKey, questions) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: 'A block of text from a web page.', questions }),
    });
    if (res.ok) return (await res.json()).answers;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRIES) {
      throw new Error(res.status === 401 ? 'Jev rejected the API key' : `Jev error ${res.status}`);
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 250 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait + Math.random() * 100));
  }
}

// Ask about every (text, keyword) pair, packed into as few requests as fit.
async function askPairs(apiKey, pairs) {
  const requests = [];
  let current = [];
  let chars = 0;
  for (const pair of pairs) {
    if (current.length && chars + pair[0].length > REQUEST_CHARS) {
      requests.push(current);
      current = [];
      chars = 0;
    }
    current.push(pair);
    chars += pair[0].length;
  }
  requests.push(current);

  await Promise.all(
    requests.map(async (batch) => {
      const answers = await askJev(apiKey, Object.fromEntries(batch.map(([t, k], i) => [i, question(t, k)])));
      batch.forEach(([t, k], i) => cache.set(`${k}\n${t}`, answers[i].noul));
    }),
  );
}

async function classify(texts, keywords) {
  const pairs = [];
  for (const text of new Set(texts)) {
    for (const k of keywords) if (!cache.has(`${k}\n${text}`)) pairs.push([text, k]);
  }

  if (pairs.length) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) throw new Error('Add your Jev API key in the wilwid popup');
    await askPairs(apiKey, pairs);
    if (cache.size > CACHE_LIMIT) {
      [...cache.keys()].slice(0, cache.size - CACHE_LIMIT).forEach((key) => cache.delete(key));
    }
  }

  return texts.map((text) =>
    Object.fromEntries(keywords.map((k) => [k, cache.get(`${k}\n${text}`) ?? 0])),
  );
}

// The popup shows the latest problem; only touch storage when it changes.
let lastError;
function setError(message) {
  if (message !== lastError) chrome.storage.local.set({ lastError: (lastError = message) });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'classify') {
    classify(msg.texts, msg.keywords).then(
      (scores) => {
        setError('');
        reply({ scores });
      },
      (err) => {
        setError(err.message);
        reply({ error: err.message });
      },
    );
    return true; // async reply
  }
  if (msg.type === 'hidden' && sender.tab) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.count ? String(msg.count) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#E16259' });
  }
});
