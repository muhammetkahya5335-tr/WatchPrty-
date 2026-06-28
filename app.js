'use strict';

/* =========================================================
   STATE
   ========================================================= */
const state = {
  uid: null,
  name: '',
  roomCode: null,
  serverOffset: 0,
  queueCache: {},      // key -> {type, refId, title, addedBy}
  queueOrder: [],       // ordered keys
  historyCache: {},     // key -> {type, refId, title, watchedAt}
  historyOrder: [],
  currentItemId: null,
  currentType: null,    // 'youtube' | 'html5'
  isPlaying: false,
  speed: 1,             // oynatma hızı (YouTube, senkron edilir)
  listeners: [],         // {ref, event, handler} kayıtları, çıkışta temizlenir
  ytPlayer: null,
  ytApiReady: false,
  pendingYtVideoId: null,
  seekDragging: false,
  preferredQuality: 'default', // sadece bu cihazda geçerli, senkron değil
  activeTab: 'queue',
  chatHistoryLoaded: false,
  unreadChat: 0,
};

/* sunucu saatine göre "şimdi" — playback hesaplarında tutarlılık için tek yerden */
function serverTimeNow() { return Date.now() + (state.serverOffset || 0); }

/* =========================================================
   DOM REFS
   ========================================================= */
const el = (id) => document.getElementById(id);
const landingView = el('landingView');
const roomView = el('roomView');

/* =========================================================
   HELPERS
   ========================================================= */
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getOrCreateUid() {
  let uid = localStorage.getItem('wt_uid');
  if (!uid) {
    uid = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('wt_uid', uid);
  }
  return uid;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // I,O,L,0,1 karıştırılmasın diye çıkarıldı
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function trackListener(ref, event, handler) {
  ref.on(event, handler);
  state.listeners.push({ ref, event, handler });
}

function clearAllListeners() {
  state.listeners.forEach(({ ref, event, handler }) => ref.off(event, handler));
  state.listeners = [];
}

/* =========================================================
   LINK ALGILAMA
   ========================================================= */
function parseLink(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return null; }
  const host = url.hostname.replace(/^www\./, '');

  /* ── YouTube video ── */
  const yt = raw.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { type: 'youtube', refId: yt[1], title: 'YouTube videosu' };

  /* ── YouTube playlist ── */
  const isPlaylistUrl = /youtube\.com\/playlist/.test(raw);
  const listParam = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (isPlaylistUrl && listParam) {
    return { type: 'youtube_playlist', refId: listParam[1], title: 'YouTube oynatma listesi' };
  }

  /* ── Kick canlı yayın ── kick.com/kanaladi */
  if (host === 'kick.com') {
    const channel = url.pathname.replace(/^\//, '').split('/')[0];
    if (channel && channel !== 'video') {
      return { type: 'kick', refId: channel, title: `Kick: ${channel}`, live: true };
    }
  }

  /* ── Twitch canlı yayın & VOD ── */
  if (host === 'twitch.tv') {
    const parts = url.pathname.replace(/^\//, '').split('/');
    /* VOD: twitch.tv/videos/12345678 */
    if (parts[0] === 'videos' && parts[1]) {
      return { type: 'twitch_vod', refId: parts[1], title: `Twitch VOD` };
    }
    /* Canlı: twitch.tv/kanaladi */
    if (parts[0] && parts[0] !== 'directory') {
      return { type: 'twitch', refId: parts[0], title: `Twitch: ${parts[0]}`, live: true };
    }
  }

  /* ── Vimeo ── */
  if (host === 'vimeo.com') {
    const vid = url.pathname.match(/\/(\d+)/);
    if (vid) return { type: 'vimeo', refId: vid[1], title: 'Vimeo videosu' };
  }

  /* ── Google Drive ── */
  const drive = raw.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/);
  if (drive) return { type: 'drive', refId: drive[1], title: 'Drive videosu' };

  /* ── Direkt video linki ── */
  return { type: 'video', refId: raw, title: raw.split('/').pop().slice(0, 60) || 'Video' };
}

function driveStreamUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/* =========================================================
   LANDING — OLUŞTUR / KATIL
   ========================================================= */
el('createRoomBtn').addEventListener('click', async () => {
  const name = el('nameInput').value.trim();
  if (!name) return setLandingError('Önce ismini yaz.');
  setLandingError('');
  setLandingLoading(true);
  try {
    let code, snap;
    for (let i = 0; i < 6; i++) {
      code = generateRoomCode();
      snap = await db.ref(`rooms/${code}`).get();
      if (!snap.exists()) break;
    }
    await db.ref(`rooms/${code}/meta`).set({ createdAt: firebase.database.ServerValue.TIMESTAMP });
    await enterRoom(code, name);
  } catch (err) {
    console.error(err);
    setLandingError('Bir şeyler ters gitti, tekrar dene.');
  } finally {
    setLandingLoading(false);
  }
});

el('showJoinBtn').addEventListener('click', () => {
  el('joinBox').classList.toggle('hidden');
  el('joinCodeInput').focus();
});

el('joinSubmitBtn').addEventListener('click', () => attemptJoin());
el('joinCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptJoin(); });

async function attemptJoin() {
  const name = el('nameInput').value.trim();
  const code = el('joinCodeInput').value.trim().toUpperCase();
  if (!name) return setLandingError('Önce ismini yaz.');
  if (code.length !== 6) return setLandingError('Kod 6 karakter olmalı.');
  setLandingError('');
  setLandingLoading(true);
  try {
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) {
      setLandingError('Bu kodla bir oda bulunamadı.');
      return;
    }
    await enterRoom(code, name);
  } catch (err) {
    console.error(err);
    setLandingError('Bir şeyler ters gitti, tekrar dene.');
  } finally {
    setLandingLoading(false);
  }
}

function setLandingError(msg) { el('landingError').textContent = msg; }
function setLandingLoading(on) { el('landingLoading').classList.toggle('hidden', !on); }

/* =========================================================
   ODAYA GİRİŞ / ÇIKIŞ
   ========================================================= */
async function enterRoom(code, name) {
  state.uid = getOrCreateUid();
  state.name = name;
  state.roomCode = code;
  localStorage.setItem('wt_room', code);
  localStorage.setItem('wt_name', name);

  const userRef = db.ref(`rooms/${code}/users/${state.uid}`);
  await userRef.set({ name, online: true, joinedAt: firebase.database.ServerValue.TIMESTAMP });
  userRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });

  landingView.classList.add('hidden');
  roomView.classList.remove('hidden');
  el('roomCodeText').textContent = code;

  startConnectionWatcher();
  listenServerOffset();
  listenUsers();
  listenQueue();
  listenCurrentItem();
  listenPlayback();
  listenChat();
  listenReactions();
  listenTyping();
  listenHistory();

  pushSystemMessage(`${name} odaya katıldı`);
  requestNotifPermission(); /* bildirim izni iste — oda içindeyken sorulması doğal */
}

el('leaveRoomBtn').addEventListener('click', leaveRoom);

async function leaveRoom() {
  if (state.roomCode && state.uid) {
    pushSystemMessage(`${state.name} odadan çıktı`);
    try {
      /* Kullanıcıyı silmek yerine çevrimdışı yap + son görülmeyi yaz */
      await db.ref(`rooms/${state.roomCode}/users/${state.uid}`)
        .update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    } catch (e) {}
    try { await db.ref(`rooms/${state.roomCode}/typing/${state.uid}`).remove(); } catch (e) {}
  }
  clearAllListeners();
  hideEndCountdown();
  document.body.classList.remove('cinema-mode');
  localStorage.removeItem('wt_room');
  localStorage.removeItem('wt_name');
  pauseLocal();
  el('videoEl').src = '';
  state.currentItemId = null;
  state.roomCode = null;
  roomView.classList.add('hidden');
  landingView.classList.remove('hidden');
  el('joinCodeInput').value = '';
}

