const MU = {
  active: false,
  device: 'pc',
  userName: '',
  comments: [],
  pinElements: {},
  selectedId: null,
  fixedWidth: false,
  toolbarMode: 'top'
};

let MU_HOVER_TIMER = null;

(async function init() {
  const stored = await chrome.storage.local.get(['mu_username', 'mu_device', 'mu_fixed_width', 'mu_toolbar_mode']);
  if (stored.mu_username) MU.userName = stored.mu_username;
  if (stored.mu_device) MU.device = stored.mu_device;
  if (stored.mu_fixed_width) MU.fixedWidth = true;
  if (stored.mu_toolbar_mode) MU.toolbarMode = stored.mu_toolbar_mode;
  chrome.runtime.onMessage.addListener(handleMessage);
})();

function handleMessage(msg, sender, sendResponse) {
  if (msg.type === 'GET_STATE') {
    sendResponse({ active: MU.active, device: MU.device, userName: MU.userName, commentCount: MU.comments.length });
    return true;
  }
  if (msg.type === 'TOGGLE_ACTIVE') {
    MU.active ? deactivate() : activate();
    sendResponse({ active: MU.active });
    return true;
  }
  if (msg.type === 'SET_USERNAME') {
    MU.userName = msg.name;
    chrome.storage.local.set({ mu_username: msg.name });
    sb_addMember(msg.name);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SET_DEVICE') {
    setDevice(msg.device);
    sendResponse({ ok: true });
    return true;
  }
}

let MU_POLL_TIMER = null;
let MU_SITE_FIXED = [];
let MU_SITE_FIXED_RIGHT = [];
let MU_READ_IDS = new Set();
let MU_OBJECT_URLS = [];
const MU_CACHE = { pc: null, mobile: null };
const MU_MAX_FILE = 10 * 1024 * 1024;
let MU_FILE_OPEN = false;
let MU_DETAIL_SEQ = 0;

function readKey() { return 'mu_read_' + MU.userName; }

// ウィンドウ幅を現在のデバイスの固定幅にそろえる。
// 「幅固定」トグルが ON のときだけ呼ばれる。全員が同じ幅で見れば
// 「この画面幅でコメントがついている」前提が共有でき、ピン位置のズレを抑えられる。
function applyFixedWidth() {
  try { chrome.runtime.sendMessage({ type: 'RESIZE_WINDOW', mode: MU.device }); } catch (_) {}
}

// 「幅固定」トグルの ON/OFF を切り替える。
// ON にした瞬間はウィンドウ幅を固定幅にリサイズし、OFF にしたときは幅を変えない。
// 状態は chrome.storage.local に保存し、次回起動時も引き継ぐ。
function toggleFixedWidth() {
  MU.fixedWidth = !MU.fixedWidth;
  chrome.storage.local.set({ mu_fixed_width: MU.fixedWidth });
  updateFixedWidthBtn();
  if (MU.fixedWidth) applyFixedWidth();
}

// 「幅固定」ボタンの見た目（ON ハイライト）を現在の状態に合わせて更新する
function updateFixedWidthBtn() {
  const btn = document.getElementById('mu-fixw-btn');
  if (!btn) return;
  if (MU.toolbarMode === 'side') {
    btn.classList.toggle('mu-side-on', MU.fixedWidth);
  } else {
    btn.classList.toggle('mu-seg-on', MU.fixedWidth);
  }
}

async function activate() {
  MU.active = true;
  if (MU.toolbarMode === 'side') {
    const current = parseInt(getComputedStyle(document.body).marginLeft) || 0;
    const style = document.createElement('style');
    style.id = 'mu-offset';
    style.textContent = `body{margin-left:${current + 52}px!important}`;
    document.head.appendChild(style);
    pushRightFixedElements();
  } else {
    const current = parseInt(getComputedStyle(document.body).marginTop) || 0;
    const style = document.createElement('style');
    style.id = 'mu-offset';
    style.textContent = `body{margin-top:${current + 48}px!important}`;
    document.head.appendChild(style);
    pushDownFixedElements();
  }
  buildUI();
  const readData = await chrome.storage.local.get(readKey());
  MU_READ_IDS = new Set(readData[readKey()] || []);
  await loadComments();
  startPolling();
}

function deactivate() {
  MU.active = false;
  stopPolling();
  document.getElementById('mu-offset')?.remove();
  if (MU.toolbarMode === 'side') {
    restoreRightFixedElements();
  } else {
    restoreFixedElements();
  }
  window.removeEventListener('resize', syncOverlaySize);
  ['mu-toolbar', 'mu-overlay', 'mu-nav'].forEach(id => document.getElementById(id)?.remove());
}

function startPolling() {
  stopPolling();
  MU_POLL_TIMER = setInterval(pollComments, 20000);
}

function stopPolling() {
  clearInterval(MU_POLL_TIMER);
  MU_POLL_TIMER = null;
}

async function pollComments() {
  if (!MU.active) return;
  try {
    const fresh = await sb_getComments(window.location.href, MU.device);
    if (!fresh) return;
    const currentIds = new Set(MU.comments.map(c => c.id));
    const newCount = fresh.filter(c => !currentIds.has(c.id)).length;
    if (newCount > 0) showNotify(newCount, fresh);
  } catch (_) {}
}

function showNotify(count, fresh) {
  const existing = document.getElementById('mu-notify-btn');
  if (existing) { existing.dataset.fresh = JSON.stringify(fresh); existing.textContent = `🔔 ${count}件の新着`; return; }
  const btn = document.createElement('button');
  btn.id = 'mu-notify-btn';
  btn.className = 'mu-btn mu-notify-btn';
  btn.textContent = `🔔 ${count}件の新着`;
  btn.dataset.fresh = JSON.stringify(fresh);
  btn.addEventListener('click', async () => {
    const data = JSON.parse(btn.dataset.fresh);
    btn.remove();
    Object.values(MU.pinElements).forEach(el => el.remove());
    MU.pinElements = {};
    MU.comments = data;
    MU_CACHE[MU.device] = MU.comments;
    syncOverlaySize();
    MU.comments.forEach(addPin);
    updateBadge();
    closePopover();
  });
  document.getElementById('mu-toolbar')?.querySelector('.mu-right')?.prepend(btn);
}

// オーバーレイのサイズをページ全体に合わせ、ピン位置も再計算
function syncOverlaySize() {
  const overlay = document.getElementById('mu-overlay');
  if (!overlay) return;
  const w = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  overlay.style.width  = w + 'px';
  overlay.style.height = h + 'px';
  repositionPins();
}

function overlayDims() {
  const overlay = document.getElementById('mu-overlay');
  return {
    w: parseFloat(overlay?.style.width)  || document.documentElement.scrollWidth,
    h: parseFloat(overlay?.style.height) || document.documentElement.scrollHeight
  };
}

// ハッシュ文字列や自動生成されたID/クラスを除外して安定したものだけ使う
function muIsStable(s) {
  if (!s) return false;
  if (!/^[a-zA-Z][\w-]*$/.test(s)) return false;       // 記号始まり・特殊文字を除外
  if (/[a-f0-9]{5,}/i.test(s)) return false;            // 連続した16進ハッシュを除外
  if (/^(css|sc|jsx|emotion|chakra|mui)-/i.test(s)) return false; // CSS-in-JS自動クラス
  if (s.length > 40) return false;
  return true;
}

// 要素のCSSセレクタを生成（クラス名に依存せず構造パスで生成）
function getCssSelector(el) {
  if (muIsStable(el.id)) return '#' + CSS.escape(el.id);
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 10) {
    if (muIsStable(cur.id)) { parts.unshift('#' + CSS.escape(cur.id)); break; }
    const parent = cur.parentElement;
    if (!parent) break;
    const tag = cur.tagName.toLowerCase();
    const same = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}

// ---- 要素の「指紋（fingerprint）」方式 ----
// 位置（nth-of-type）ではなく、要素の中身・属性で要素を識別する。
// レスポンシブで要素の並び順や階層が多少変わっても、
// 「同じ中身を持つ要素」を採点で見つけられるようにするのが狙い。

