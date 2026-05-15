const SUPABASE_URL = 'https://qchlbplywjpnxddytqpr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_6FONET_27FmnG0_kJE95sg_QI4gxAQG';

const SB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// fetch は background service worker 経由で実行（ページの CSP を回避）
function sb_fetch(url, options = {}) {
  return new Promise((resolve) => {
    // 拡張機能が更新された直後はコンテキストが無効になるため早期リターン
    if (!chrome.runtime?.id) { resolve(null); return; }
    try {
      chrome.runtime.sendMessage(
        { type: 'SUPABASE_FETCH', url, method: options.method || 'GET', headers: options.headers, body: options.body },
        (res) => resolve(chrome.runtime.lastError ? null : (res || null))
      );
    } catch (_) {
      resolve(null);
    }
  });
}

async function sb_query(path, method = 'GET', body = null) {
  try {
    const headers = {
      ...SB_HEADERS,
      ...(method === 'POST' ? { 'Prefer': 'return=representation' } : {})
    };
    const res = await sb_fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res) return null;
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(JSON.stringify(res.data));
    return res.data;
  } catch (e) {
    console.warn('[Mark Upper]', e.message);
    return null;
  }
}

async function sb_getMembers() {
  return sb_query('/members?select=name&order=name.asc');
}

async function sb_addMember(name) {
  try {
    await sb_query('/members', 'POST', { name });
  } catch (_) {}
}

async function sb_getComments(siteUrl, device) {
  const url = encodeURIComponent(siteUrl);
  const dev = encodeURIComponent(device);
  return sb_query(
    `/comments?site_url=eq.${url}&device=eq.${dev}&parent_id=is.null&select=*&order=created_at.asc`
  );
}

async function sb_getReplies(parentId) {
  return sb_query(`/comments?parent_id=eq.${parentId}&select=*&order=created_at.asc`);
}

async function sb_addComment(data) {
  return sb_query('/comments', 'POST', data);
}

async function sb_deleteComment(id) {
  await sb_fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${id}`, {
    method: 'DELETE',
    headers: SB_HEADERS
  });
}

async function sb_deleteAllComments(siteUrl) {
  const url = encodeURIComponent(siteUrl);
  await sb_fetch(`${SUPABASE_URL}/rest/v1/comments?site_url=eq.${url}&parent_id=is.null`, {
    method: 'DELETE',
    headers: SB_HEADERS
  });
}

async function sb_updateStatus(id, status) {
  await sb_fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${id}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ status })
  });
}

// ピンをドラッグで移動したあと、新しい座標情報をまとめて保存する
async function sb_updatePosition(id, pos) {
  await sb_fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${id}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({
      x_percent: pos.x_percent,
      y_percent: pos.y_percent,
      element_selector: pos.element_selector,
      el_x_pct: pos.el_x_pct,
      el_y_pct: pos.el_y_pct
    })
  });
}

async function sb_updateImagePaths(id, paths) {
  await sb_fetch(`${SUPABASE_URL}/rest/v1/comments?id=eq.${id}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ image_paths: paths })
  });
}

async function sb_uploadImage(file, commentId) {
  const ext = file.name.split('.').pop() || 'png';
  const path = `${commentId}/${Date.now()}.${ext}`;
  const buf = await file.arrayBuffer();

  const res = await sb_fetch(`${SUPABASE_URL}/storage/v1/object/comment-images/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': file.type
    },
    body: buf
  });

  if (!res || !res.ok) throw new Error('ファイルのアップロードに失敗しました');
  return `${SUPABASE_URL}/storage/v1/object/public/comment-images/${path}`;
}