/* sayfa yenilenince odaya otomatik dön */
(async function autoRejoin() {
  const code = localStorage.getItem('wt_room');
  const name = localStorage.getItem('wt_name');
  if (code && name) {
    try {
      const snap = await db.ref(`rooms/${code}`).get();
      if (snap.exists()) { await enterRoom(code, name); return; }
    } catch (e) {}
    localStorage.removeItem('wt_room');
    localStorage.removeItem('wt_name');
  }
})();

/* =========================================================
   BAĞLANTI DURUMU
   ========================================================= */
function startConnectionWatcher() {
  trackListener(db.ref('.info/connected'), 'value', (snap) => {
    el('connIndicator').classList.toggle('online', snap.val() === true);
  });
}
function listenServerOffset() {
  trackListener(db.ref('.info/serverTimeOffset'), 'value', (snap) => {
    state.serverOffset = snap.val() || 0;
  });
}

/* =========================================================
   VARLIK / KULLANICI LİSTESİ
   ========================================================= */
function listenUsers() {
  trackListener(db.ref(`rooms/${state.roomCode}/users`), 'value', (snap) => {
    const data = snap.val() || {};
    const list = el('presenceList');
    list.innerHTML = '';
    Object.values(data).sort((a, b) => {
      /* çevrimiçi olanlar önce */
      if (a.online === b.online) return (a.name || '').localeCompare(b.name || '');
      return a.online ? -1 : 1;
    }).forEach((u) => {
      const pill = document.createElement('span');
      pill.className = 'presence-pill' + (u.online ? ' online' : '');

      /* Son görülme metni */
      let tooltip = u.online ? 'Çevrimiçi' : 'Çevrimdışı';
      if (!u.online && u.lastSeen) {
        const diff = Math.round((Date.now() - u.lastSeen) / 1000);
        if (diff < 60) tooltip = `${diff}sn önce görüldü`;
        else if (diff < 3600) tooltip = `${Math.round(diff/60)}dk önce görüldü`;
        else tooltip = `${Math.round(diff/3600)}sa önce görüldü`;
      }

      pill.innerHTML = `
        <span class="presence-dot"></span>
        ${escapeHtml(u.name || '?')}
        <span class="presence-tooltip">${tooltip}</span>
      `;
      list.appendChild(pill);
    });
  });
}

/* =========================================================
   KUYRUK (OYNATMA LİSTESİ)
   ========================================================= */
el('addLinkBtn').addEventListener('click', addLinkToQueue);
el('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLinkToQueue(); });

async function addLinkToQueue() {
  const input = el('linkInput');
  const raw = input.value.trim();
  if (!raw) return;
  const parsed = parseLink(raw);
  if (!parsed) { el('queueError').textContent = 'Geçerli bir link yapıştır.'; return; }
  el('queueError').textContent = '';

  if (parsed.type === 'youtube_playlist') {
    input.value = '';
    await addYoutubePlaylistToQueue(parsed.refId);
    return;
  }

  const ref = db.ref(`rooms/${state.roomCode}/queue`).push();
  await ref.set({
    type: parsed.type,
    refId: parsed.refId,
    title: parsed.title,
    addedBy: state.name,
    addedAt: firebase.database.ServerValue.TIMESTAMP,
  });

  if (!state.currentItemId) {
    await setCurrentItem(ref.key);
  }
  pushSystemMessage(`${state.name} listeye "${parsed.title}" videosunu ekledi`);
  input.value = '';

  if (parsed.type === 'drive') {
    showToast('Drive linki eklendi — dosya paylaşımı "bağlantıya sahip olan herkes" olmalı');
  }
}

/* --- YouTube oynatma listesi: tüm videoları sırayla kuyruğa ekler ---
   firebase-config.js içindeki YOUTUBE_API_KEY doldurulmadan çalışmaz. */
async function addYoutubePlaylistToQueue(playlistId) {
  const apiKey = (typeof YOUTUBE_API_KEY !== 'undefined' && YOUTUBE_API_KEY) ? YOUTUBE_API_KEY : '';
  if (!apiKey) {
    el('queueError').textContent = 'Oynatma listesi eklemek için firebase-config.js içine bir YouTube API anahtarı eklemelisin.';
    return;
  }
  showToast('Oynatma listesi taranıyor…');
  try {
    let pageToken = '';
    let added = 0;
    let firstKey = null;
    do {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${apiKey}${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'YouTube API hatası');
      for (const it of (json.items || [])) {
        const vid = it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId;
        if (!vid) continue;
        const title = (it.snippet.title || 'YouTube videosu').slice(0, 120);
        const ref = db.ref(`rooms/${state.roomCode}/queue`).push();
        await ref.set({
          type: 'youtube', refId: vid, title, addedBy: state.name,
          addedAt: firebase.database.ServerValue.TIMESTAMP,
        });
        if (!firstKey) firstKey = ref.key;
        added++;
      }
      pageToken = json.nextPageToken || '';
    } while (pageToken);

    if (added === 0) { showToast('Oynatma listesinde video bulunamadı'); return; }
    if (!state.currentItemId && firstKey) await setCurrentItem(firstKey);
    pushSystemMessage(`${state.name} oynatma listesinden ${added} video ekledi`);
    showToast(`${added} video listeye eklendi`);
  } catch (err) {
    console.error(err);
    showToast('Oynatma listesi eklenemedi, anahtarı ve bağlantıyı kontrol et');
  }
}

function listenQueue() {
  trackListener(db.ref(`rooms/${state.roomCode}/queue`), 'value', (snap) => {
    const data = snap.val() || {};
    state.queueCache = data;
    const keys = Object.keys(data); // push key'leri zaten kronolojik
    const hasOrder = keys.some((k) => typeof data[k].order === 'number');
    if (hasOrder) {
      keys.sort((a, b) => {
        const oa = typeof data[a].order === 'number' ? data[a].order : Infinity;
        const ob = typeof data[b].order === 'number' ? data[b].order : Infinity;
        if (oa !== ob) return oa - ob;
        return a < b ? -1 : 1; // eşitlikte kronolojik sırayı koru
      });
    }
    state.queueOrder = keys;
    renderQueue();
  });
}

function renderQueue() {
  const list = el('queueList');
  list.innerHTML = '';
  if (state.queueOrder.length === 0) {
    list.innerHTML = '<li class="queue-empty">Liste boş — yukarıdan bir link ekle</li>';
    return;
  }
  const typeIcon = { youtube: '▶', drive: '⛁', video: '🎬', kick: '🟣', twitch: '💜', twitch_vod: '💜', vimeo: '🎞' };
  state.queueOrder.forEach((key) => {
    const item = state.queueCache[key];
    const li = document.createElement('li');
    li.className = 'queue-item' + (key === state.currentItemId ? ' current' : '');
    li.dataset.key = key;
    li.innerHTML = `
      <span class="queue-drag-handle" title="Sürükleyerek sırala">⠿</span>
      <span class="queue-type">${typeIcon[item.type] || '🎬'}</span>
      <span class="queue-title">${escapeHtml(item.title || item.refId)}</span>
      <button class="queue-remove" aria-label="Kaldır">✕</button>
    `;
    li.querySelector('.queue-title').addEventListener('click', () => setCurrentItem(key));
    li.querySelector('.queue-type').addEventListener('click', () => setCurrentItem(key));
    li.querySelector('.queue-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeQueueItem(key);
    });
    attachDragHandlers(li);
    list.appendChild(li);
  });
}

/* =========================================================
   SÜRÜKLE-BIRAK İLE LİSTE SIRALAMA (Pointer Events — fare + dokunmatik)
   ========================================================= */
let dragState = null;