// 要素から短く正規化したテキストを取り出す
function muElText(el) {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) : t;
}

// 要素1個分の特徴を集める
function muNodeFeatures(el) {
  const f = { tag: el.tagName.toLowerCase() };
  if (muIsStable(el.id)) f.id = el.id;
  const cls = (el.className && typeof el.className === 'string' ? el.className : '')
    .split(/\s+/).filter(muIsStable).slice(0, 4);
  if (cls.length) f.cls = cls;
  // 識別に役立つ属性（リンク先・画像・ボタン種別・data-*など）
  const attrs = {};
  for (const name of ['href', 'src', 'alt', 'type', 'name', 'role', 'aria-label', 'data-testid', 'placeholder']) {
    const v = el.getAttribute && el.getAttribute(name);
    if (v && v.length < 120) attrs[name] = v;
  }
  if (Object.keys(attrs).length) f.attrs = attrs;
  const txt = muElText(el);
  if (txt) f.text = txt;
  // 親の何番目か（同じタグの中での順番）。最後の手がかりとして保持
  const parent = el.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter(s => s.tagName === el.tagName);
    f.idx = same.indexOf(el);
    f.total = same.length;
  }
  return f;
}

// クリックした要素＋先祖数段ぶんの指紋を作る
function buildFingerprint(el) {
  const chain = [];
  let cur = el;
  let depth = 0;
  while (cur && cur !== document.body && cur !== document.documentElement && depth < 5) {
    chain.push(muNodeFeatures(cur));
    cur = cur.parentElement;
    depth++;
  }
  return chain; // [対象要素, 親, 祖父, ...]
}

// 1要素と保存済み特徴の一致度を採点（0〜100）
function muScoreNode(el, f) {
  if (!el || el.tagName.toLowerCase() !== f.tag) return -1;
  let score = 5; // タグ一致の基礎点
  if (f.id && el.id === f.id) score += 60;
  if (f.attrs) {
    for (const [k, v] of Object.entries(f.attrs)) {
      if ((el.getAttribute && el.getAttribute(k)) === v) score += 18;
    }
  }
  if (f.cls) {
    const elCls = (el.className && typeof el.className === 'string' ? el.className : '').split(/\s+/);
    const hit = f.cls.filter(c => elCls.includes(c)).length;
    score += hit * 12;
  }
  if (f.text) {
    const t = muElText(el);
    if (t === f.text) score += 40;
    else if (t && (t.includes(f.text) || f.text.includes(t))) score += 20;
  }
  // 順番が一致すればわずかに加点（弱い手がかり）
  if (f.idx != null && el.parentElement) {
    const same = Array.from(el.parentElement.children).filter(s => s.tagName === el.tagName);
    if (same.indexOf(el) === f.idx && same.length === f.total) score += 6;
  }
  return score;
}

// 指紋からページ内の最も近い要素を探す
function findByFingerprint(chain) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const target = chain[0];

  // 候補を絞る：対象要素と同じタグの要素すべて
  let candidates = Array.from(document.querySelectorAll(target.tag));
  if (candidates.length > 4000) return null; // 巨大ページでの暴走防止

  let best = null, bestScore = -1;
  for (const el of candidates) {
    if ((el.id || '').startsWith('mu-') || el.closest('#mu-overlay,#mu-toolbar,#mu-nav')) continue;
    let score = muScoreNode(el, target);
    if (score < 0) continue;
    // 先祖もたどって一致を確認（構造のズレに強くするため、
    // 親が完全一致しなくても祖父が合えば加点していく）
    let anc = el.parentElement;
    for (let i = 1; i < chain.length && anc; i++) {
      // 数段ぶん上に向かって、一番合う先祖を探す
      let ancBest = -1, hops = 0, probe = anc;
      while (probe && hops < 3) {
        const s = muScoreNode(probe, chain[i]);
        if (s > ancBest) ancBest = s;
        probe = probe.parentElement;
        hops++;
      }
      if (ancBest > 0) score += ancBest * 0.4; // 先祖の一致は弱めに反映
      anc = anc.parentElement;
    }
    if (score > bestScore) { bestScore = score; best = el; }
  }
  // 最低限の確からしさがある場合のみ採用
  // （対象タグ一致＋テキストか属性かIDのどれかが合っている水準）
  return bestScore >= 25 ? best : null;
}

// ============================================================
// ★ 新方式A：テキストアンカー方式
// ------------------------------------------------------------
// 「クリックした要素そのもの」を探すのをやめ、クリック地点の近くに
// “実際に画面に表示されている文章”を目印（アンカー）として記録する。
// 文章の中身は画面幅が変わっても基本そのまま残るので、
// クラス名やDOM階層が総入れ替えになっても目印を再発見できる。
// 復元時は「目印の文章」を探し、そこからの位置関係でピンを置き直す。
// ============================================================

// 画面に見えている「地の文」テキストノードを集める。
// （短すぎる文字・スクリプト類・非表示要素・拡張機能自身のUIは除外）
function muCollectTextAnchors() {
  const anchors = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (txt.length < 5) return NodeFilter.FILTER_REJECT;       // 短すぎる文字は目印にならない
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if ((p.id || '').startsWith('mu-') || p.closest('#mu-overlay,#mu-toolbar,#mu-nav')) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    if (anchors.length > 6000) break; // 巨大ページでの暴走防止
    const range = document.createRange();
    range.selectNodeContents(n);
    const rect = range.getBoundingClientRect();
    if (rect.width + rect.height === 0) continue; // 非表示
    const txt = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
    anchors.push({
      text: txt.length > 120 ? txt.slice(0, 120) : txt,
      cx: rect.left + rect.width / 2 + window.pageXOffset,
      cy: rect.top + rect.height / 2 + window.pageYOffset
    });
  }
  return anchors;
}

// クリック地点の周辺にある文章アンカーを最大3つ選び、
// ピンとの位置関係（縦のズレ・横のズレ）を記録する。
function buildTextAnchors(pageX, pageY) {
  const all = muCollectTextAnchors();
  if (!all.length) return null;
  // クリック地点に近い順に並べる
  all.sort((a, b) => {
    const da = (a.cx - pageX) ** 2 + (a.cy - pageY) ** 2;
    const db = (b.cx - pageX) ** 2 + (b.cy - pageY) ** 2;
    return da - db;
  });
  const picked = [];
  const seen = new Set();
  for (const a of all) {
    if (seen.has(a.text)) continue; // 同じ文言は1つだけ（ナビの繰り返しなどを避ける）
    seen.add(a.text);
    picked.push({ text: a.text, dx: Math.round(pageX - a.cx), dy: Math.round(pageY - a.cy) });
    if (picked.length >= 3) break;
  }
  return picked.length ? picked : null;
}

// 文章アンカーからピンのページ座標を復元する。
// 記録した複数の目印それぞれが指す座標を求め、平均してブレを抑える。
// ページ内に同じ文言が複数ある場合は、各目印が示す座標が
// 互いに近いものだけを採用する（多数決）。
function findByTextAnchors(textAnchors) {
  if (!Array.isArray(textAnchors) || !textAnchors.length) return null;
  const all = muCollectTextAnchors();
  if (!all.length) return null;
  const byText = new Map();
  for (const a of all) {
    if (!byText.has(a.text)) byText.set(a.text, []);
    byText.get(a.text).push(a);
  }
  // 各目印が指す候補座標を集める
  const guesses = [];
  for (const ta of textAnchors) {
    let hits = byText.get(ta.text);
    if (!hits) {
      // 完全一致がなければ前方一致でゆるく探す（文章が一部編集された場合の保険）
      for (const [txt, list] of byText) {
        if (txt.startsWith(ta.text.slice(0, 20)) || ta.text.startsWith(txt.slice(0, 20))) { hits = list; break; }
      }
    }
    if (!hits || !hits.length) continue;
    // 同じ文言が複数あるときは全候補を出しておき、後でまとまりを見る
    for (const h of hits) guesses.push({ x: h.cx + ta.dx, y: h.cy + ta.dy });
  }
  if (!guesses.length) return null;
  if (guesses.length === 1) return { pageX: guesses[0].x, pageY: guesses[0].y };
  // 互いに近い候補同士でいちばん大きなまとまりを探す（多数決）
  let bestCluster = [];
  for (const g of guesses) {
    const cluster = guesses.filter(o =>
      Math.abs(o.x - g.x) < 60 && Math.abs(o.y - g.y) < 60);
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }
  const use = bestCluster.length ? bestCluster : guesses;
  const avgX = use.reduce((s, g) => s + g.x, 0) / use.length;
  const avgY = use.reduce((s, g) => s + g.y, 0) / use.length;
  return { pageX: avgX, pageY: avgY };
}

