// ── 定数 ──────────────────────────────────────────────
const BOOKMARKLET_SRC = 'bookmarklet.js';

const MU = {
  sessionId:   null,
  domain:      null,
  allComments: [],
  selectedPage: null,
  userName:    localStorage.getItem('mu_username') || '',
};

// ── Init ──────────────────────────────────────────────
(async function init() {
  applyTheme(localStorage.getItem('mu_theme') || 'dark');
  updateUserLabel();

  const p   = new URLSearchParams(location.search);
  const sid = p.get('s');
  const url = p.get('url');

  if (sid) {
    const session = await mu_getSessionById(sid);
    if (session) {
      MU.sessionId = session.id;
      MU.domain    = session.domain;
      const inputUrl = url ? decodeURIComponent(url) : 'https://' + session.domain;
      document.getElementById('mu-url-input').value = inputUrl;
      updateSidebarDomain();
      buildBookmarklet(inputUrl);
      await loadComments();
    }
  }

  document.getElementById('mu-open-btn').addEventListener('click', handleOpen);
  document.getElementById('mu-url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleOpen();
  });
  document.getElementById('mu-user-btn').addEventListener('click', toggleNamePanel);
  document.getElementById('mu-share-btn').addEventListener('click', shareSession);
  document.getElementById('mu-theme-btn').addEventListener('click', toggleTheme);
})();

// ── セッション開始 ─────────────────────────────────────
async function handleOpen() {
  let url = document.getElementById('mu-url-input').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  document.getElementById('mu-url-input').value = url;

  const domain = extractDomain(url);

  if (domain !== MU.domain) {
    MU.allComments  = [];
    MU.selectedPage = null;
    MU.domain       = domain;
    updateSidebarDomain();
    try {
      const session = await mu_getOrCreateSession(domain);
      MU.sessionId  = session.id;
    } catch {
      showToast('セッションの作成に失敗しました');
      return;
    }
  }

  updateUrlParams(url);
  buildBookmarklet(url);
  await loadComments();
}

function updateUrlParams(pageUrl) {
  const p = new URLSearchParams();
  if (MU.sessionId) p.set('s',   MU.sessionId);
  if (pageUrl)      p.set('url', encodeURIComponent(pageUrl));
  history.replaceState(null, '', '?' + p.toString());
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function updateSidebarDomain() {
  const el = document.getElementById('mu-sidebar-domain');
  if (el) el.textContent = MU.domain || 'コメント';
}

// ── ブックマークレット生成 ─────────────────────────────
function buildBookmarklet(pageUrl) {
  const src = new URL(BOOKMARKLET_SRC, location.href).href;
  const bm  = `javascript:(function(){var s=document.createElement('script');s.src='${src}?_='+Date.now();document.head.appendChild(s);})();`;

  const link = document.getElementById('mu-bm-link');
  link.href  = bm;
  document.getElementById('mu-bm-section').style.display = '';
}

// ── コメント読み込み ───────────────────────────────────
async function loadComments() {
  if (!MU.sessionId) return;
  MU.allComments = await mu_getComments(MU.sessionId);
  renderAll();
}

// ── 全体レンダリング ───────────────────────────────────
function renderAll() {
  renderStatusBar();
  renderPageNav();
  renderCommentList();
}

// ── ステータスサマリー ─────────────────────────────────
function renderStatusBar() {
  const roots = MU.allComments.filter(c => !c.parent_id);
  const total = roots.length;

  document.getElementById('mu-count-badge').textContent = total;
  document.getElementById('mu-status-bar').style.display = total ? '' : 'none';

  ['open','fixed','verified','rejected'].forEach(st => {
    document.getElementById('st-' + st).textContent =
      roots.filter(c => c.status === st).length;
  });
}

// ── ページナビ（左サイドバー）─────────────────────────
function renderPageNav() {
  const nav    = document.getElementById('mu-page-nav');
  const roots  = MU.allComments.filter(c => !c.parent_id);

  if (!roots.length) { nav.innerHTML = ''; return; }

  const pages = {};
  roots.forEach(c => {
    if (!pages[c.page_url]) pages[c.page_url] = 0;
    pages[c.page_url]++;
  });

  let html = '<div class="mu-page-nav-hdr">PAGES</div>';
  Object.entries(pages).forEach(([url, count]) => {
    const slug = pageSlug(url);
    const active = url === MU.selectedPage ? ' mu-page-nav-active' : '';
    html += `<div class="mu-page-nav-item${active}" data-url="${esc(url)}">
      <span class="mu-page-nav-slug">${esc(slug)}</span>
      <span class="mu-page-nav-count">${count}</span>
    </div>`;
  });

  nav.innerHTML = html;
  nav.querySelectorAll('.mu-page-nav-item').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      MU.selectedPage = MU.selectedPage === url ? null : url;
      renderPageNav();
      renderCommentList();
    });
  });
}