function attachDragHandlers(li) {
  const handle = li.querySelector('.queue-drag-handle');
  if (!handle) return;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragState = { pointerId: e.pointerId, li, startY: e.clientY };
    li.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const deltaY = e.clientY - dragState.startY;
    dragState.li.style.transform = `translateY(${deltaY}px)`;
    dragState.li.style.zIndex = '5';

    const list = el('queueList');
    const all = Array.from(list.querySelectorAll('.queue-item[data-key]'));
    const draggedIndex = all.indexOf(dragState.li);
    const draggedRect = dragState.li.getBoundingClientRect();
    const draggedMid = draggedRect.top + draggedRect.height / 2;

    all.forEach((sib, sibIndex) => {
      if (sib === dragState.li) return;
      const r = sib.getBoundingClientRect();
      const sibMid = r.top + r.height / 2;
      if (sibIndex < draggedIndex && draggedMid < sibMid) {
        list.insertBefore(dragState.li, sib);
      } else if (sibIndex > draggedIndex && draggedMid > sibMid) {
        list.insertBefore(dragState.li, sib.nextSibling);
      }
    });
  });

  const endDrag = (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    dragState.li.style.transform = '';
    dragState.li.style.zIndex = '';
    dragState.li.classList.remove('dragging');
    commitNewOrder();
    dragState = null;
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

function commitNewOrder() {
  const items = Array.from(el('queueList').querySelectorAll('.queue-item[data-key]'));
  if (!items.length || !state.roomCode) return;
  const updates = {};
  items.forEach((li, index) => {
    updates[`rooms/${state.roomCode}/queue/${li.dataset.key}/order`] = index;
  });
  db.ref().update(updates).catch((err) => console.error(err));
}

async function removeQueueItem(key) {
  await db.ref(`rooms/${state.roomCode}/queue/${key}`).remove();
  if (state.currentItemId === key) {
    await db.ref(`rooms/${state.roomCode}/currentItemId`).set(null);
    await db.ref(`rooms/${state.roomCode}/playback`).set({
      isPlaying: false, position: 0, speed: state.speed,
      updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: state.uid,
    });
  }
}

async function setCurrentItem(key) {
  const item = state.queueCache[key];
  await db.ref(`rooms/${state.roomCode}/currentItemId`).set(key);
  await db.ref(`rooms/${state.roomCode}/playback`).set({
    isPlaying: false, position: 0, speed: state.speed,
    updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: state.uid,
  });
  if (item) pushSystemMessage(`Sıradaki video "${item.title || item.refId}" olarak güncellendi`);
}

/* video doğal olarak bittiğinde çağrılır. Firebase transaction kullanılır ki
   her iki taraf da neredeyse aynı anda "bitti" sinyali alırsa geçmişe iki kez
   eklenmesin / kuyruktan iki kez silme denemesi çakışmasın — sadece "kazanan"
   istemci geçmiş kaydı oluşturur, diğeri sadece currentItemId güncellemesini izler. */
async function advanceQueue() {
  const finishedKey = state.currentItemId;
  const finishedItem = finishedKey ? state.queueCache[finishedKey] : null;
  const idx = state.queueOrder.indexOf(finishedKey);
  const nextKey = idx >= 0 ? (state.queueOrder[idx + 1] || null) : null;

  const itemRef = db.ref(`rooms/${state.roomCode}/currentItemId`);
  let result;
  try {
    result = await itemRef.transaction((current) => {
      if (current !== finishedKey) return; // başka biri zaten ilerletmiş, dokunma
      return nextKey;
    });
  } catch (err) {
    console.error(err);
    return;
  }
  if (!result.committed) return; // bu istemci "kazanmadı"

  if (finishedKey && finishedItem) {
    db.ref(`rooms/${state.roomCode}/history`).push({
      type: finishedItem.type, refId: finishedItem.refId, title: finishedItem.title,
      addedBy: finishedItem.addedBy || null, watchedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    db.ref(`rooms/${state.roomCode}/queue/${finishedKey}`).remove();
  }

  if (nextKey) {
    const nextItem = state.queueCache[nextKey];
    if (nextItem) pushSystemMessage(`Sıradaki video "${nextItem.title || nextItem.refId}" olarak güncellendi`);
  }

  await db.ref(`rooms/${state.roomCode}/playback`).set({
    isPlaying: !!nextKey, position: 0, speed: state.speed,
    updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: state.uid,
  });
}

/* =========================================================
   GEÇMİŞ — biten videolar buraya taşınır, listeden silinmez
   ========================================================= */
function listenHistory() {
  trackListener(db.ref(`rooms/${state.roomCode}/history`), 'value', (snap) => {
    const data = snap.val() || {};
    state.historyCache = data;
    state.historyOrder = Object.keys(data).reverse(); // en son izlenen en üstte
    renderHistory();
  });
}

function renderHistory() {
  const list = el('historyList');
  list.innerHTML = '';
  if (!state.historyOrder || state.historyOrder.length === 0) {
    list.innerHTML = '<li class="queue-empty">Henüz izlenmiş bir şey yok</li>';
    return;
  }
  const typeIcon = { youtube: '▶', drive: '⛁', video: '🎬', kick: '🟣', twitch: '💜', twitch_vod: '💜', vimeo: '🎞' };
  state.historyOrder.forEach((key) => {
    const item = state.historyCache[key];
    const li = document.createElement('li');
    li.className = 'queue-item history-item';
    li.innerHTML = `
      <span class="queue-type">${typeIcon[item.type] || '🎬'}</span>
      <span class="queue-title">${escapeHtml(item.title || item.refId)}</span>
      <button class="queue-remove history-readd" aria-label="Listeye geri ekle" title="Tekrar sıraya ekle">↺</button>
    `;
    li.querySelector('.history-readd').addEventListener('click', (e) => {
      e.stopPropagation();
      readdFromHistory(item);
    });
    list.appendChild(li);
  });
}

async function readdFromHistory(item) {
  const ref = db.ref(`rooms/${state.roomCode}/queue`).push();
  await ref.set({
    type: item.type, refId: item.refId, title: item.title,
    addedBy: state.name, addedAt: firebase.database.ServerValue.TIMESTAMP,
  });
  if (!state.currentItemId) await setCurrentItem(ref.key);
  showToast('Tekrar listeye eklendi');
}

/* =========================================================
   OYNATICI — currentItemId değişince doğru player'ı yükle
   ========================================================= */
function listenCurrentItem() {
  trackListener(db.ref(`rooms/${state.roomCode}/currentItemId`), 'value', (snap) => {
    state.currentItemId = snap.val();
    renderQueue();
    loadPlayerForCurrentItem();
  });
}

function loadPlayerForCurrentItem() {
  const item = state.currentItemId ? state.queueCache[state.currentItemId] : null;
  const stage = el('playerStage');
  const empty = el('playerEmpty');
  const ytHost = el('ytHost');
  const videoEl = el('videoEl');

  hideEndCountdown();

  if (!item) {
    stage.classList.remove('active');
    empty.classList.remove('hidden');
    el('speedSelect').classList.add('hidden');
    el('qualitySelect').classList.add('hidden');
    el('pipBtn').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  stage.classList.add('active');

  /* yeni video yüklenirken bir önceki videonun playback verisini geçici olarak
     uygulamayı önle — gerçek veri listenPlayback üzerinden hemen ardından gelecek */
  lastPlaybackSnapshot = { isPlaying: false, position: 0, speed: state.speed, updatedAt: serverTimeNow(), updatedBy: null };

  if (item.type === 'youtube') {
    state.currentType = 'youtube';
    el('liveHost').style.display = 'none';
    el('liveHost').innerHTML = '';
    videoEl.style.display = 'none';
    ytHost.style.display = 'block';
    videoEl.pause();
    videoEl.removeAttribute('src');
    el('qualitySelect').classList.remove('hidden');
    el('speedSelect').classList.remove('hidden');
    el('pipBtn').classList.add('hidden');
    setLiveBadge(false);
    el('seekRange').disabled = false;
    el('seekRange').style.opacity = '1';
    loadYoutube(item.refId);

  } else if (item.type === 'kick' || item.type === 'twitch' || item.type === 'twitch_vod' || item.type === 'vimeo') {
    state.currentType = 'iframe_live';
    /* ytHost artık YouTube'un kendi iframe'iyle değiştirilmiş olabilir — onu gizle */
    el('ytHost').style.display = 'none';
    videoEl.style.display = 'none';
    videoEl.pause(); videoEl.removeAttribute('src');
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();

    el('liveHost').style.display = 'block';
    el('qualitySelect').classList.add('hidden');
    el('speedSelect').classList.add('hidden');
    el('pipBtn').classList.add('hidden');

    const isLive = item.type === 'kick' || item.type === 'twitch';
    setLiveBadge(isLive);
    el('seekRange').disabled = isLive;
    el('seekRange').style.opacity = isLive ? '.3' : '1';

    loadIframePlayer(item);

  } else {
    state.currentType = 'html5';
    el('liveHost').style.display = 'none';
    el('liveHost').innerHTML = '';
    ytHost.style.display = 'none';
    videoEl.style.display = 'block';
    el('qualitySelect').classList.add('hidden');
    el('speedSelect').classList.add('hidden');
    setLiveBadge(false);
    el('seekRange').disabled = false;
    el('seekRange').style.opacity = '1';
    const pipSupported = !!(document.pictureInPictureEnabled || videoEl.webkitSupportsPresentationMode);
    el('pipBtn').classList.toggle('hidden', !pipSupported);
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
    const src = item.type === 'drive' ? driveStreamUrl(item.refId) : item.refId;
    if (videoEl.src !== src) { videoEl.src = src; videoEl.load(); }
  }
  /* Video yüklendi — mini player gerekip gerekmediğini kontrol et */
  setTimeout(() => { if (window._stickyCheck) window._stickyCheck(); }, 100);
}

/* =========================================================
   IFRAME OYNATICI — Kick / Twitch / Vimeo
   ========================================================= */
function loadIframePlayer(item) {
  const host = el('liveHost');
  host.innerHTML = ''; /* önceki iframe'i temizle */

  const iframe = document.createElement('iframe');
  iframe.allowFullscreen = true;
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'origin';

  const domain = window.location.hostname || 'localhost';

  if (item.type === 'kick') {
    /* Kick embed — muted=false ses açık başlatır */
    iframe.src = `https://player.kick.com/${encodeURIComponent(item.refId)}?autoplay=true&muted=false`;
  } else if (item.type === 'twitch') {
    /* Twitch canlı — parent parametresi sitenin alan adıyla eşleşmeli */
    iframe.src = `https://player.twitch.tv/?channel=${encodeURIComponent(item.refId)}&parent=${domain}&autoplay=true&muted=false`;
  } else if (item.type === 'twitch_vod') {
    /* Twitch VOD — video= öneki olmadan */
    iframe.src = `https://player.twitch.tv/?video=${encodeURIComponent(item.refId)}&parent=${domain}&autoplay=true`;
  } else if (item.type === 'vimeo') {
    iframe.src = `https://player.vimeo.com/video/${encodeURIComponent(item.refId)}?autoplay=1&byline=0&portrait=0&title=0`;
  }

  if (!iframe.src) return;
  host.appendChild(iframe);
}

/* ── Canlı yayın rozeti ── */
function setLiveBadge(show) {
  let badge = document.getElementById('liveBadge');
  if (show) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'liveBadge';
      badge.className = 'live-badge';
      badge.textContent = '🔴 CANLI';
      document.querySelector('.control-bar').prepend(badge);
    }
    badge.style.display = '';
    el('playPauseBtn').style.display    = 'none';
    el('currentTimeText').style.display = 'none';
    el('durationTimeText').style.display = 'none';
  } else {
    if (badge) badge.style.display = 'none';
    el('playPauseBtn').style.display    = '';
    el('currentTimeText').style.display = '';
    el('durationTimeText').style.display = '';
  }
}
(function loadYtApi() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();
window.onYouTubeIframeAPIReady = function () {
  state.ytApiReady = true;
  if (state.pendingYtVideoId) {
    const vid = state.pendingYtVideoId;
    state.pendingYtVideoId = null;
    loadYoutube(vid);
  }
};

function loadYoutube(videoId) {
  if (!state.ytApiReady) { state.pendingYtVideoId = videoId; return; }
  if (state.ytPlayer && state.ytPlayer.loadVideoById) {
    state.ytPlayer.loadVideoById(videoId);
    return;
  }
  state.ytPlayer = new YT.Player('ytHost', {
    videoId,
    playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1, iv_load_policy: 3 },
    events: {
      onReady: () => {
        applyRemoteStateNow();
        applyPreferredQuality();
        if (state.ytPlayer && state.ytPlayer.setPlaybackRate) state.ytPlayer.setPlaybackRate(state.speed);
      },
      onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) handleVideoEnded(); },
    },
  });
}