// ============================================================
// ★ 新方式B：セマンティックコンテナ内 % 方式
// ------------------------------------------------------------
// section / article / main などの「意味のかたまり」を
// クリック地点から一番内側に向かって探し、その“箱の中での相対位置”を
// 縦横の％で記録する。箱の中のレイアウトが組み変わっても、
// 箱そのものの境界は保たれやすいので位置がずれにくい。
// 見出しと違い、ほぼすべてのモダンサイトにこの「箱」が存在する。
// ============================================================

const MU_CONTAINER_TAGS = ['SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FORM', 'LI', 'FIGURE'];

// ページ内のセマンティックコンテナを、出現順に番号付きで集める
function muCollectContainers() {
  const sel = MU_CONTAINER_TAGS.map(t => t.toLowerCase()).join(',');
  const list = [];
  for (const el of document.querySelectorAll(sel)) {
    if ((el.id || '').startsWith('mu-') || el.closest('#mu-overlay,#mu-toolbar,#mu-nav')) continue;
    list.push(el);
  }
  return list;
}

// クリックした要素を含む「一番内側のコンテナ」を選び、
// そのコンテナ内での相対位置(%)と、コンテナを後で再発見するための情報を記録する。
function buildContainerAnchor(target, pageX, pageY) {
  let cur = target;
  let container = null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (MU_CONTAINER_TAGS.includes(cur.tagName)) { container = cur; break; }
    cur = cur.parentElement;
  }
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (rect.width + rect.height === 0) return null;
  const all = muCollectContainers();
  const sameTag = all.filter(c => c.tagName === container.tagName);
  return {
    tag: container.tagName.toLowerCase(),
    // 同じタグのコンテナの中で何番目か（全体での順番）
    tagIndex: sameTag.indexOf(container),
    tagTotal: sameTag.length,
    // 全コンテナ通しでの順番（タグ構成が変わった時の保険）
    allIndex: all.indexOf(container),
    // コンテナを内容で見分けるための短いテキスト指紋
    sig: muElText(container).slice(0, 60),
    // 箱の中での相対位置（％）
    xPct: rect.width  > 0 ? ((pageX - (rect.left + window.pageXOffset)) / rect.width)  * 100 : 50,
    yPct: rect.height > 0 ? ((pageY - (rect.top  + window.pageYOffset)) / rect.height) * 100 : 50
  };
}

// コンテナアンカーからピンのページ座標を復元する。
// まず同じ種類・同じ順番の箱を探し、ダメなら内容（テキスト指紋）で見分ける。
function findByContainerAnchor(ca) {
  if (!ca || !ca.tag) return null;
  const all = muCollectContainers();
  if (!all.length) return null;
  const sameTag = all.filter(c => c.tagName === ca.tag.toUpperCase());
  let container = null;

  // (1) 同じタグ構成が保たれていれば、同じ順番の箱をそのまま使う
  if (ca.tagTotal != null && sameTag.length === ca.tagTotal && ca.tagIndex < sameTag.length) {
    container = sameTag[ca.tagIndex];
  }
  // (2) 箱の数が変わっていたら、内容（テキスト指紋）が一番似た箱を選ぶ
  if (!container && ca.sig) {
    let best = null, bestScore = 0;
    for (const c of sameTag.length ? sameTag : all) {
      const s = muElText(c).slice(0, 60);
      if (!s) continue;
      let score = 0;
      if (s === ca.sig) score = 100;
      else if (s.startsWith(ca.sig.slice(0, 20)) || ca.sig.startsWith(s.slice(0, 20))) score = 50;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) container = best;
  }
  // (3) それでもダメなら通し番号で
  if (!container && ca.allIndex != null && ca.allIndex < all.length) {
    container = all[ca.allIndex];
  }
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  if (rect.width + rect.height === 0) return null;
  return {
    pageX: rect.left + window.pageXOffset + (ca.xPct / 100) * rect.width,
    pageY: rect.top  + window.pageYOffset + (ca.yPct / 100) * rect.height
  };
}

// ピンのページ座標を返す（複数の手がかりを順に試す）
function getPinPagePosition(comment) {
  if (comment.element_selector) {
    let anchor;
    try { anchor = JSON.parse(comment.element_selector); } catch (_) { anchor = { sel: comment.element_selector }; }

    // ① 主セレクタ（ID付きなど、決まれば最も速くて正確）
    const el = tryQuerySelector(anchor.sel);
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width + rect.height > 0) return elPos(rect, comment);
    }

    // ★② テキストアンカー方式：クリック地点近くの「表示されている文章」を
    //    目印にして位置を復元。DOM構造やクラス名が変わっても文章は残るので強い。
    if (anchor.textAnchors) {
      const pos = findByTextAnchors(anchor.textAnchors);
      if (pos) return pos;
    }

    // ★③ セマンティックコンテナ内%方式：section等の「意味の箱」の中での
    //    相対位置で復元。箱の中のレイアウトが組み変わっても境界は保たれやすい。
    if (anchor.container) {
      const pos = findByContainerAnchor(anchor.container);
      if (pos) return pos;
    }

    // ④ 指紋（fingerprint）方式：要素の中身・属性でページ内を探す。
    //    画面幅が違って並び順や階層がズレても「同じ中身の要素」を見つけられる。
    if (anchor.fp) {
      const found = findByFingerprint(anchor.fp);
      if (found) {
        const rect = found.getBoundingClientRect();
        if (rect.width + rect.height > 0) return elPos(rect, comment);
      }
    }

    // ⑤ 外側を1段ずつ省いたセレクタを順番に試す（旧コメント向けの保険）
    for (const s of (anchor.relaxed || [])) {
      const rel = tryQuerySelector(s);
      if (rel) {
        const rect = rel.getBoundingClientRect();
        if (rect.width + rect.height > 0) return elPos(rect, comment);
      }
    }

    // ⑥ 見出しアンカー：見出しからの距離を「その見出しの次の見出しまでの区間」の
    //    割合に変換して復元する。px固定ではなく比率にすることで、
    //    レスポンシブで段組みが変わって区間の高さが伸縮しても追従しやすい。
    if (anchor.anchor != null && anchor.anchorDY != null) {
      const h = tryQuerySelector(anchor.anchor);
      if (h) {
        const { w } = overlayDims();
        const hBottom = h.getBoundingClientRect().bottom + window.pageYOffset;
        let pageY;
        if (anchor.anchorRatio != null && anchor.anchorSpan != null) {
          // 保存時の区間の高さと現在の区間の高さの比で距離をスケール
          const curSpan = muHeadingSpan(h);
          const scale = (curSpan > 0 && anchor.anchorSpan > 0) ? curSpan / anchor.anchorSpan : 1;
          pageY = hBottom + anchor.anchorDY * scale;
        } else {
          pageY = hBottom + anchor.anchorDY;
        }
        return { pageX: (comment.x_percent / 100) * w, pageY };
      }
    }
  }

  // ⑦ ページ % フォールバック
  const { w, h } = overlayDims();
  return { pageX: (comment.x_percent / 100) * w, pageY: (comment.y_percent / 100) * h };
}

// 見出しから「次の見出しまで」の縦の距離を返す（区間の高さ）
function muHeadingSpan(h) {
  const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const hTop = h.getBoundingClientRect().top + window.pageYOffset;
  let nextTop = Infinity;
  for (const other of all) {
    if (other === h) continue;
    const t = other.getBoundingClientRect().top + window.pageYOffset;
    if (t > hTop && t < nextTop) nextTop = t;
  }
  if (nextTop === Infinity) {
    const { h: pageH } = overlayDims();
    nextTop = pageH;
  }
  return nextTop - hTop;
}

