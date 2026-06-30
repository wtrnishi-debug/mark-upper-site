/* Mark Upper – snapshot viewer pin overlay (injected into snapshot iframe) */
(function () {
  'use strict';
  if (window.__mu_viewer) return;
  window.__mu_viewer = true;

  const CTX = window.MU_VIEWER || {};
  const SB_URL = 'https://hiccejzetnmmvyopyykw.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpY2NlanpldG5tbXZ5b3B5eWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4MjkwMTYsImV4cCI6MjA5NDQwNTAxNn0.Oo_KrFflZhhWOlaN_hT9XZpBjhDFAgccK82CyrgC3qU';

  const mu = {
    sb: null,
    sessionId: CTX.sessionId,
    pageUrl:   CTX.pageUrl,
    comments:  [],
    pins:      {},
    annotating: false,
    userName:  localStorage.getItem('mu_username') || '',
    filter:    'all',
    el:        {},
  };

  if (!mu.sessionId || !mu.pageUrl) {
    console.warn('MU_VIEWER context missing');
    return;
  }

  if (window.supabase) boot();
  else {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload = boot;
    s.onerror = () => toast('Supabaseの読み込みに失敗しました');
    document.head.appendChild(s);
  }

  async function boot() {
    mu.sb = window.supabase.createClient(SB_URL, SB_KEY);
    injectStyle();
    buildLayer();
    buildOverlay();
    buildPanel();
    await reload();
  }

  async function reload() {
    const { data } = await mu.sb.from('mu_comments').select('*')
      .eq('session_id', mu.sessionId).eq('page_url', mu.pageUrl)
      .is('parent_id', null).order('created_at');
    mu.comments = data || [];
    // clear pins
    Object.values(mu.pins).forEach(p => p.remove());
    mu.pins = {};
    renderPins();
    refreshPanel();
  }

  function buildLayer() {
    const el = document.createElement('div');
    el.id = '__mu_layer';
    document.body.appendChild(el);
    mu.el.layer = el;
  }

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = '__mu_overlay';
    el.addEventListener('click', onOverlayClick);
    document.body.appendChild(el);
    mu.el.overlay = el;
  }

  function buildPanel() {
    const host = document.createElement('div');
    host.id = '__mu_host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
:host { all: initial; }
.panel { position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font-family: -apple-system, 'Helvetica Neue', sans-serif; }
.body { background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 12px;
  padding: 12px; width: 220px; display: none;
  box-shadow: 0 8px 32px rgba(0,0,0,.6); }
.panel.open .body { display: block; }
.lbl { font-size: 10px; color: #555; letter-spacing: .06em; margin-bottom: 6px; }
.sep { height: 1px; background: #2a2a2a; margin: 8px 0; }
.pbtn { width: 100%; background: #252525; border: 1px solid #2e2e2e; border-radius: 8px;
  color: #fff; font-size: 12px; font-weight: 600; padding: 8px 10px;
  cursor: pointer; text-align: left; font-family: inherit;
  transition: background .12s; display: block; margin-bottom: 6px; }
.pbtn:last-child { margin-bottom: 0; }
.pbtn:hover { background: #2e2e2e; }
.pbtn.on { background: #0099ff; border-color: #0099ff; }
.sel { width: 100%; background: #252525; border: 1px solid #2e2e2e; border-radius: 8px;
  color: #fff; font-size: 12px; font-weight: 600; padding: 6px 8px;
  cursor: pointer; font-family: inherit; margin-bottom: 6px; }
.fab { display: flex; align-items: center; gap: 8px;
  background: #0099ff; border: none; border-radius: 999px;
  color: #fff; font-size: 13px; font-weight: 700; font-family: inherit;
  padding: 10px 16px; cursor: pointer;
  box-shadow: 0 4px 20px rgba(0,153,255,.45); transition: opacity .12s; }
.fab:hover { opacity: .85; }
.badge { background: rgba(255,255,255,.22); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
</style>
<div class="panel open" id="panel">
  <div class="body">
    <div class="lbl">MARK UPPER</div>
    <div class="sep"></div>
    <button class="pbtn" id="annotate-btn">📍 クリックで追加</button>
    <select class="sel" id="filter-sel">
      <option value="all">すべて表示</option>
      <option value="open">未対応のみ</option>
      <option value="fixed">対応済のみ</option>
      <option value="verified">確認完了のみ</option>
      <option value="hide-fixed">対応済を非表示</option>
    </select>
    <button class="pbtn" id="name-btn">👤 <span id="name-lbl">名前を設定</span></button>
  </div>
  <button class="fab" id="fab">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9.5 1.5L12.5 4.5L5 12H2V9L9.5 1.5Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
    <span id="fab-lbl">Mark Upper</span>
    <span class="badge" id="count">0</span>
  </button>
</div>`;
    mu.el.shadow = shadow;
    shadow.getElementById('fab').onclick           = togglePanel;
    shadow.getElementById('annotate-btn').onclick  = toggleAnnotate;
    shadow.getElementById('name-btn').onclick      = promptName;
    shadow.getElementById('filter-sel').onchange   = (e) => { mu.filter = e.target.value; applyFilter(); };
  }

  function togglePanel() {
    mu.el.shadow.getElementById('panel').classList.toggle('open');
  }

  function toggleAnnotate() {
    if (!mu.userName) { promptName(); return; }
    mu.annotating = !mu.annotating;
    mu.el.overlay.classList.toggle('__mu_active', mu.annotating);
    const btn = mu.el.shadow.getElementById('annotate-btn');
    btn.classList.toggle('on', mu.annotating);
    btn.textContent = mu.annotating ? '🎯 クリックで配置…' : '📍 クリックで追加';
  }

  function exitAnnotate() {
    mu.annotating = false;
    mu.el.overlay.classList.remove('__mu_active');
    const btn = mu.el.shadow?.getElementById('annotate-btn');
    if (btn) { btn.classList.remove('on'); btn.textContent = '📍 クリックで追加'; }
  }

  function onOverlayClick(e) {
    if (!mu.annotating) return;
    const docW = Math.max(document.documentElement.scrollWidth,  document.body.scrollWidth);
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const xPct = ((e.clientX + window.scrollX) / docW) * 100;
    const yPct = ((e.clientY + window.scrollY) / docH) * 100;
    exitAnnotate();
    openForm(xPct, yPct, e.clientX, e.clientY);
  }

  function openForm(xPct, yPct, cx, cy) {
    closePop();
    const pop = makePop(`
      <div class="mu-hdr"><span>新しいコメント</span><button class="mu-x" id="mu-fx">✕</button></div>
      <textarea class="mu-ta" id="mu-fta" placeholder="コメントを入力…" rows="3"></textarea>
      <div class="mu-foot">
        <button class="mu-cancel" id="mu-fc">キャンセル</button>
        <button class="mu-submit" id="mu-fs">追加</button>
      </div>`);
    placePop(pop, cx, cy);
    document.getElementById('mu-fta').focus();
    document.getElementById('mu-fx').onclick = closePop;
    document.getElementById('mu-fc').onclick = closePop;
    document.getElementById('mu-fs').onclick = () => submitComment(xPct, yPct);
  }

  async function submitComment(xPct, yPct) {
    const text = document.getElementById('mu-fta')?.value.trim();
    if (!text) return;
    const btn = document.getElementById('mu-fs');
    if (btn) { btn.disabled = true; btn.textContent = '追加中…'; }
    const { data } = await mu.sb.from('mu_comments').insert({
      session_id: mu.sessionId, page_url: mu.pageUrl,
      x_percent: xPct, y_percent: yPct, breakpoint: 'pc',
      text, author: mu.userName, status: 'open',
    }).select().single();
    if (data) { mu.comments.push(data); addPin(data); refreshPanel(); applyFilter(); }
    closePop();
  }

  function openDetail(c, cx, cy) {
    closePop();
    const ST_LABEL = { open:'未対応', fixed:'対応済', verified:'確認完了', rejected:'差し戻し' };
    const ST_COLOR = { open:'#ef4444', fixed:'#3b82f6', verified:'#10b981', rejected:'#f97316' };
    const ST_NEXT  = {
      open:     [{ to:'fixed',    label:'対応済にする' }],
      fixed:    [{ to:'verified', label:'確認完了にする' }, { to:'rejected', label:'差し戻す' }],
      verified: [{ to:'open',     label:'未対応に戻す'  }],
      rejected: [{ to:'fixed',    label:'再対応済にする' }],
    };
    const init = (c.author || '?')[0].toUpperCase();
    const canEdit = !mu.userName || c.author === mu.userName;
    const transHtml = (ST_NEXT[c.status] || []).map(t =>
      `<button class="mu-trans" data-next="${t.to}">${t.label}</button>`).join('');
    const pop = makePop(`
      <div class="mu-hdr">
        <span style="display:flex;align-items:center;gap:6px">
          <span class="mu-av" style="background:${authorColor(c.author)}">${esc(init)}</span>
          ${esc(c.author)}
        </span>
        <button class="mu-x" id="mu-dx">✕</button>
      </div>
      <span class="mu-pill" style="background:${ST_COLOR[c.status]}22;color:${ST_COLOR[c.status]}">
        ${ST_LABEL[c.status] || c.status}
      </span>
      <div class="mu-body" id="mu-detail-text">${esc(c.text)}</div>
      <div class="mu-detail-actions">
        ${transHtml}
        ${canEdit ? '<button class="mu-edit-btn" id="mu-edit">編集</button>' : ''}
        ${canEdit ? '<button class="mu-del-btn" id="mu-del">削除</button>' : ''}
      </div>`);
    placePop(pop, cx, cy);
    document.getElementById('mu-dx').onclick = closePop;
    if (canEdit) {
      document.getElementById('mu-edit').onclick = () => openEdit(c, cx, cy);
      document.getElementById('mu-del').onclick  = () => deleteComment(c);
    }
    pop.querySelectorAll('.mu-trans').forEach(b => {
      b.onclick = () => changeStatus(c, b.dataset.next);
    });
  }

  function openEdit(c, cx, cy) {
    closePop();
    const pop = makePop(`
      <div class="mu-hdr"><span>編集</span><button class="mu-x" id="mu-ex">✕</button></div>
      <textarea class="mu-ta" id="mu-eta" rows="3">${esc(c.text)}</textarea>
      <div class="mu-foot">
        <button class="mu-cancel" id="mu-ec">キャンセル</button>
        <button class="mu-submit" id="mu-es">保存</button>
      </div>`);
    placePop(pop, cx, cy);
    document.getElementById('mu-eta').focus();
    document.getElementById('mu-ex').onclick = closePop;
    document.getElementById('mu-ec').onclick = closePop;
    document.getElementById('mu-es').onclick = async () => {
      const text = document.getElementById('mu-eta').value.trim();
      if (!text) return;
      await mu.sb.from('mu_comments').update({ text }).eq('id', c.id);
      c.text = text;
      const pin = mu.pins[c.id];
      if (pin) pin.title = `${c.author}: ${text}`;
      closePop();
    };
  }

  async function changeStatus(c, next) {
    await mu.sb.from('mu_comments').update({ status: next }).eq('id', c.id);
    c.status = next;
    const pin = mu.pins[c.id];
    if (pin) {
      pin.className = `__mu_pin __mu_pin_${next}`;
    }
    closePop();
    applyFilter();
  }

  async function deleteComment(c) {
    if (!confirm('このコメントを削除しますか？')) return;
    await mu.sb.from('mu_comments').delete().eq('id', c.id);
    mu.comments = mu.comments.filter(x => x.id !== c.id);
    mu.pins[c.id]?.remove();
    delete mu.pins[c.id];
    closePop();
    refreshPanel();
  }

  function renderPins() {
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    mu.el.layer.style.height = docH + 'px';
    mu.comments.forEach(addPin);
    applyFilter();
  }

  function addPin(c) {
    if (mu.pins[c.id]) return;
    const init = (c.author || '?')[0].toUpperCase();
    const pin = document.createElement('div');
    pin.className = `__mu_pin __mu_pin_${c.status}`;
    pin.style.left = c.x_percent + '%';
    pin.style.top  = c.y_percent + '%';
    pin.style.background = authorColor(c.author);
    pin.innerHTML = `<span class="__mu_init">${esc(init)}</span>`;
    pin.title = `${c.author}: ${c.text}`;
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = pin.getBoundingClientRect();
      openDetail(c, r.right + 8, r.top);
    });
    mu.el.layer.appendChild(pin);
    mu.pins[c.id] = pin;
  }

  function applyFilter() {
    for (const c of mu.comments) {
      const pin = mu.pins[c.id];
      if (!pin) continue;
      let show = true;
      if (mu.filter === 'all') show = true;
      else if (mu.filter === 'hide-fixed') show = c.status !== 'fixed';
      else show = c.status === mu.filter;
      pin.style.display = show ? '' : 'none';
    }
  }

  function refreshPanel() {
    const n  = mu.comments.length;
    const sh = mu.el.shadow;
    if (!sh) return;
    sh.getElementById('count').textContent   = n;
    sh.getElementById('fab-lbl').textContent = n ? `${n}件` : 'Mark Upper';
    sh.getElementById('name-lbl').textContent = mu.userName || '名前を設定';
  }

  function promptName() {
    const name = prompt('表示名を入力してください', mu.userName);
    if (name === null) return;
    mu.userName = name.trim();
    if (mu.userName) localStorage.setItem('mu_username', mu.userName);
    refreshPanel();
  }

  function makePop(html) {
    const el = document.createElement('div');
    el.className = '__mu_pop'; el.id = '__mu_popup';
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  function placePop(pop, cx, cy) {
    pop.style.left = (cx + 14) + 'px';
    pop.style.top  = (cy + 14) + 'px';
    requestAnimationFrame(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      let l = cx + 14, t = cy + 14;
      if (l + pop.offsetWidth  > vw - 8) l = cx - pop.offsetWidth  - 14;
      if (t + pop.offsetHeight > vh - 8) t = cy - pop.offsetHeight - 14;
      pop.style.left = Math.max(8, l) + 'px';
      pop.style.top  = Math.max(8, t) + 'px';
    });
  }

  function closePop() { document.getElementById('__mu_popup')?.remove(); }

  function injectStyle() {
    const el = document.createElement('style');
    el.textContent = `
#__mu_layer { position: absolute !important; top: 0 !important; left: 0 !important;
  width: 100% !important; pointer-events: none !important; z-index: 2147483643 !important; }
#__mu_overlay { position: fixed !important; inset: 0 !important;
  z-index: 2147483644 !important; pointer-events: none !important; }
#__mu_overlay.__mu_active { pointer-events: all !important; cursor: crosshair !important;
  background: rgba(0, 100, 255, .04) !important; }
#__mu_host { position: fixed !important; bottom: 20px !important; right: 20px !important;
  z-index: 2147483647 !important; }
.__mu_pin { position: absolute !important;
  width: 28px !important; height: 28px !important;
  border-radius: 50% 50% 50% 0 !important;
  transform: translate(-50%, -100%) rotate(-45deg) !important;
  display: flex !important; align-items: center !important; justify-content: center !important;
  pointer-events: all !important; cursor: pointer !important;
  box-shadow: 0 2px 10px rgba(0,0,0,.45) !important;
  transition: transform .15s !important; z-index: 2147483645 !important; }
.__mu_pin:hover { transform: translate(-50%,-100%) rotate(-45deg) scale(1.2) !important; }
.__mu_pin_fixed { opacity: .55 !important; }
.__mu_pin_verified { opacity: .35 !important; }
.__mu_init { transform: rotate(45deg) !important;
  font-size: 10px !important; font-weight: 700 !important; color: #fff !important;
  font-family: -apple-system, sans-serif !important; line-height: 1 !important;
  user-select: none !important; }
.__mu_pop { position: fixed !important; z-index: 2147483646 !important;
  background: #1c1c1c !important; border: 1px solid #2e2e2e !important;
  border-radius: 10px !important; padding: 14px !important; width: 264px !important;
  box-shadow: 0 8px 32px rgba(0,0,0,.6) !important;
  font-family: -apple-system, 'Helvetica Neue', sans-serif !important;
  color: #fff !important; font-size: 13px !important; }
.__mu_pop .mu-hdr { display: flex !important; justify-content: space-between !important;
  align-items: center !important; margin-bottom: 10px !important;
  font-size: 12px !important; font-weight: 600 !important; color: #fff !important; }
.__mu_pop .mu-x { background: none !important; border: none !important; color: #666 !important;
  cursor: pointer !important; font-size: 16px !important; padding: 0 !important; line-height: 1 !important; }
.__mu_pop .mu-ta { width: 100% !important; background: #111 !important; border: 1px solid #333 !important;
  border-radius: 6px !important; color: #fff !important; font-size: 13px !important;
  padding: 8px !important; box-sizing: border-box !important; resize: none !important;
  font-family: inherit !important; display: block !important; line-height: 1.5 !important; }
.__mu_pop .mu-foot { display: flex !important; justify-content: flex-end !important;
  gap: 6px !important; margin-top: 10px !important; }
.__mu_pop .mu-cancel { background: #2a2a2a !important; border: 1px solid #333 !important; border-radius: 6px !important;
  color: #999 !important; font-size: 12px !important; font-weight: 600 !important;
  padding: 6px 12px !important; cursor: pointer !important; font-family: inherit !important; }
.__mu_pop .mu-submit { background: #0099ff !important; border: none !important; border-radius: 6px !important;
  color: #fff !important; font-size: 12px !important; font-weight: 600 !important;
  padding: 6px 12px !important; cursor: pointer !important; font-family: inherit !important; }
.__mu_pop .mu-av { display: inline-flex !important; align-items: center !important;
  justify-content: center !important; width: 20px !important; height: 20px !important;
  border-radius: 50% !important; font-size: 10px !important;
  font-weight: 700 !important; color: #fff !important; flex-shrink: 0 !important; }
.__mu_pop .mu-pill { display: inline-block !important; padding: 2px 8px !important;
  border-radius: 999px !important; font-size: 10px !important; font-weight: 700 !important;
  margin-bottom: 8px !important; }
.__mu_pop .mu-body { font-size: 13px !important; color: #bbb !important;
  line-height: 1.6 !important; white-space: pre-wrap !important; }
.__mu_pop .mu-detail-actions { display: flex !important; flex-wrap: wrap !important;
  gap: 6px !important; margin-top: 10px !important; }
.__mu_pop .mu-trans, .__mu_pop .mu-edit-btn, .__mu_pop .mu-del-btn {
  font-size: 11px !important; font-weight: 600 !important;
  border-radius: 6px !important; padding: 5px 10px !important;
  cursor: pointer !important; font-family: inherit !important; border: 1px solid #333 !important; }
.__mu_pop .mu-trans { background: #2a2a2a !important; color: #ddd !important; }
.__mu_pop .mu-edit-btn { background: #2563eb !important; color: #fff !important; border-color: #2563eb !important; }
.__mu_pop .mu-del-btn { background: #444 !important; color: #f87171 !important; }
`;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  const PALETTE = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#14b8a6','#f43f5e'];
  function authorColor(name) {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  function toast(msg) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed!important;bottom:80px!important;right:20px!important;background:#333!important;color:#fff!important;padding:8px 14px!important;border-radius:8px!important;font-size:12px!important;z-index:2147483647!important;font-family:-apple-system,sans-serif!important;';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
})();