/* --- Video kalitesi (sadece YouTube, sadece bu cihazda — senkron edilmez) --- */
function applyPreferredQuality() {
  if (state.ytPlayer && state.ytPlayer.setPlaybackQuality) {
    state.ytPlayer.setPlaybackQuality(state.preferredQuality);
  }
}
el('qualitySelect').addEventListener('change', () => {
  state.preferredQuality = el('qualitySelect').value;
  applyPreferredQuality();
  showToast('Not: YouTube kaliteyi bazen kendi bant genişliğine göre otomatik geri ayarlayabilir');
});

/* --- HTML5 video element olayları --- */
el('videoEl').addEventListener('ended', handleVideoEnded);

/* =========================================================
   MİNİ YAPIŞKAN OYNATICI — video görünüm dışına kayınca köşeye tutunur
   ========================================================= */
(function initStickyPlayer() {
  const playerSection = document.querySelector('.player-section');
  const playerFrame   = document.querySelector('.player-frame');
  const placeholder   = el('playerFramePlaceholder');
  if (!playerSection || !playerFrame || !placeholder) return;

  const MARGIN = 14;
  let posX = MARGIN, posY = MARGIN;
  let stickyEnabled = true, isSticky = false;

  function syncPlaceholder() {
    placeholder.style.height = playerFrame.offsetHeight + 'px';
  }

  function enableSticky() {
    if (isSticky) return;
    isSticky = true;
    syncPlaceholder();
    applyPosition(posX, posY);
    playerSection.classList.add('sticky-active');
  }

  function disableSticky() {
    if (!isSticky) return;
    isSticky = false;
    playerSection.classList.remove('sticky-active');
    ['left','bottom','right','top','cursor','transition','width','height']
      .forEach((p) => playerFrame.style.removeProperty(p));
  }

  function applyPosition(x, y) {
    const w   = window.innerWidth <= 360 ? 230 : 280;
    const h   = window.innerWidth <= 360 ? 130 : 158;
    posX = Math.max(MARGIN, Math.min(x, window.innerWidth  - w - MARGIN));
    posY = Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN));
    playerFrame.style.left   = posX + 'px';
    playerFrame.style.bottom = posY + 'px';
    playerFrame.style.right  = 'auto';
    playerFrame.style.top    = 'auto';
  }

  /* Scroll tespiti: sticky=false → frame rect, sticky=true → placeholder rect.
     Hiçbiri asla aynı anda fixed olmuyor → feedback loop yok. */
  function check() {
    if (!stickyEnabled) return;
    const hasVideo = el('playerStage').classList.contains('active');
    if (!isSticky) {
      if (playerFrame.getBoundingClientRect().bottom < -10 && hasVideo) enableSticky();
    } else {
      if (placeholder.getBoundingClientRect().bottom > 10) disableSticky();
    }
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', () => { check(); if (isSticky) applyPosition(posX, posY); });
  /* Video yüklenince de kontrol et (loadPlayerForCurrentItem çağrısından sonra tetiklenir) */
  window._stickyCheck = check;

  el('stickyCloseBtn').addEventListener('click', () => {
    disableSticky();
    stickyEnabled = false;
    function recheckVisible() {
      if (playerFrame.getBoundingClientRect().bottom > 0) {
        stickyEnabled = true;
        window.removeEventListener('scroll', recheckVisible);
      }
    }
    window.addEventListener('scroll', recheckVisible, { passive: true });
  });

  /* Sürükle-bırak */
  let drag = null;
  playerFrame.addEventListener('pointerdown', (e) => {
    if (!isSticky) return;
    if (e.target.closest('button,select,input')) return;
    drag = { startPx: e.clientX, startPy: e.clientY, startX: posX, startY: posY };
    playerFrame.setPointerCapture(e.pointerId);
    playerFrame.style.cursor = 'grabbing';
    playerFrame.style.transition = 'none';
    e.preventDefault();
  });
  playerFrame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    applyPosition(drag.startX + (e.clientX - drag.startPx),
                  drag.startY - (e.clientY - drag.startPy));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    playerFrame.style.cursor = '';
    playerFrame.style.transition = '';
  };
  playerFrame.addEventListener('pointerup',     endDrag);
  playerFrame.addEventListener('pointercancel', endDrag);
})();