function elPos(rect, comment) {
  return {
    pageX: rect.left + window.pageXOffset + ((comment.el_x_pct ?? 0) / 100) * rect.width,
    pageY: rect.top  + window.pageYOffset + ((comment.el_y_pct ?? 0) / 100) * rect.height
  };
}

function tryQuerySelector(sel) {
  if (!sel) return null;
  try { return document.querySelector(sel); } catch (_) { return null; }
}

// セレクタを段階的に緩めた候補リストを返す（外側から1段ずつ削る）
function getRelaxedSelectors(selector) {
  const parts = selector.split(' > ');
  const result = [];
  for (let skip = 1; skip < parts.length - 1; skip++) {
    result.push(parts.slice(skip).join(' > '));
  }
  return result;
}

// クリック位置より上にある最近傍の見出し要素を返す
function findNearestHeading(pageY) {
  let nearest = null, nearestBottom = -Infinity;
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const bottom = h.getBoundingClientRect().bottom + window.pageYOffset;
    if (bottom <= pageY && bottom > nearestBottom) { nearestBottom = bottom; nearest = h; }
  }
  return nearest;
}

// サイト固有の fixed ヘッダーを検出して 48px 押し下げる
function pushDownFixedElements() {
  MU_SITE_FIXED = [];
  const scan = (el, depth) => {
    if (depth > 4 || (el.id || '').startsWith('mu-')) return;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' && parseFloat(s.top) < 5 && parseFloat(s.zIndex || 0) < 2147483644) {
      MU_SITE_FIXED.push({ el, origTop: el.style.top });
      el.style.setProperty('top', (parseFloat(s.top) + 48) + 'px', 'important');
      return;
    }
    [...el.children].forEach(c => scan(c, depth + 1));
  };
  [...document.body.children].forEach(el => scan(el, 0));
}

function restoreFixedElements() {
  MU_SITE_FIXED.forEach(({ el, origTop }) => { el.style.top = origTop; });
  MU_SITE_FIXED = [];
}

function pushRightFixedElements() {
  MU_SITE_FIXED_RIGHT = [];
  const scan = (el, depth) => {
    if (depth > 4 || (el.id || '').startsWith('mu-')) return;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' && parseFloat(s.left) < 5 && parseFloat(s.zIndex || 0) < 2147483644) {
      MU_SITE_FIXED_RIGHT.push({ el, origLeft: el.style.left });
      el.style.setProperty('left', (parseFloat(s.left) + 52) + 'px', 'important');
      return;
    }
    [...el.children].forEach(c => scan(c, depth + 1));
  };
  [...document.body.children].forEach(el => scan(el, 0));
}

function restoreRightFixedElements() {
  MU_SITE_FIXED_RIGHT.forEach(({ el, origLeft }) => { el.style.left = origLeft; });
  MU_SITE_FIXED_RIGHT = [];
}

// 画面幅変更時にすべてのピン位置を再計算
function repositionPins() {
  MU.comments.forEach(comment => {
    const pin = MU.pinElements[comment.id];
    if (!pin) return;
    const { pageX, pageY } = getPinPagePosition(comment);
    pin.style.left = pageX + 'px';
    pin.style.top  = pageY + 'px';
  });
}

function buildUI() {
  ['mu-toolbar', 'mu-overlay'].forEach(id => document.getElementById(id)?.remove());
  if (MU.toolbarMode === 'side') {
    buildSideUI();
  } else {
    buildTopUI();
  }
  const overlay = document.createElement('div');
  overlay.id = 'mu-overlay';
  document.body.appendChild(overlay);
  syncOverlaySize();
  window.addEventListener('resize', syncOverlaySize);
  overlay.classList.add('mu-cross');
  overlay.addEventListener('click', onOverlayClick);
  buildNav();
}

function buildTopUI() {
  const toolbar = document.createElement('div');
  toolbar.id = 'mu-toolbar';
  toolbar.className = 'mu-toolbar-top';
  toolbar.innerHTML = `
    <div class="mu-left">
      <span class="mu-logo">Mark Upper</span>
      <button class="mu-user-btn" id="mu-user-btn">👤 ${MU.userName ? escHtml(MU.userName) : '使用する名前を入力'}</button>
      <button class="mu-clr-btn" id="mu-clr-btn">全コメント削除</button>
    </div>
    <div class="mu-center">
      <div class="mu-seg">
        <button class="mu-seg-btn${MU.device === 'pc' ? ' mu-seg-on' : ''}" id="mu-dev-pc">💻 PC</button>
        <button class="mu-seg-btn${MU.device === 'mobile' ? ' mu-seg-on' : ''}" id="mu-dev-mobile">📱 Mobile</button>
      </div>
      <button class="mu-seg-btn mu-fixw-btn${MU.fixedWidth ? ' mu-seg-on' : ''}" id="mu-fixw-btn">📐 幅固定</button>
    </div>
    <div class="mu-right">
      <div class="mu-counts" id="mu-counts"></div>
      <button class="mu-btn mu-switch-btn" id="mu-switch-btn" title="サイドバーに切り替え">⇄</button>
      <button class="mu-btn mu-off-btn" id="mu-off-btn">✕ 終了</button>
    </div>`;
  document.body.appendChild(toolbar);
  bindCommonButtons();
  document.getElementById('mu-switch-btn').addEventListener('click', () => switchToolbarMode('side'));
}

function buildSideUI() {
  const toolbar = document.createElement('div');
  toolbar.id = 'mu-toolbar';
  toolbar.className = 'mu-toolbar-side';
  toolbar.innerHTML = `
    <div class="mu-side-logo">MU</div>
    <button class="mu-side-btn" id="mu-switch-btn" data-label="横ツールバーに切り替え">⇄</button>
    <div class="mu-side-sep"></div>
    <button class="mu-side-btn${MU.device === 'pc' ? ' mu-side-on' : ''}" id="mu-dev-pc" data-label="PC表示">💻</button>
    <button class="mu-side-btn${MU.device === 'mobile' ? ' mu-side-on' : ''}" id="mu-dev-mobile" data-label="Mobile表示">📱</button>
    <button class="mu-side-btn${MU.fixedWidth ? ' mu-side-on' : ''}" id="mu-fixw-btn" data-label="幅固定">📐</button>
    <div class="mu-side-sep"></div>
    <div class="mu-side-counts" id="mu-counts"></div>
    <div class="mu-side-spacer"></div>
    <button class="mu-side-btn" id="mu-user-btn" data-label="${MU.userName ? escHtml(MU.userName) : '名前を入力'}">👤</button>
    <button class="mu-side-btn mu-side-clr" id="mu-clr-btn" data-label="全コメント削除">🗑</button>
    <button class="mu-side-btn mu-side-off" id="mu-off-btn" data-label="終了">✕</button>`;
  document.body.appendChild(toolbar);
  bindCommonButtons();
  document.getElementById('mu-switch-btn').addEventListener('click', () => switchToolbarMode('top'));
}

function bindCommonButtons() {
  document.getElementById('mu-off-btn').addEventListener('click', deactivate);
  document.getElementById('mu-user-btn').addEventListener('click', openNameEditor);
  document.getElementById('mu-clr-btn').addEventListener('click', async () => {
    if (!confirm('このページの全コメントを削除しますか？（PC・Mobile両方）\nこの操作は元に戻せません。')) return;
    await sb_deleteAllComments(window.location.href);
    Object.values(MU.pinElements).forEach(el => el.remove());
    MU.pinElements = {};
    MU.comments = [];
    MU_CACHE.pc = null;
    MU_CACHE.mobile = null;
    updateBadge();
    closePopover();
  });
  document.getElementById('mu-dev-pc').addEventListener('click', () => setDevice('pc'));
  document.getElementById('mu-dev-mobile').addEventListener('click', () => setDevice('mobile'));
  document.getElementById('mu-fixw-btn').addEventListener('click', toggleFixedWidth);
}

