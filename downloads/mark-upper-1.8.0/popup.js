let isActive = false;
let currentDevice = 'pc';

// アップデート通知バナーの表示
async function checkUpdateBanner() {
  const { mu_update_version, mu_update_notes, mu_update_download } =
    await chrome.storage.local.get(['mu_update_version', 'mu_update_notes', 'mu_update_download']);
  if (!mu_update_version) return;
  const banner = document.getElementById('update-banner');
  document.getElementById('update-text').textContent = `🆙 v${mu_update_version} が出ています — ${mu_update_notes || ''}`;
  document.getElementById('update-link').href = mu_update_download || '#';
  banner.style.display = 'flex';
  document.getElementById('update-dismiss').addEventListener('click', async () => {
    banner.style.display = 'none';
    await chrome.storage.local.set({ mu_dismissed_version: mu_update_version });
    chrome.action.setBadgeText({ text: '' });
  });
}

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function msgContent(msg) {
  const tab = await getTab();
  return chrome.tabs.sendMessage(tab.id, msg);
}

document.addEventListener('DOMContentLoaded', async () => {
  checkUpdateBanner();
  const stored = await chrome.storage.local.get(['mu_username', 'mu_device']);
  currentDevice = stored.mu_device || 'pc';

  if (!stored.mu_username) {
    show('name-screen');
  } else {
    showMain(stored.mu_username);
    try {
      const state = await msgContent({ type: 'GET_STATE' });
      if (state) {
        isActive = state.active;
        currentDevice = state.device || currentDevice;
        document.getElementById('count').textContent = state.commentCount ?? 0;
        updateToggleBtn();
        updateDeviceBtns();
      }
    } catch (e) { /* タブがまだ準備できていない場合は無視 */ }
  }

  document.getElementById('name-save').addEventListener('click', async () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) return;
    await chrome.storage.local.set({ mu_username: name });
    try { await msgContent({ type: 'SET_USERNAME', name }); } catch (e) {}
    showMain(name);
  });

  document.getElementById('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) document.getElementById('name-save').click();
  });

  document.getElementById('name-change').addEventListener('click', () => {
    show('name-screen');
    document.getElementById('name-input').value = '';
  });

  document.getElementById('toggle-btn').addEventListener('click', async () => {
    try {
      const res = await msgContent({ type: 'TOGGLE_ACTIVE' });
      isActive = res.active;
    } catch (e) {
      // コンテンツスクリプトが未初期化の場合は手動で注入
      const tab = await getTab();
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['supabase.js', 'content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await new Promise(r => setTimeout(r, 300));
      try {
        const res = await msgContent({ type: 'TOGGLE_ACTIVE' });
        isActive = res.active;
      } catch (e2) {}
    }
    updateToggleBtn();
  });

  document.getElementById('pc-btn').addEventListener('click', () => switchDevice('pc'));
  document.getElementById('mobile-btn').addEventListener('click', () => switchDevice('mobile'));
});

async function switchDevice(device) {
  if (currentDevice === device) return;
  currentDevice = device;
  chrome.storage.local.set({ mu_device: device });
  updateDeviceBtns();
  try { await msgContent({ type: 'SET_DEVICE', device }); } catch (e) {}
  chrome.runtime.sendMessage({ type: 'RESIZE_WINDOW', mode: device });
}

function showMain(name) {
  show('main-screen');
  document.getElementById('username-disp').textContent = '👤 ' + name;
  updateToggleBtn();
  updateDeviceBtns();
}

function show(id) {
  ['name-screen', 'main-screen'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'flex' : 'none';
  });
}

function updateToggleBtn() {
  const btn = document.getElementById('toggle-btn');
  btn.textContent = isActive ? 'コメントモードをOFFにする' : 'コメントモードをONにする';
  btn.className = 'btn btn-primary btn-full' + (isActive ? ' active' : '');
}

function updateDeviceBtns() {
  document.getElementById('pc-btn').className = 'dev-btn' + (currentDevice === 'pc' ? ' active' : '');
  document.getElementById('mobile-btn').className = 'dev-btn' + (currentDevice === 'mobile' ? ' active' : '');
}