/* =========================================================
   OTOMATİK PİCTURE-IN-PICTURE
   Tarayıcı: visibilitychange anında PiP isteği reddedilebilir (kullanıcı
   etkileşimi şartı). Bu yüzden önce mini player açık mı kontrol ediyoruz;
   değilse PiP deneriz. YouTube iframe same-origin nedeniyle PiP yapılamaz.
   ========================================================= */
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden) return;
  if (!state.isPlaying || !state.currentItemId) return;

  if (state.currentType === 'html5') {
    const v = el('videoEl');
    /* Zaten PiP'teyse veya PiP desteklenmiyorsa çık */
    if (!v || !v.src || !v.readyState) return;
    if (document.pictureInPictureElement) return;
    if (!document.pictureInPictureEnabled) return;
    try {
      await v.requestPictureInPicture();
    } catch (e) {
      /* Bazı tarayıcılar kullanıcı etkileşimi olmadan reddeder — sessizce geç */
    }
  }
  /* YouTube: tarayıcı kendi PiP butonunu sunar, kod müdahale edemez */
});

/* PiP kapanınca sekme hâlâ arka plandaysa mini player aktif olsun */
document.addEventListener('leavepictureinpicture', () => {
  if (window._stickyCheck) window._stickyCheck();
});

/* =========================================================
   TARAYICI BİLDİRİMLERİ
   ========================================================= */
let notifPermission = ('Notification' in window) ? Notification.permission : 'denied';

async function requestNotifPermission() {
  if (!('Notification' in window)) return false;
  if (notifPermission === 'granted') return true;
  if (notifPermission === 'denied') return false;
  try {
    notifPermission = await Notification.requestPermission();
  } catch (e) { return false; }
  if (notifPermission !== 'granted') {
    showToast('Bildirim izni verilmedi — tarayıcı ayarlarından açabilirsin');
  }
  return notifPermission === 'granted';
}

function showChatNotification(senderName, text) {
  if (!('Notification' in window)) return;
  if (notifPermission !== 'granted') {
    /* İzin verilmemişse bir kez daha iste */
    requestNotifPermission();
    return;
  }
  if (!document.hidden) return;
  try {
    const body = text
      ? (text.length > 100 ? text.slice(0, 100) + '…' : text)
      : '📷 Resim gönderdi';
    const n = new Notification(`💬 ${senderName}`, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'birlikte-chat',
      renotify: true,
      silent: false,
    });
    n.addEventListener('click', () => { window.focus(); n.close(); });
    /* 8 saniye sonra otomatik kapat */
    setTimeout(() => n.close(), 8000);
  } catch (e) {}
}

/* Service Worker — HTTPS ortamında site kapalıyken bildirim için.
   updateViaCache:'none' → tarayıcı sw.js'i her zaman ağdan kontrol eder,
   böylece yeni versiyon deploy edilince tüm cihazlar anında güncellenir. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      /* Yeni SW varsa hemen aktifleştir — kullanıcı yenileme beklemez */
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            /* Tüm sekmelere "skipWaiting" mesajı gönder */
            newSW.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch(() => {});

  /* SW kontrolü değişince (yeni SW devreye girince) sayfayı yenile */
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) { refreshing = true; window.location.reload(); }
  });
}

/* --- Resim içinde resim (sadece HTML5 video) --- */
el('pipBtn').addEventListener('click', async () => {
  const v = el('videoEl');
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (v.requestPictureInPicture) {
      await v.requestPictureInPicture();
    } else if (v.webkitSetPresentationMode) { // Safari (iOS/macOS) için alternatif
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } else {
      showToast('Bu tarayıcı resim içinde resmi desteklemiyor');
    }
  } catch (err) {
    console.error(err);
    showToast('Resim içinde resim başlatılamadı');
  }
});

/* --- Süre metnine tıklayınca manuel zaman girişi ---
   Event delegation: controlBar dinleniyor, DOM'da replaceWith yapılsa bile çalışır.
   "90", "1:30", "1:02:15" formatlarını kabul eder. */
el('controlBar').addEventListener('click', (e) => {
  const timeEl = e.target.closest('#currentTimeText');
  if (!timeEl || timeEl.dataset.editing) return;
  timeEl.dataset.editing = '1';

  const original = timeEl.textContent;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = original;
  inp.style.cssText = [
    'width:58px','background:var(--surface)','color:var(--text)',
    'border:1px solid var(--accent)','border-radius:4px','font:inherit',
    'font-size:12px','text-align:center','padding:1px 4px',
    'font-family:var(--font-mono)','outline:none',
  ].join(';');

  function parseTime(raw) {
    const parts = raw.trim().split(':').map(Number);
    if (parts.some(isNaN)) return NaN;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function commitSeek() {
    inp.replaceWith(timeEl);
    delete timeEl.dataset.editing;
    const secs = parseTime(inp.value);
    if (!isNaN(secs) && secs >= 0) {
      const dur = getDuration();
      const clamped = dur > 0 ? Math.min(secs, dur) : secs;
      seekLocal(clamped);
      writePlayback(state.isPlaying, clamped);
    }
  }

  function cancelSeek() {
    inp.replaceWith(timeEl);
    delete timeEl.dataset.editing;
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitSeek(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelSeek(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commitSeek);
  timeEl.replaceWith(inp);
  inp.select();
});

el('currentTimeText').style.cursor = 'pointer';
el('currentTimeText').title = 'Tıkla → süre gir';
el('cinemaBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('cinema-mode');
  el('cinemaBtn').classList.toggle('active', on);
});

/* =========================================================
   TAM EKRAN
   ========================================================= */
el('fullscreenBtn').addEventListener('click', () => {
  const stage = document.querySelector('.player-frame');
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req) req.call(stage).catch(() => {});
  } else {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex) ex.call(document).catch(() => {});
  }
});
function updateFullscreenBtn() {
  const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
  el('fullscreenBtn').classList.toggle('active', active);
  el('fullscreenBtn').textContent = active ? '⊠' : '⛶';
  el('fullscreenBtn').title = active ? 'Tam ekrandan çık' : 'Tam ekran';
}
document.addEventListener('fullscreenchange',       updateFullscreenBtn);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

/* =========================================================
   DAVET LİNKİ + QR KOD
   QR oluşturmak için dışa bağımlılık yok — saf canvas ile çiziyoruz.
   ========================================================= */