function switchToolbarMode(mode) {
  document.getElementById('mu-offset')?.remove();
  if (MU.toolbarMode === 'side') {
    restoreRightFixedElements();
  } else {
    restoreFixedElements();
  }
  MU.toolbarMode = mode;
  chrome.storage.local.set({ mu_toolbar_mode: mode });
  if (mode === 'side') {
    const current = parseInt(getComputedStyle(document.body).marginLeft) || 0;
    const style = document.createElement('style');
    style.id = 'mu-offset';
    style.textContent = `body{margin-left:${current + 52}px!important}`;
    document.head.appendChild(style);
    pushRightFixedElements();
  } else {
    const current = parseInt(getComputedStyle(document.body).marginTop) || 0;
    const style = document.createElement('style');
    style.id = 'mu-offset';
    style.textContent = `body{margin-top:${current + 48}px!important}`;
    document.head.appendChild(style);
    pushDownFixedElements();
  }
  document.getElementById('mu-toolbar')?.remove();
  if (mode === 'side') {
    buildSideUI();
  } else {
    buildTopUI();
  }
  updateBadge();
}

function openNameEditor() {
  if (document.getElementById('mu-name-inp') || document.getElementById('mu-name-panel')) return;

  if (MU.toolbarMode === 'side') {
    const btn = document.getElementById('mu-user-btn');
    const btnRect = btn ? btn.getBoundingClientRect() : { top: 100 };
    const panel = document.createElement('div');
    panel.id = 'mu-name-panel';
    panel.className = 'mu-name-panel';
    panel.style.top = btnRect.top + 'px';
    panel.innerHTML = `
      <input type="text" id="mu-name-inp" class="mu-name-inp"
        value="${escHtml(MU.userName)}" placeholder="使用する名前を入力" maxlength="20">
      <button class="mu-btn mu-sub" id="mu-name-ok">確定</button>`;
    document.body.appendChild(panel);
    const inp = document.getElementById('mu-name-inp');
    inp.focus();
    if (MU.userName) inp.select();
    const commit = () => {
      const name = inp.value.trim();
      if (name && name !== MU.userName) {
        MU.userName = name;
        chrome.storage.local.set({ mu_username: name });
        sb_addMember(name);
        const userBtn = document.getElementById('mu-user-btn');
        if (userBtn) userBtn.dataset.label = name;
      }
      panel.remove();
    };
    document.getElementById('mu-name-ok').addEventListener('click', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { inp.value = MU.userName; commit(); }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => { if (document.getElementById('mu-name-panel')) commit(); }, 150);
    });
    return;
  }

  const btn = document.getElementById('mu-user-btn');
  if (!btn) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.id = 'mu-name-inp';
  inp.className = 'mu-name-inp';
  inp.value = MU.userName;
  inp.placeholder = '使用する名前を入力';
  inp.maxLength = 20;
  btn.replaceWith(inp);
  inp.focus();
  if (MU.userName) inp.select();

  const commit = () => {
    const name = inp.value.trim();
    if (name && name !== MU.userName) {
      MU.userName = name;
      chrome.storage.local.set({ mu_username: name });
      sb_addMember(name);
    }
    const newBtn = document.createElement('button');
    newBtn.className = 'mu-user-btn';
    newBtn.id = 'mu-user-btn';
    newBtn.textContent = `👤 ${MU.userName || '使用する名前を入力'}`;
    inp.replaceWith(newBtn);
    newBtn.addEventListener('click', openNameEditor);
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { inp.value = MU.userName; commit(); }
  });
}

function onOverlayClick(e) {
  if (e.target !== document.getElementById('mu-overlay')) return;
  if (MU_DRAG) return; // ドラッグ操作中・直後のクリックは無視
  if (document.getElementById('mu-popover')) {
    if (!isFormDirty()) closePopover();
    return;
  }
  const { w, h } = overlayDims();
  const pageX = e.clientX + window.pageXOffset;
  const pageY = e.clientY + window.pageYOffset;

  if (!MU.userName) {
    showCursorAlert(pageX, pageY, '👤 先に名前を入力してください');
    openNameEditor();
    return;
  }
  const xPct = (pageX / w) * 100;
  const yPct = (pageY / h) * 100;

  // オーバーレイを一時的に無効化して真下の要素を取得
  const overlay = document.getElementById('mu-overlay');
  overlay.style.pointerEvents = 'none';
  const target = document.elementFromPoint(e.clientX, e.clientY);
  overlay.style.pointerEvents = '';

  const elementData = buildElementData(target, pageX, pageY);

  openCommentForm(xPct, yPct, pageX, pageY, elementData);
}

// あるページ座標（pageX,pageY）と、その真下の要素（target）から、
// ピンの位置を保存・復元するためのアンカー情報一式を組み立てる。
// 新規コメント作成時にもピンのドラッグ移動時にも共通で使う。
function buildElementData(target, pageX, pageY) {
  if (!target || target === document.body || target === document.documentElement) return null;
  const rect = target.getBoundingClientRect();
  const sel = getCssSelector(target);
  const anchorData = { sel, fp: buildFingerprint(target), relaxed: getRelaxedSelectors(sel) };
  // ★テキストアンカー：クリック地点の近くの「表示されている文章」を目印に保存。
  //   これが新しい復元の主役。文章はDOM構造が変わっても残るので最も安定。
  const textAnchors = buildTextAnchors(pageX, pageY);
  if (textAnchors) anchorData.textAnchors = textAnchors;
  // ★コンテナアンカー：section等の「意味の箱」の中での相対位置(%)を保存。
  const container = buildContainerAnchor(target, pageX, pageY);
  if (container) anchorData.container = container;
  const heading = findNearestHeading(pageY);
  if (heading) {
    anchorData.anchor = getCssSelector(heading);
    anchorData.anchorDY = Math.round(pageY - (heading.getBoundingClientRect().bottom + window.pageYOffset));
    // 見出し区間の高さも保存し、復元時に比率でスケールできるようにする
    anchorData.anchorSpan = Math.round(muHeadingSpan(heading));
    anchorData.anchorRatio = anchorData.anchorSpan > 0 ? anchorData.anchorDY / anchorData.anchorSpan : 0;
  }
  return {
    element_selector: JSON.stringify(anchorData),
    el_x_pct: rect.width  > 0 ? ((pageX - (rect.left + window.pageXOffset)) / rect.width)  * 100 : 0,
    el_y_pct: rect.height > 0 ? ((pageY - (rect.top  + window.pageYOffset)) / rect.height) * 100 : 0
  };
}

// ポップオーバーをページ座標に表示
function showPopover(pageX, pageY, html) {
  document.getElementById('mu-popover')?.remove();
  const overlay = document.getElementById('mu-overlay');

  const pop = document.createElement('div');
  pop.id = 'mu-popover';
  pop.className = 'mu-pop';
  pop.innerHTML = html;
  overlay.appendChild(pop);
  overlay.classList.add('mu-pop-open');

  const OFFSET = 16;
  pop.style.left = (pageX + OFFSET) + 'px';
  pop.style.top  = (pageY + OFFSET) + 'px';

  // 画面端からはみ出す場合に反転
  requestAnimationFrame(() => {
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sl = window.pageXOffset;
    const st = window.pageYOffset;

    let left = pageX + OFFSET;
    let top  = pageY + OFFSET;
    if (left + popW - sl > vw - 8) left = pageX - popW - OFFSET;
    if (top  + popH - st > vh - 8) top  = pageY - popH - OFFSET;

    const minLeft = MU.toolbarMode === 'side' ? Math.max(sl + 62, left) : Math.max(sl + 4, left);
    pop.style.left = minLeft + 'px';
    pop.style.top  = Math.max(st + 52, top) + 'px'; // ツールバー分を避ける
  });

  // ホバーで閉じる動作（ピンとポップオーバー間の移動に対応）
  pop.addEventListener('mouseenter', clearHoverTimer);
  pop.addEventListener('mouseleave', startHoverClose);

  return pop;
}