// ── コメント一覧（メインエリア）───────────────────────
function renderCommentList() {
  const empty   = document.getElementById('mu-empty');
  const list    = document.getElementById('mu-comment-list');
  const roots   = MU.allComments.filter(c => !c.parent_id);

  if (!roots.length) {
    empty.style.display = '';
    list.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';
  list.style.display  = '';

  const filtered = MU.selectedPage
    ? roots.filter(c => c.page_url === MU.selectedPage)
    : roots;

  const groups = {};
  filtered.forEach(c => {
    if (!groups[c.page_url]) groups[c.page_url] = [];
    groups[c.page_url].push(c);
  });

  const stLabel = { open:'未対応', fixed:'対応済', verified:'確認完了', rejected:'差し戻し' };
  const stTrans = {
    open:     [{ to:'fixed',    label:'対応済にする' }],
    fixed:    [{ to:'verified', label:'確認完了にする' }, { to:'rejected', label:'差し戻す' }],
    verified: [{ to:'open',     label:'未対応に戻す'  }],
    rejected: [{ to:'fixed',    label:'再対応済にする' }],
  };
  const PALETTE = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#14b8a6','#f43f5e'];

  function authorColor(name) {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  let html = '';
  Object.entries(groups).forEach(([pageUrl, comments]) => {
    html += `<div class="mu-group">
      <div class="mu-group-hdr">
        <span class="mu-group-path">${esc(pageSlug(pageUrl))}</span>
        <span class="mu-group-count">${comments.length}件</span>
        <a class="mu-group-link" href="${esc(pageUrl)}" target="_blank" rel="noopener" title="ページを開く">↗</a>
      </div>`;

    comments.forEach((c, i) => {
      const num    = roots.findIndex(r => r.id === c.id) + 1;
      const init   = (c.author || '?')[0].toUpperCase();
      const color  = authorColor(c.author);
      const trans  = (stTrans[c.status] || [])
        .map(t => `<button class="mu-action-btn mu-action-${t.to}" data-id="${c.id}" data-next="${t.to}">${t.label}</button>`)
        .join('');
      const canDel = !MU.userName || c.author === MU.userName;
      html += `
        <div class="mu-card" data-id="${c.id}">
          <div class="mu-card-hdr">
            <div class="mu-card-meta">
              <span class="mu-num">${num}</span>
              <span class="mu-avatar" style="background:${color}">${esc(init)}</span>
              <span class="mu-author">${esc(c.author)}</span>
              <span class="mu-bp">${c.breakpoint?.toUpperCase() || 'PC'}</span>
            </div>
            <span class="mu-st-badge mu-st-${c.status}">${stLabel[c.status] || c.status}</span>
          </div>
          <div class="mu-card-text">${esc(c.text)}</div>
          <div class="mu-card-actions">
            ${trans}
            ${canDel ? `<button class="mu-del-btn" data-id="${c.id}">削除</button>` : ''}
          </div>
        </div>`;
    });

    html += '</div>';
  });

  if (!html) {
    html = `<p class="mu-list-empty" style="padding:32px;text-align:center;color:var(--ink-muted)">このページにコメントはありません</p>`;
  }

  list.innerHTML = html;

  list.querySelectorAll('.mu-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid   = btn.dataset.id;
      const newSt = btn.dataset.next;
      await mu_updateStatus(cid, newSt);
      const c = MU.allComments.find(c => c.id === cid);
      if (c) c.status = newSt;
      renderAll();
    });
  });

  list.querySelectorAll('.mu-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('このコメントを削除しますか？')) return;
      const cid = btn.dataset.id;
      await mu_deleteComment(cid);
      MU.allComments = MU.allComments.filter(c => c.id !== cid);
      renderAll();
    });
  });
}

// ── ユーザー名 ─────────────────────────────────────────
function updateUserLabel() {
  const btn = document.getElementById('mu-user-btn');
  if (btn) btn.title = MU.userName ? `名前: ${MU.userName}` : '名前を設定';
}

function toggleNamePanel() {
  const existing = document.getElementById('mu-name-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'mu-name-panel';
  panel.innerHTML = `
    <input type="text" class="mu-name-inp" id="mu-name-inp"
      value="${esc(MU.userName)}" placeholder="名前を入力" maxlength="20">
    <button class="mu-name-ok" id="mu-name-ok">確定</button>`;
  document.body.appendChild(panel);

  const inp = document.getElementById('mu-name-inp');
  inp.focus(); if (MU.userName) inp.select();

  const commit = () => {
    const name = inp.value.trim();
    if (name) { MU.userName = name; localStorage.setItem('mu_username', name); }
    updateUserLabel();
    panel.remove();
  };
  document.getElementById('mu-name-ok').addEventListener('click', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') panel.remove();
  });
}

// ── 共有 ──────────────────────────────────────────────
function shareSession() {
  if (!MU.sessionId) { showToast('先にURLを開いてください'); return; }
  navigator.clipboard.writeText(location.href)
    .then(()  => showToast('URLをコピーしました'))
    .catch(() => showToast('コピーできませんでした'));
}

// ── テーマ ─────────────────────────────────────────────
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('mu_theme', theme);
}

// ── トースト ───────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('mu-toast');
  el.textContent = msg;
  el.classList.add('mu-show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('mu-show'), 2200);
}

// ── ユーティリティ ─────────────────────────────────────
function pageSlug(url) {
  try {
    const segs = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean);
    return segs.length ? '/' + segs.join('/') : '/';
  } catch { return url; }
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