el('inviteBtn').addEventListener('click', openInviteModal);

function openInviteModal() {
  if (!state.roomCode) return;
  const url = `${location.origin}${location.pathname}?join=${state.roomCode}`;
  el('inviteLinkInput').value = url;

  /* QR kodu canvas ile oluştur */
  const qrDiv = el('inviteQr');
  qrDiv.innerHTML = '';
  drawQrCanvas(url, qrDiv);

  /* Web Share API desteği varsa butonu göster */
  if (navigator.share) el('inviteShareBtn').style.display = '';

  el('inviteModal').classList.remove('hidden');
}

el('inviteModalClose').addEventListener('click', () => el('inviteModal').classList.add('hidden'));
el('inviteModal').addEventListener('click', (e) => {
  if (e.target === el('inviteModal')) el('inviteModal').classList.add('hidden');
});

el('inviteCopyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(el('inviteLinkInput').value)
    .then(() => showToast('Link kopyalandı 🔗'))
    .catch(() => {
      el('inviteLinkInput').select();
      document.execCommand('copy');
      showToast('Link kopyalandı 🔗');
    });
});

el('inviteShareBtn').addEventListener('click', () => {
  navigator.share({
    title: 'birlikte',
    text : `Benimle birlikte izleyelim! Oda kodu: ${state.roomCode}`,
    url  : el('inviteLinkInput').value,
  }).catch(() => {});
});

/* URL'de ?join=XXXXX varsa otomatik doldur */
(function checkInviteParam() {
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    el('joinCodeInput').value = joinCode.toUpperCase();
    el('joinBox').classList.remove('hidden');
    /* URL'i temizle (sayfa yenilemede tekrar tetiklenmesin) */
    history.replaceState({}, '', location.pathname);
  }
})();

/* ── Minimal QR canvas çizici (Reed-Solomon gerektirmeyen küçük URL'ler için) ──
   Büyük URL'lerde kalite düşebilir; harici kütüphane kullanımı önerilebilir.
   Buradaki uygulama basit bir hata düzeltme seviyesi-L QR matrisi üretir.      */
function drawQrCanvas(text, container) {
  /* qrcodejs kütüphanesi CDN'den yükle (tek seferlik) */
  if (window._qrLoaded) {
    _createQr(text, container);
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  script.onload = () => { window._qrLoaded = true; _createQr(text, container); };
  script.onerror = () => {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center">QR yüklenemedi — linki kopyala</p>';
  };
  document.head.appendChild(script);
}
function _createQr(text, container) {
  try {
    new QRCode(container, {
      text, width: 180, height: 180,
      colorDark: '#1a1330', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;text-align:center">QR oluşturulamadı</p>';
  }
}

/* =========================================================
   SESLİ MESAJ — MediaRecorder API
   ========================================================= */
let mediaRecorder = null;
let audioChunks   = [];
let recordingTimer = null;
const MAX_RECORD_SEC = 60;

el('voiceBtn').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
});

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Bu tarayıcı ses kaydını desteklemiyor');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    audioChunks = [];
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    });
    mediaRecorder.addEventListener('stop', finalizeRecording);
    mediaRecorder.start(250); // her 250ms'de chunk al

    el('voiceBtn').classList.add('recording');
    el('voiceBtn').title = 'Durdurmak için tıkla';
    showToast('🎙 Kayıt başladı — durdurmak için tekrar bas');

    let elapsed = 0;
    recordingTimer = setInterval(() => {
      elapsed++;
      if (elapsed >= MAX_RECORD_SEC) stopRecording();
    }, 1000);
  } catch (err) {
    showToast('Mikrofon izni gerekli');
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  clearInterval(recordingTimer);
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  el('voiceBtn').classList.remove('recording');
  el('voiceBtn').title = 'Sesli mesaj';
}

async function finalizeRecording() {
  const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
  const durationSec = Math.round(audioChunks.length * 0.25); // yaklaşık süre

  /* Base64'e çevir ve Firebase'e yaz */
  const reader = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result; // data:audio/...;base64,...
    db.ref(`rooms/${state.roomCode}/chat`).push({
      name   : state.name,
      type   : 'voice',
      text   : base64,
      duration: durationSec,
      sentAt : firebase.database.ServerValue.TIMESTAMP,
    }).catch((err) => {
      console.error('voice-msg error:', err);
      showToast('Sesli mesaj gönderilemedi');
    });
  };
  reader.readAsDataURL(blob);
  mediaRecorder = null;
  audioChunks   = [];
}

/* =========================================================
   VİDEO BİTİŞ GERİ SAYIMI — direkt advanceQueue yerine önce sayaç gösterir
   ========================================================= */
let endCountdownTimer = null;

function handleVideoEnded() {
  const idx = state.queueOrder.indexOf(state.currentItemId);
  const hasNext = idx >= 0 && !!state.queueOrder[idx + 1];
  if (!hasNext) { advanceQueue(); return; } // sırada video yoksa beklemeden bitir
  showEndCountdown();
}

function showEndCountdown() {
  clearTimeout(endCountdownTimer);
  const overlay = el('endCountdown');
  const numberEl = el('countdownNumber');
  const ring = el('countdownRingFg');
  const TOTAL = 5;
  let remaining = TOTAL;
  const circumference = 2 * Math.PI * 28;

  overlay.classList.remove('hidden');
  numberEl.textContent = String(remaining);
  ring.style.strokeDasharray = String(circumference);
  ring.style.strokeDashoffset = '0';

  function tick() {
    remaining -= 1;
    if (remaining <= 0) { hideEndCountdown(); advanceQueue(); return; }
    numberEl.textContent = String(remaining);
    ring.style.strokeDashoffset = String(circumference * (1 - remaining / TOTAL));
    endCountdownTimer = setTimeout(tick, 1000);
  }
  endCountdownTimer = setTimeout(tick, 1000);
}

function hideEndCountdown() {
  clearTimeout(endCountdownTimer);
  el('endCountdown').classList.add('hidden');
}

el('countdownSkipBtn').addEventListener('click', () => {
  hideEndCountdown();
  advanceQueue();
});

/* =========================================================
   ORTAK OYNATICI KONTROLLERİ (yt + html5 ortak arayüz)
   ========================================================= */
function getCurrentPlayerTime() {
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.getCurrentTime) {
    return state.ytPlayer.getCurrentTime() || 0;
  }
  if (state.currentType === 'html5') return el('videoEl').currentTime || 0;
  return 0; /* iframe_live: anlık zaman yok */
}
function getDuration() {
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.getDuration) {
    return state.ytPlayer.getDuration() || 0;
  }
  if (state.currentType === 'html5') return el('videoEl').duration || 0;
  return 0;
}
function playLocal() {
  state.isPlaying = true;
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.playVideo) state.ytPlayer.playVideo();
  if (state.currentType === 'html5') el('videoEl').play().catch(() => {});
  /* iframe_live: iframe kendi oynatmasını yönetir */
  updatePlayButtonUi();
}
function pauseLocal() {
  state.isPlaying = false;
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
  if (state.currentType === 'html5') el('videoEl').pause();
  updatePlayButtonUi();
}
function seekLocal(t) {
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.seekTo) state.ytPlayer.seekTo(t, true);
  if (state.currentType === 'html5') el('videoEl').currentTime = t;
  /* iframe_live: seek yok */
}
function updatePlayButtonUi() {
  el('playIcon').textContent = state.isPlaying ? '❚❚' : '▶';
}

function writePlayback(isPlaying, position) {
  db.ref(`rooms/${state.roomCode}/playback`).set({
    isPlaying, position, speed: state.speed,
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
    updatedBy: state.uid,
  });
}