function showCursorAlert(pageX, pageY, message) {
  document.getElementById('mu-cursor-alert')?.remove();
  const overlay = document.getElementById('mu-overlay');
  if (!overlay) return;
  const el = document.createElement('div');
  el.id = 'mu-cursor-alert';
  el.className = 'mu-cursor-alert';
  el.textContent = message;
  overlay.appendChild(el);
  el.style.left = (pageX + 14) + 'px';
  el.style.top  = (pageY - 38) + 'px';
  setTimeout(() => el.remove(), 2500);
}

function closePopover() {
  document.getElementById('mu-popover')?.remove();
  document.getElementById('mu-overlay')?.classList.remove('mu-pop-open');
  Object.values(MU.pinElements).forEach(p => p.classList.remove('mu-sel'));
  MU.selectedId = null;
  MU_OBJECT_URLS.forEach(u => URL.revokeObjectURL(u));
  MU_OBJECT_URLS = [];
}

function clearHoverTimer() { clearTimeout(MU_HOVER_TIMER); }

// フォームに未送信の内容（テキスト or 添付 or ファイル選択中）があるか確認
function isFormDirty() {
  if (MU_FILE_OPEN) return true;
  const hasText = !!(document.getElementById('mu-new-text')?.value.trim() ||
                     document.getElementById('mu-reply-text')?.value.trim());
  const hasFile = (document.getElementById('mu-new-prev')?.children.length > 0) ||
                  (document.getElementById('mu-reply-prev')?.children.length > 0);
  return hasText || hasFile;
}

// ファイル選択ダイアログが開いている間は閉じないようにする
function lockForFilePicker(inputEl) {
  MU_FILE_OPEN = true;
  const release = () => setTimeout(() => { MU_FILE_OPEN = false; }, 300);
  inputEl.addEventListener('change', () => { MU_FILE_OPEN = false; }, { once: true });
  window.addEventListener('focus', release, { once: true });
}

function startHoverClose() {
  if (isFormDirty()) return;
  MU_HOVER_TIMER = setTimeout(() => closePopover(), 200);
}

// 新規コメント入力フォームをポップオーバーで表示
function openCommentForm(xPct, yPct, pageX, pageY, elementData) {
  showPopover(pageX, pageY, `
    <div class="mu-pop-hdr">
      <span class="mu-pop-ttl">新しいコメント</span>
      <button class="mu-pop-x" id="mu-pop-x">✕</button>
    </div>
    <div class="mu-pop-body">
      <textarea class="mu-ta" id="mu-new-text" placeholder="コメントを入力… @名前でメンション"></textarea>
      <div class="mu-dd" id="mu-new-dd"></div>
      <div class="mu-prev" id="mu-new-prev"></div>
      <div id="mu-send-err" class="mu-err"></div>
      <div class="mu-fa">
        <button class="mu-btn mu-img-btn" id="mu-new-attach-btn">📎 添付</button>
        <input type="file" id="mu-new-img" style="display:none">
        <button class="mu-btn mu-sub" id="mu-new-submit">送信</button>
      </div>
    </div>`);

  // 新規コメントフォームはホバーで閉じない
  const pop = document.getElementById('mu-popover');
  pop.removeEventListener('mouseleave', startHoverClose);

  document.getElementById('mu-pop-x').addEventListener('click', closePopover);
  document.getElementById('mu-new-text').focus();

  let members = [], pendingImages = [];
  sb_getMembers().then(m => { members = m || []; });

  setupMention('mu-new-text', 'mu-new-dd', () => members, (name) => {
    const ta = document.getElementById('mu-new-text');
    const at = ta.value.lastIndexOf('@');
    ta.value = ta.value.slice(0, at) + '@' + name + ' ';
    document.getElementById('mu-new-dd').style.display = 'none';
    ta.focus();
  });

  const newImgInp = document.getElementById('mu-new-img');
  document.getElementById('mu-new-attach-btn').addEventListener('click', () => {
    lockForFilePicker(newImgInp);
    newImgInp.click();
  });
  newImgInp.addEventListener('change', (e) => {
    MU_FILE_OPEN = false;
    const file = e.target.files[0];
    if (!file) return;
    const err = document.getElementById('mu-send-err');
    if (file.size > MU_MAX_FILE) {
      if (err) err.textContent = `ファイルが10MBを超えています（${(file.size/1024/1024).toFixed(1)}MB）`;
      e.target.value = '';
      return;
    }
    if (err) err.textContent = '';
    pendingImages.push(file);
    addImgThumb('mu-new-prev', file);
  });

  document.getElementById('mu-new-submit').addEventListener('click', async () => {
    const text = document.getElementById('mu-new-text').value.trim();
    if (!text) return;
    const btn = document.getElementById('mu-new-submit');
    btn.disabled = true;
    btn.textContent = '送信中…';

    const result = await sb_addComment({
      site_url: window.location.href,
      x_percent: xPct, y_percent: yPct,
      ...(elementData || {}),
      text, author: MU.userName, assignee: extractMention(text),
      status: 'open', device: MU.device, image_paths: []
    });

    if (!result || !result[0]) {
      btn.disabled = false; btn.textContent = '送信';
      const err = document.getElementById('mu-send-err');
      if (err) err.textContent = '送信に失敗しました。再度お試しください。';
      return;
    }
    const newComment = result[0];

    try {
      if (pendingImages.length > 0) {
        const paths = [];
        for (const f of pendingImages) paths.push(await sb_uploadImage(f, newComment.id));
        await sb_updateImagePaths(newComment.id, paths);
        newComment.image_paths = paths;
      }
    } catch (_) {}

    MU.comments.push(newComment);
    MU_READ_IDS.add(newComment.id);
    chrome.storage.local.set({ [readKey()]: [...MU_READ_IDS] });
    addPin(newComment);
    updateBadge();
    closePopover();
  });
}

