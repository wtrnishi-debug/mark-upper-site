// サイトURLが確定したらここを書き換える
const UPDATE_CHECK_URL = 'https://wtrnishi-debug.github.io/mark-upper-site/version.json';
const CURRENT_VERSION  = '1.8.0';

// Mark Upper の固定幅。全員がこの幅で見ることで、ピン位置のズレを原理的になくす
const MU_FIXED_WIDTH = { pc: 1366, mobile: 390 };

// アイコンクリックでコメントモードをON/OFF
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ACTIVE' });
    chrome.action.setBadgeText({ text: res?.active ? 'ON' : '', tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId: tab.id });
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RESIZE_WINDOW') {
    // PC/Mobile それぞれの固定幅へウィンドウ幅を統一する。
    // 「全員が同じ幅で見る」状態を作ることで、ピン位置のズレをなくす狙い。
    const mode = msg.mode === 'mobile' ? 'mobile' : 'pc';
    const targetWidth = MU_FIXED_WIDTH[mode];
    chrome.windows.getCurrent((win) => {
      // ブラウザのUI（枠）込みの幅なので、実際の表示幅を狙うため少し余裕を足す
      // mobile はブラウザ最小幅の制約があるため、入る範囲で最小に寄せる
      chrome.windows.update(win.id, { width: targetWidth, state: 'normal' }, () => {
        if (sendResponse) sendResponse({ ok: true, width: targetWidth });
      });
    });
    return true; // 非同期レスポンス
  }
});

// Supabase の fetch をここで代理実行（Content Script はページの CSP に縛られるため）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'SUPABASE_FETCH') return;
  const opts = { method: msg.method || 'GET', headers: msg.headers };
  if (msg.body !== undefined) opts.body = msg.body;
  fetch(msg.url, opts)
    .then(async res => {
      if (res.status === 204) { sendResponse({ ok: true, status: 204, data: null }); return; }
      try {
        const data = await res.json();
        sendResponse({ ok: res.ok, status: res.status, data });
      } catch (_) {
        sendResponse({ ok: res.ok, status: res.status, data: null });
      }
    })
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // 非同期レスポンスのためチャネルを保持
});

// 起動時とアラーム時にアップデートをチェック
chrome.runtime.onInstalled.addListener(checkForUpdates);
chrome.runtime.onStartup.addListener(checkForUpdates);

chrome.alarms.create('updateCheck', { periodInMinutes: 360 }); // 6時間ごと
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateCheck') checkForUpdates();
});

function isNewerVersion(remote, current) {
  const r = remote.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
    if ((r[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdates() {
  if (UPDATE_CHECK_URL.includes('YOUR_SITE')) return; // URL未設定時はスキップ
  try {
    const res  = await fetch(UPDATE_CHECK_URL + '?t=' + Date.now());
    const data = await res.json();
    const { mu_dismissed_version } = await chrome.storage.local.get('mu_dismissed_version');

    if (isNewerVersion(data.version, CURRENT_VERSION) && data.version !== mu_dismissed_version) {
      chrome.action.setBadgeText({ text: '↑' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.storage.local.set({
        mu_update_version:  data.version,
        mu_update_notes:    data.notes,
        mu_update_download: data.download
      });
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.local.remove(['mu_update_version', 'mu_update_notes', 'mu_update_download']);
    }
  } catch (_) {}
}