/* --- "Beni Yakala": veritabanından anlık veriyi çekip eşik beklemeden zorla senkronize eder --- */
el('forceSyncBtn').addEventListener('click', async () => {
  if (!state.roomCode) return;
  showToast('Senkronize ediliyor…');
  try {
    const snap = await db.ref(`rooms/${state.roomCode}/playback`).get();
    const data = snap.val();
    if (!data) { showToast('Henüz oynatma verisi yok'); return; }
    lastPlaybackSnapshot = data;
    const serverNow = serverTimeNow();
    const updatedAt = data.updatedAt || serverNow;
    const elapsed = data.isPlaying ? Math.max(0, (serverNow - updatedAt) / 1000) : 0;
    const targetPos = Math.max(0, (data.position || 0) + elapsed);

    seekLocal(targetPos); // eşik kontrolü olmadan doğrudan zorla
    if (data.isPlaying && !state.isPlaying) playLocal();
    if (!data.isPlaying && state.isPlaying) pauseLocal();
    state.isPlaying = data.isPlaying;
    updatePlayButtonUi();
    hideEndCountdown();
    showToast('Yakalandın 🔄');
  } catch (err) {
    console.error(err);
    showToast('Senkronize edilemedi, tekrar dene');
  }
});

/* --- Oynatma hızı senkronu (sadece YouTube) --- */
el('speedSelect').addEventListener('change', () => {
  const rate = parseFloat(el('speedSelect').value) || 1;
  state.speed = rate;
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.setPlaybackRate) {
    state.ytPlayer.setPlaybackRate(rate);
  }
  if (state.roomCode) db.ref(`rooms/${state.roomCode}/playback/speed`).set(rate);
});

el('playPauseBtn').addEventListener('click', () => {
  if (state.isPlaying) { pauseLocal(); writePlayback(false, getCurrentPlayerTime()); }
  else { playLocal(); writePlayback(true, getCurrentPlayerTime()); }
});

const seekRange = el('seekRange');
seekRange.addEventListener('mousedown', () => state.seekDragging = true);
seekRange.addEventListener('touchstart', () => state.seekDragging = true);
seekRange.addEventListener('change', () => {
  const t = parseFloat(seekRange.value);
  seekLocal(t);
  writePlayback(state.isPlaying, t);
  state.seekDragging = false;
  hideEndCountdown();
});

/* ilerleme çubuğunu periyodik güncelle */
setInterval(() => {
  if (state.seekDragging) return;
  const cur = getCurrentPlayerTime();
  const dur = getDuration();
  if (dur > 0) { seekRange.max = dur; seekRange.value = cur; }
  el('currentTimeText').textContent = fmtTime(cur);
  el('durationTimeText').textContent = fmtTime(dur);
}, 500);

/* =========================================================
   PLAYBACK SENKRONİZASYONU (Firebase -> yerel oynatıcı)
   ========================================================= */
let lastPlaybackSnapshot = null;
function listenPlayback() {
  trackListener(db.ref(`rooms/${state.roomCode}/playback`), 'value', (snap) => {
    lastPlaybackSnapshot = snap.val();
    applyRemoteStateNow();
  });
}

function applyRemoteStateNow() {
  const data = lastPlaybackSnapshot;
  if (!data) return;
  if (state.seekDragging) return; // kullanıcı çubuğu sürüklerken müdahale etme
  const serverNow = serverTimeNow();
  const updatedAt = data.updatedAt || serverNow; // sunucu damgası henüz çözülmemişse şimdiyi kullan
  const elapsed = data.isPlaying ? Math.max(0, (serverNow - updatedAt) / 1000) : 0;
  const targetPos = Math.max(0, (data.position || 0) + elapsed);
  const cur = getCurrentPlayerTime();

  if (Math.abs(cur - targetPos) > 0.75) {
    seekLocal(targetPos);
    hideEndCountdown(); // büyük bir düzeltme oldu, video artık bitmek üzere değil
  }
  if (data.isPlaying && !state.isPlaying) playLocal();
  if (!data.isPlaying && state.isPlaying) pauseLocal();
  state.isPlaying = data.isPlaying;
  updatePlayButtonUi();

  /* oynatma hızı senkronu (yalnızca YouTube'da uygulanır) */
  const remoteSpeed = data.speed || 1;
  if (remoteSpeed !== state.speed) {
    state.speed = remoteSpeed;
    el('speedSelect').value = String(remoteSpeed);
    if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.setPlaybackRate) {
      state.ytPlayer.setPlaybackRate(remoteSpeed);
    }
  }
}

/* periyodik kayma düzeltmesi — oynatma sırasında taraflar arası sapmayı sürekli denetler.
   Önceden senkron sadece biri play/pause/seek yaptığında uygulanıyordu; bu yüzden
   buffering/gecikme kaynaklı kaymalar hiç düzelmiyordu. */
setInterval(() => {
  if (document.hidden) return; // sekme arka plandayken gereksiz seek tetikleme
  applyRemoteStateNow();
}, 2000);

/* sekme tekrar görünür olduğunda (arka planda zamanlayıcılar yavaşlatılmış olabilir) anında düzelt */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyRemoteStateNow();
});

/* =========================================================
   SEKME GEÇİŞİ (Liste / Sohbet — sadece mobilde anlamlı)
   ========================================================= */
el('tabQueueBtn').addEventListener('click', () => switchTab('queue'));
el('tabHistoryBtn').addEventListener('click', () => switchTab('history'));
el('tabChatBtn').addEventListener('click', () => switchTab('chat'));
function switchTab(tab) {
  state.activeTab = tab;
  el('tabQueueBtn').classList.toggle('active', tab === 'queue');
  el('tabHistoryBtn').classList.toggle('active', tab === 'history');
  el('tabChatBtn').classList.toggle('active', tab === 'chat');
  el('queuePanel').classList.toggle('hidden', tab !== 'queue');
  el('historyPanel').classList.toggle('hidden', tab !== 'history');
  el('chatPanel').classList.toggle('hidden', tab !== 'chat');
  if (tab === 'chat') clearUnreadChat();
}

const desktopQuery = window.matchMedia('(min-width: 920px)');
function isChatVisible() {
  return desktopQuery.matches || state.activeTab === 'chat';
}
desktopQuery.addEventListener('change', () => { if (isChatVisible()) clearUnreadChat(); });

function clearUnreadChat() {
  state.unreadChat = 0;
  el('chatUnreadDot').classList.add('hidden');
}
function markUnreadChat() {
  state.unreadChat += 1;
  el('chatUnreadDot').classList.remove('hidden');
}

/* =========================================================
   SOHBET
   ========================================================= */
el('sendChatBtn').addEventListener('click', sendChat);
el('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;
  pushChatMessage('text', text);
  input.value = '';
  clearTimeout(typingTimeout);
  setTypingState(false);
}

/* --- "yazıyor..." göstergesi --- */
let typingTimeout = null;
el('chatInput').addEventListener('input', () => {
  if (!state.roomCode) return;
  setTypingState(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => setTypingState(false), 2000);
});
el('chatInput').addEventListener('blur', () => { clearTimeout(typingTimeout); setTypingState(false); });

function setTypingState(isTyping) {
  if (!state.roomCode || !state.uid) return;
  const ref = db.ref(`rooms/${state.roomCode}/typing/${state.uid}`);
  if (isTyping) {
    ref.set({ name: state.name, at: firebase.database.ServerValue.TIMESTAMP });
    ref.onDisconnect().remove();
  } else {
    ref.remove();
  }
}

function listenTyping() {
  trackListener(db.ref(`rooms/${state.roomCode}/typing`), 'value', (snap) => {
    const data = snap.val() || {};
    const others = Object.entries(data)
      .filter(([uid]) => uid !== state.uid)
      .map(([, v]) => v && v.name)
      .filter(Boolean);
    const indicator = el('typingIndicator');
    if (others.length === 0) { indicator.classList.add('hidden'); indicator.textContent = ''; return; }
    indicator.textContent = others.length === 1
      ? `${others[0]} yazıyor…`
      : `${others.join(', ')} yazıyor…`;
    indicator.classList.remove('hidden');
  });
}