// ピンホバー時：コメント詳細をポップオーバーで表示
async function openCommentDetail(comment, pageX, pageY) {
  const seq = ++MU_DETAIL_SEQ;
  MU.selectedId = comment.id;
  Object.values(MU.pinElements).forEach(p => p.classList.remove('mu-sel'));
  MU.pinElements[comment.id]?.classList.add('mu-sel');

  // 未読→既読マーク（ローカル保存）
  if (!MU_READ_IDS.has(comment.id)) {
    MU_READ_IDS.add(comment.id);
    chrome.storage.local.set({ [readKey()]: [...MU_READ_IDS] });
    MU.pinElements[comment.id]?.classList.remove('mu-unread');
  }

  const replies = (await sb_getReplies(comment.id)) || [];
  if (seq !== MU_DETAIL_SEQ) return; // 新しいリクエストに追い越された場合は中断
  const num = MU.comments.findIndex(c => c.id === comment.id) + 1;
  const stLabel = { open: '未対応', fixed: '対応済', verified: '確認完了', rejected: '差し戻し' };
  const stTrans = {
    open:     [{ to: 'fixed',    label: '対応済にする' }],
    fixed:    [{ to: 'verified', label: '確認完了にする' }, { to: 'rejected', label: '差し戻す' }],
    verified: [{ to: 'open',     label: '未対応に戻す'  }, { to: 'rejected', label: '差し戻す' }],
    rejected: [{ to: 'fixed',    label: '再対応済にする' }]
  };
  const transHtml = (stTrans[comment.status] || [])
    .map(t => `<button class="mu-st-btn mu-st-to-${t.to}" data-id="${comment.id}" data-next="${t.to}">${t.label}</button>`)
    .join('');

  const repliesHtml = replies.map(r => `
    <div class="mu-reply-card">
      <div class="mu-meta">
        <span class="mu-author">${escHtml(r.author)}</span>
        ${r.assignee ? `<span class="mu-to">→ @${escHtml(r.assignee)}</span>` : ''}
      </div>
      <div class="mu-text">${escHtml(r.text)}</div>
      ${attachmentHtml(r.image_paths)}
    </div>`).join('');

  showPopover(pageX, pageY, `
    <div class="mu-pop-hdr">
      <div class="mu-hdr-left">
        <span class="mu-pop-ttl">コメント #${num}</span>
        <span class="mu-hdr-st mu-st-${comment.status}">${stLabel[comment.status]}</span>
      </div>
      <button class="mu-pop-x" id="mu-pop-x">✕</button>
    </div>
    <div class="mu-pop-scroll">
      <div class="mu-main-card">
        <div class="mu-meta">
          <span class="mu-author">${escHtml(comment.author)}</span>
          ${comment.assignee ? `<span class="mu-to">→ @${escHtml(comment.assignee)}</span>` : ''}
        </div>
        <div class="mu-text">${escHtml(comment.text)}</div>
        ${attachmentHtml(comment.image_paths)}
        <div class="mu-acts">
          ${transHtml}
          ${comment.author === MU.userName ? `<button class="mu-del-btn" id="mu-del-btn" data-id="${comment.id}">🗑 削除</button>` : ''}
        </div>
      </div>
      ${repliesHtml ? `<div class="mu-replies">${repliesHtml}</div>` : ''}
      <div class="mu-rform">
        <textarea class="mu-ta" id="mu-reply-text" placeholder="返信を入力…"></textarea>
        <div class="mu-dd" id="mu-reply-dd"></div>
        <div class="mu-prev" id="mu-reply-prev"></div>
        <div id="mu-reply-err" class="mu-err"></div>
        <div class="mu-fa">
          <button class="mu-btn mu-img-btn" id="mu-reply-attach-btn">📎 添付</button>
          <input type="file" id="mu-reply-img" style="display:none">
          <button class="mu-btn mu-sub" id="mu-reply-submit">返信</button>
        </div>
      </div>
    </div>`);

  document.getElementById('mu-pop-x').addEventListener('click', closePopover);

  document.getElementById('mu-del-btn')?.addEventListener('click', async (e) => {
    if (!confirm('このコメントを削除しますか？（返信も一緒に削除されます）')) return;
    const cid = e.currentTarget.dataset.id;
    await sb_deleteComment(cid);
    MU.comments = MU.comments.filter(c => c.id !== cid);
    MU_CACHE[MU.device] = MU.comments;
    MU.pinElements[cid]?.remove();
    delete MU.pinElements[cid];
    updateBadge();
    closePopover();
  });

  document.querySelectorAll('#mu-popover .mu-cimg').forEach(img => {
    img.addEventListener('click', () => window.open(img.dataset.src));
  });

  document.querySelectorAll('#mu-popover .mu-st-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const newSt = e.currentTarget.dataset.next;
      const cid   = e.currentTarget.dataset.id;
      await sb_updateStatus(cid, newSt);
      const c = MU.comments.find(c => c.id === cid);
      if (c) {
        c.status = newSt;
        const pin = MU.pinElements[cid];
        if (pin) pin.className = `mu-pin mu-pin-${newSt} mu-sel`;
      }
      updateBadge();
      openCommentDetail({ ...comment, status: newSt }, pageX, pageY);
    });
  });

  let replyImages = [], members = [];
  sb_getMembers().then(m => { members = m || []; });

  setupMention('mu-reply-text', 'mu-reply-dd', () => members, (name) => {
    const ta = document.getElementById('mu-reply-text');
    const at = ta.value.lastIndexOf('@');
    ta.value = ta.value.slice(0, at) + '@' + name + ' ';
    document.getElementById('mu-reply-dd').style.display = 'none';
    ta.focus();
  });

  const replyImgInp = document.getElementById('mu-reply-img');
  document.getElementById('mu-reply-attach-btn').addEventListener('click', () => {
    lockForFilePicker(replyImgInp);
    replyImgInp.click();
  });
  replyImgInp.addEventListener('change', (e) => {
    MU_FILE_OPEN = false;
    const file = e.target.files[0];
    if (!file) return;
    const err = document.getElementById('mu-reply-err');
    if (file.size > MU_MAX_FILE) {
      if (err) err.textContent = `ファイルが10MBを超えています（${(file.size/1024/1024).toFixed(1)}MB）`;
      e.target.value = '';
      return;
    }
    if (err) err.textContent = '';
    replyImages.push(file);
    addImgThumb('mu-reply-prev', file);
  });

  document.getElementById('mu-reply-submit').addEventListener('click', async () => {
    const text = document.getElementById('mu-reply-text').value.trim();
    if (!text) return;
    const btn = document.getElementById('mu-reply-submit');
    btn.disabled = true; btn.textContent = '送信中…';

    const result = await sb_addComment({
      site_url: window.location.href,
      x_percent: comment.x_percent, y_percent: comment.y_percent,
      text, author: MU.userName, assignee: extractMention(text),
      status: 'open', device: MU.device, parent_id: comment.id, image_paths: []
    });

    if (!result || !result[0]) {
      btn.disabled = false; btn.textContent = '返信';
      const err = document.getElementById('mu-reply-err');
      if (err) err.textContent = '送信に失敗しました。再度お試しください。';
      return;
    }
    const newReply = result[0];
    if (replyImages.length > 0) {
      const paths = [];
      for (const f of replyImages) paths.push(await sb_uploadImage(f, newReply.id));
      await sb_updateImagePaths(newReply.id, paths);
    }
    openCommentDetail(comment, pageX, pageY);
  });
}

async function loadComments() {
  const comments = await sb_getComments(window.location.href, MU.device);
  MU.comments = comments || [];
  MU_CACHE[MU.device] = MU.comments;
  Object.values(MU.pinElements).forEach(el => el.remove());
  MU.pinElements = {};
  syncOverlaySize();
  MU.comments.forEach(addPin);
  updateBadge();
}

function addPin(comment) {
  const overlay = document.getElementById('mu-overlay');
  if (!overlay) return;

  const num = MU.comments.findIndex(c => c.id === comment.id) + 1;
  const pin = document.createElement('div');
  pin.className = `mu-pin mu-pin-${comment.status}${MU_READ_IDS.has(comment.id) ? '' : ' mu-unread'}`;
  pin.dataset.id = comment.id;

  const { pageX: initX, pageY: initY } = getPinPagePosition(comment);
  pin.style.left = initX + 'px';
  pin.style.top  = initY + 'px';
  pin.innerHTML  = `<span class="mu-pnum">${num}</span>`;

  // ホバーでポップオーバー表示（現在位置を毎回再計算）
  pin.addEventListener('mouseenter', () => {
    if (MU_DRAG) return; // ドラッグ中はポップオーバーを開かない
    clearHoverTimer();
    const { pageX, pageY } = getPinPagePosition(comment);
    openCommentDetail(comment, pageX, pageY);
  });
  pin.addEventListener('mouseleave', startHoverClose);

  // 自分が投稿したコメントのピンだけドラッグ移動できるようにする
  if (comment.author === MU.userName) {
    pin.classList.add('mu-draggable');
    pin.addEventListener('mousedown', (e) => startPinDrag(e, comment, pin));
  }

  overlay.appendChild(pin);
  MU.pinElements[comment.id] = pin;
}

// ---- ピンのドラッグ移動 ----
// マウスダウンで開始、移動中はピンがマウスに追従、マウスアップで確定。
// 確定後はクリック地点の真下の要素から位置情報を作り直してDBへ保存する。
let MU_DRAG = null;

function startPinDrag(e, comment, pin) {
  // 左クリックのみ。自分のコメント以外はそもそもこのリスナーが付かない
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  // ドラッグ開始時点ではまだ「移動」と確定しない（クリックと区別するため）
  MU_DRAG = {
    comment, pin,
    startX: e.clientX, startY: e.clientY,
    moved: false
  };

  // ドラッグ中はホバーのポップオーバーが邪魔なので閉じておく
  clearHoverTimer();
  closePopover();
  pin.classList.add('mu-dragging');

  window.addEventListener('mousemove', onPinDragMove);
  window.addEventListener('mouseup', onPinDragEnd);
}