function pushChatMessage(type, text) {
  db.ref(`rooms/${state.roomCode}/chat`).push({
    name: state.name, type, text, sentAt: firebase.database.ServerValue.TIMESTAMP,
  });
}

/* --- çıkartmalar --- */
const stickerBtn = el('stickerBtn');
const stickerPicker = el('stickerPicker');
stickerBtn.addEventListener('click', () => {
  stickerPicker.classList.toggle('hidden');
  stickerBtn.classList.toggle('active', !stickerPicker.classList.contains('hidden'));
});
stickerPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('.sticker-item');
  if (!btn) return;
  pushChatMessage('sticker', btn.dataset.emoji);
  stickerPicker.classList.add('hidden');
  stickerBtn.classList.remove('active');
});

/* --- resim ekleme (Firebase Storage olmadan, küçültülmüş base64 olarak chat'e yazılır) --- */
const imageFileInput = el('imageFileInput');
el('imageBtn').addEventListener('click', () => imageFileInput.click());
imageFileInput.addEventListener('change', async () => {
  const file = imageFileInput.files && imageFileInput.files[0];
  imageFileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { showToast('Sadece resim dosyası eklenebilir'); return; }
  showToast('Resim hazırlanıyor…');
  try {
    const dataUrl = await resizeImageToDataUrl(file, 700, 0.65);
    if (dataUrl.length > 700000) { showToast('Resim çok büyük, daha küçük bir resim dene'); return; }
    pushChatMessage('image', dataUrl);
  } catch (err) {
    console.error(err);
    showToast('Resim eklenemedi, tekrar dene');
  }
});

function resizeImageToDataUrl(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* --- büyütülmüş resim (lightbox) --- */
const lightbox = el('lightbox');
lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
function openLightbox(src) {
  el('lightboxImg').src = src;
  lightbox.classList.remove('hidden');
}

/* =========================================================
   ANLIK EMOJİ TEPKİLERİ (ekranda uçuşan)
   ========================================================= */
const reactionsLayer = el('reactionsLayer');
el('reactionBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn || !state.roomCode) return;
  const ref = db.ref(`rooms/${state.roomCode}/reactions`).push();
  ref.set({ emoji: btn.dataset.emoji, sentAt: firebase.database.ServerValue.TIMESTAMP, sentBy: state.uid });
  setTimeout(() => ref.remove().catch(() => {}), 6000); // veritabanını şişirmesin
  spawnFlyingEmoji(btn.dataset.emoji); // kendi tepkimizi de hemen göster
});

function listenReactions() {
  const joinedAt = serverTimeNow();
  const ref = db.ref(`rooms/${state.roomCode}/reactions`).limitToLast(20);
  trackListener(ref, 'child_added', (snap) => {
    const r = snap.val();
    if (!r || !r.sentAt) return;
    if (r.sentBy === state.uid) return; // kendi tepkimizi zaten anlık gösterdik
    if (r.sentAt < joinedAt - 4000) return; // odaya girerken eski tepkileri tekrar oynatma
    spawnFlyingEmoji(r.emoji);
  });
}

function spawnFlyingEmoji(emoji) {
  const span = document.createElement('span');
  span.className = 'flying-emoji';
  span.textContent = emoji;
  span.style.right = (8 + Math.random() * 22) + '%';
  span.style.setProperty('--drift', (Math.random() * 50 - 25) + 'px');
  reactionsLayer.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
}

/* =========================================================
   SİSTEM BİLDİRİM MESAJLARI (oda olaylarını sohbete düşürür)
   ========================================================= */
function pushSystemMessage(text) {
  if (!state.roomCode) return;
  /* Firebase kuralı name+text+sentAt zorunlu kılıyor;
     sistem mesajları için sabit bir işaretleyici isim kullanılıyor */
  db.ref(`rooms/${state.roomCode}/chat`).push({
    name: '🔔',        // validate kuralının "name" şartını karşılar
    type: 'system',
    text,
    sentAt: firebase.database.ServerValue.TIMESTAMP,
  }).catch((err) => console.error('system-msg write failed:', err));
}

function listenChat() {
  const messages = el('chatMessages');
  messages.innerHTML = '';
  state.chatHistoryLoaded = false;
  const ref = db.ref(`rooms/${state.roomCode}/chat`).limitToLast(100);
  trackListener(ref, 'child_added', (snap) => {
    const msg = snap.val();
    const type = msg.type || 'text';
    const bubble = document.createElement('div');

    if (type === 'system') {
      bubble.className = 'chat-msg system';
      bubble.textContent = msg.text;
      messages.appendChild(bubble);
      messages.scrollTop = messages.scrollHeight;
      return;
    }

    const isOwn = msg.name === state.name;
    bubble.className = `chat-msg ${isOwn ? 'own' : 'other'} ${type}`;

    if (type === 'sticker') {
      bubble.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
    } else if (type === 'voice' && typeof msg.text === 'string' && msg.text.startsWith('data:audio')) {
      bubble.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}</span>`;
      const wrap = document.createElement('div');
      wrap.className = 'voice-msg-wrap';
      const dur = msg.duration ? fmtTime(msg.duration) : '—';
      const playBtn = document.createElement('button');
      playBtn.className = 'voice-play-btn';
      playBtn.textContent = '▶';
      const wave = document.createElement('div');
      wave.className = 'voice-waveform';
      wave.style.background = `linear-gradient(90deg,var(--accent-soft) 0%,var(--border) 0%)`;
      const durSpan = document.createElement('span');
      durSpan.className = 'voice-duration';
      durSpan.textContent = dur;
      wrap.appendChild(playBtn);
      wrap.appendChild(wave);
      wrap.appendChild(durSpan);
      bubble.appendChild(wrap);

      /* Oynatma mantığı */
      let audio = null;
      let raf = null;
      playBtn.addEventListener('click', () => {
        if (audio && !audio.paused) {
          audio.pause();
          playBtn.textContent = '▶';
          cancelAnimationFrame(raf);
          return;
        }
        audio = new Audio(msg.text);
        playBtn.textContent = '⏸';
        audio.play().catch(() => {});
        function updateBar() {
          if (!audio || audio.paused) return;
          const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
          wave.style.background = `linear-gradient(90deg,var(--accent) ${pct}%,var(--border) ${pct}%)`;
          durSpan.textContent = fmtTime(Math.round(audio.currentTime));
          raf = requestAnimationFrame(updateBar);
        }
        audio.addEventListener('play', updateBar);
        audio.addEventListener('ended', () => {
          playBtn.textContent = '▶';
          wave.style.background = `linear-gradient(90deg,var(--accent-soft) 0%,var(--border) 0%)`;
          durSpan.textContent = dur;
          cancelAnimationFrame(raf);
        });
      });
    } else if (type === 'image' && typeof msg.text === 'string' && msg.text.startsWith('data:image/')) {
      bubble.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}</span>`;
      const img = document.createElement('img');
      img.src = msg.text;
      img.addEventListener('click', () => openLightbox(msg.text));
      bubble.appendChild(img);
    } else {
      bubble.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
    }

    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;

    if (state.chatHistoryLoaded && !isOwn && !isChatVisible()) {
      markUnreadChat();
      showChatNotification(msg.name, type === 'text' ? msg.text : null);
    }
  });
  setTimeout(() => { state.chatHistoryLoaded = true; }, 700);
}

/* =========================================================
   ODA KODUNU KOPYALA
   ========================================================= */
el('roomCodeTicket').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomCode || '').then(() => showToast('Kod kopyalandı'));
});

/* =========================================================
   GÜVENLİK: basit HTML kaçışı (chat / başlıklarda XSS önle)
   ========================================================= */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