function onPinDragMove(e) {
  if (!MU_DRAG) return;
  const dx = e.clientX - MU_DRAG.startX;
  const dy = e.clientY - MU_DRAG.startY;
  // 数px動いて初めて「ドラッグ」とみなす（誤クリックでの移動を防ぐ）
  if (!MU_DRAG.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  MU_DRAG.moved = true;

  // ピンをマウス位置（ページ座標）に追従させる
  const pageX = e.clientX + window.pageXOffset;
  const pageY = e.clientY + window.pageYOffset;
  MU_DRAG.pin.style.left = pageX + 'px';
  MU_DRAG.pin.style.top  = pageY + 'px';
}

async function onPinDragEnd(e) {
  const drag = MU_DRAG;
  window.removeEventListener('mousemove', onPinDragMove);
  window.removeEventListener('mouseup', onPinDragEnd);
  if (!drag) return;
  drag.pin.classList.remove('mu-dragging');

  // ほとんど動いていなければ移動とみなさない（ホバー表示はそのまま使える）
  if (!drag.moved) { MU_DRAG = null; return; }

  const pageX = e.clientX + window.pageXOffset;
  const pageY = e.clientY + window.pageYOffset;
  const { w, h } = overlayDims();
  const xPct = (pageX / w) * 100;
  const yPct = (pageY / h) * 100;

  // ピンの真下にある要素を取得（オーバーレイは一時的に透過させる）
  const overlay = document.getElementById('mu-overlay');
  if (overlay) overlay.style.pointerEvents = 'none';
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (overlay) overlay.style.pointerEvents = '';

  const elementData = buildElementData(target, pageX, pageY);

  // ローカルのコメントデータを新座標で更新
  const c = drag.comment;
  c.x_percent = xPct;
  c.y_percent = yPct;
  if (elementData) {
    c.element_selector = elementData.element_selector;
    c.el_x_pct = elementData.el_x_pct;
    c.el_y_pct = elementData.el_y_pct;
  } else {
    // 真下に要素がなかった場合はページ%のみで保存
    c.element_selector = null;
    c.el_x_pct = null;
    c.el_y_pct = null;
  }

  // 確定位置にピンを置き直す
  const { pageX: fx, pageY: fy } = getPinPagePosition(c);
  drag.pin.style.left = fx + 'px';
  drag.pin.style.top  = fy + 'px';

  MU_DRAG = null;

  // DBへ保存
  try {
    await sb_updatePosition(c.id, {
      x_percent: xPct,
      y_percent: yPct,
      element_selector: c.element_selector,
      el_x_pct: c.el_x_pct,
      el_y_pct: c.el_y_pct
    });
  } catch (_) {
    showCursorAlert(fx, fy, '⚠ 位置の保存に失敗しました');
  }
}

function setupMention(textareaId, dropdownId, getMembers, onSelect) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  ta.addEventListener('input', () => {
    const val = ta.value;
    const at  = val.lastIndexOf('@');
    const dd  = document.getElementById(dropdownId);
    if (at !== -1) {
      const filtered = getMembers().filter(m => m.name.toLowerCase().includes(val.slice(at + 1).toLowerCase()));
      if (filtered.length) {
        dd.style.display = 'block';
        dd.innerHTML = filtered.map(m => `<div class="mu-mi" data-name="${escHtml(m.name)}">${escHtml(m.name)}</div>`).join('');
        dd.querySelectorAll('.mu-mi').forEach(el => el.addEventListener('click', () => onSelect(el.dataset.name)));
      } else { dd.style.display = 'none'; }
    } else { if (dd) dd.style.display = 'none'; }
  });
}

function addImgThumb(previewId, file) {
  const prev = document.getElementById(previewId);
  if (!prev) return;
  const div = document.createElement('div');
  div.className = 'mu-thumb';
  div.title = file.name;
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    MU_OBJECT_URLS.push(url);
    div.innerHTML = `<img src="${url}">`;
  } else {
    const ext = (file.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 6);
    const short = file.name.length > 16 ? file.name.slice(0, 13) + '…' : file.name;
    div.innerHTML = `<div class="mu-file-thumb"><span class="mu-file-ext">${escHtml(ext)}</span><span class="mu-file-name">${escHtml(short)}</span></div>`;
  }
  prev.appendChild(div);
}

async function setDevice(device) {
  MU.device = device;
  chrome.storage.local.set({ mu_device: device });
  if (MU.toolbarMode === 'side') {
    document.getElementById('mu-dev-pc')?.classList.toggle('mu-side-on', device === 'pc');
    document.getElementById('mu-dev-mobile')?.classList.toggle('mu-side-on', device === 'mobile');
  } else {
    document.getElementById('mu-dev-pc')?.classList.toggle('mu-seg-on', device === 'pc');
    document.getElementById('mu-dev-mobile')?.classList.toggle('mu-seg-on', device === 'mobile');
  }
  // 「幅固定」が ON のときだけ、切り替え後のデバイスの固定幅にリサイズする
  if (MU.fixedWidth) applyFixedWidth();
  if (MU.active) {
    if (MU_CACHE[device]) {
      MU.comments = MU_CACHE[device];
      Object.values(MU.pinElements).forEach(el => el.remove());
      MU.pinElements = {};
      syncOverlaySize();
      MU.comments.forEach(addPin);
      updateBadge();
    } else {
      await loadComments();
    }
    closePopover();
  }
}

function updateBadge() {
  const counts = document.getElementById('mu-counts');
  if (!counts) return;
  const labels = { open: '未対応', fixed: '対応済', rejected: '差し戻し', verified: '確認完了' };
  const tally = { open: 0, fixed: 0, rejected: 0, verified: 0 };
  MU.comments.forEach(c => { if (tally[c.status] !== undefined) tally[c.status]++; });
  if (MU.toolbarMode === 'side') {
    counts.innerHTML = Object.entries(tally)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `<div class="mu-side-badge mu-side-badge-${st}" title="${labels[st]} ${n}">${n}</div>`)
      .join('');
  } else {
    counts.innerHTML = Object.entries(tally)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `<span class="mu-ci mu-ci-${st}">${labels[st]} ${n}</span>`)
      .join('');
  }
  updateNav();
}

function buildNav() {
  document.getElementById('mu-nav')?.remove();
  const nav = document.createElement('div');
  nav.id = 'mu-nav';
  document.body.appendChild(nav);
  updateNav();
}

function updateNav() {
  const nav = document.getElementById('mu-nav');
  if (!nav) return;
  nav.innerHTML = MU.comments.map((c, i) =>
    `<button class="mu-nb mu-nb-${c.status}" data-id="${c.id}" title="#${i + 1} ${escHtml(c.author)}: ${escHtml(c.text.slice(0, 30))}">${i + 1}</button>`
  ).join('');
  nav.querySelectorAll('.mu-nb').forEach(btn => {
    btn.addEventListener('click', () => {
      const comment = MU.comments.find(c => c.id === btn.dataset.id);
      if (!comment) return;
      const { pageY } = getPinPagePosition(comment);
      window.scrollTo({ top: Math.max(0, pageY - window.innerHeight / 2 + 20), behavior: 'smooth' });
    });
  });
}

function extractMention(text) {
  const m = text.match(/@(\S+)/);
  return m ? m[1] : null;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 添付ファイル一覧HTML（画像はimg、それ以外はファイルカード）
function attachmentHtml(paths) {
  if (!paths?.length) return '';
  const items = paths.map(p => {
    const name = decodeURIComponent(p.split('/').pop() || 'file');
    const short = name.length > 16 ? name.slice(0, 13) + '…' : name;
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|$)/i.test(p)) {
      return `<img src="${escHtml(p)}" class="mu-cimg" data-src="${escHtml(p)}" title="${escHtml(name)}">`;
    }
    const ext = (name.split('.').pop() || 'FILE').toUpperCase().slice(0, 6);
    return `<a href="${escHtml(p)}" target="_blank" class="mu-file-link" title="${escHtml(name)}"><div class="mu-file-thumb"><span class="mu-file-ext">${escHtml(ext)}</span><span class="mu-file-name">${escHtml(short)}</span></div></a>`;
  }).join('');
  return `<div class="mu-imgs">${items}</div>`;
}
