'use strict';

/* =========================================================
   STATE
   ========================================================= */
const state = {
  uid: null,
  name: '',
  roomCode: null,
  serverOffset: 0,
  queueCache: {},
  queueOrder: [],
  historyCache: {},
  historyOrder: [],
  currentItemId: null,
  currentType: null,    // 'youtube' | 'html5' | 'iframe_live'
  isPlaying: false,
  speed: 1,
  listeners: [],
  ytPlayer: null,
  ytApiReady: false,
  pendingYtVideoId: null,
  seekDragging: false,
  preferredQuality: 'default',
  activeTab: 'queue',
  chatHistoryLoaded: false,
  unreadChat: 0,
  isAdmin: false,       // oda sahibi mi?
  canControl: false,    // oynatma kontrolü var mı? (admin veya yetkilendirilmiş)
  userRef: null,        // kendi users/{uid} düğümümüzün referansı (onDisconnect iptali için)
  localFiles: {},       // localId -> { file, url }  (cihazımızdan yayınladığımız videolar)
  isStreamHost: false,  // şu an oynayan video bizim cihazımızdan mı yayınlanıyor?
};

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
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
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
  stopAllStreaming();
  revokeLocalFiles();
}

/* =========================================================
   YETKİ / KONTROL GÖRÜNÜRLÜğÜ
   ========================================================= */
function updateControlsVisibility() {
  const can = state.canControl || state.isStreamHost;
  // Play/pause butonu
  el('playPauseBtn').classList.toggle('hidden', !can);
  // Seek çubuğu
  el('seekRange').classList.toggle('hidden', !can);
  // Hız seçimi (senkronize olduğu için sadece admin/yetkili)
  // — loadPlayerForCurrentItem'da ayrıca kontrol ediliyor, burada sadece kalıcı gizleme
  if (!can && !el('speedSelect').classList.contains('hidden')) {
    el('speedSelect').classList.add('hidden');
  }
}

/* Yetkili kullanıcının kontrolü yoksa seek/play işlemlerini engelle */
function canWrite() { return state.canControl && !!state.roomCode; }

/* Oynat/durdur/ileri sar yetkisi: yayını izleyenlerde kapalı, yayıncıda açık */
function canControlPlayback() {
  if (!state.roomCode) return false;
  if (state.currentType === 'stream') return false;   // izleyici: kontrol yayıncıda
  if (state.isStreamHost) return true;                // kendi dosyasını yayınlayan
  return state.canControl;
}

/* =========================================================
   CANLI YAYIN — cihazındaki videoyu odaya yayınla (WebRTC)
   Video hiçbir sunucuya yüklenmez. Yayıncının tarayıcısı videoyu
   oynatır, görüntüyü doğrudan izleyicilere aktarır. Firebase sadece
   bağlantı kurulumu (sinyalleşme) için kullanılır: rooms/{kod}/rtc/
   ========================================================= */
const STREAM_MAX_KBPS = 3000;   // izleyici başına en fazla video bit hızı (yayıncının yükleme hızını korur)
const rtc = {
  role: null,          // 'host' | 'viewer' | null
  key: null,           // yayındaki kuyruk öğesinin anahtarı
  sid: null,           // izleyici oturum kimliği
  ready: null,         // yayıncı: yakalanan MediaStream sözü
  peers: {},           // yayıncı: sid -> { pc, listeners }
  viewerPc: null,
  remoteStream: null,
  listeners: [],
  timeout: null,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rtcConfig() {
  const servers = (typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? ICE_SERVERS : [{ urls: 'stun:stun.l.google.com:19302' }];
  return { iceServers: servers };
}
function canCaptureMedia() {
  return !!(HTMLMediaElement.prototype.captureStream || HTMLMediaElement.prototype.mozCaptureStream);
}
function rtcListen(list, ref, event, handler) { ref.on(event, handler); list.push({ ref, event, handler }); }
function rtcUnlisten(list) { list.forEach(({ ref, event, handler }) => ref.off(event, handler)); list.length = 0; }
function plainJson(o) { return JSON.parse(JSON.stringify(o)); }   // Firebase undefined kabul etmez
function addCand(pc, cand) {
  if (!cand) return;
  if (pc.remoteDescription) pc.addIceCandidate(cand).catch(() => {});
  else (pc._pending = pc._pending || []).push(cand);
}
function flushCands(pc) {
  (pc._pending || []).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  pc._pending = [];
}
function limitVideoBitrate(pc) {
  pc.getSenders().forEach((s) => {
    if (!s.track || s.track.kind !== 'video') return;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = STREAM_MAX_KBPS * 1000;
      s.setParameters(p).catch(() => {});
    } catch (e) {}
  });
}

/* ---------- Yayıncı tarafı ---------- */
function startHostBroadcast(key) {
  if (!canCaptureMedia()) {
    showToast('Bu tarayıcı video yayınlayamıyor (Chrome, Edge ya da Firefox kullan) — sadece sen izleyebilirsin');
    return;
  }
  const v = el('videoEl');
  rtc.role = 'host';
  rtc.key = key;
  rtc.ready = new Promise((resolve) => {
    const capture = async () => {
      if (rtc.key !== key) { resolve(null); return; }
      try {
        const cap = v.captureStream ? v.captureStream() : v.mozCaptureStream();
        // Büyük/uzun dosyalarda ilk karenin hazır olması daha uzun sürebilir
        for (let i = 0; i < 60 && cap.getTracks().length === 0; i++) await sleep(200);
        if (rtc.key !== key) { resolve(null); return; }
        resolve(cap.getTracks().length ? cap : null);
      } catch (e) { console.error(e); resolve(null); }
    };
    if (v.readyState >= 2) capture();
    else v.addEventListener('loadeddata', capture, { once: true });
  });
  rtc.ready.then((cap) => { if (!cap && rtc.key === key) showToast('Video yayına hazırlanamadı'); });

  const base = db.ref(`rooms/${state.roomCode}/rtc/${key}`);
  rtcListen(rtc.listeners, base, 'child_added', (s) => hostAcceptViewer(key, s.key));
  rtcListen(rtc.listeners, base, 'child_removed', (s) => hostDropViewer(s.key));
}

async function hostAcceptViewer(key, sid) {
  if (rtc.role !== 'host' || rtc.key !== key) return;
  const stream = await rtc.ready;
  if (!stream || rtc.role !== 'host' || rtc.key !== key) return;

  const vref = db.ref(`rooms/${state.roomCode}/rtc/${key}/${sid}`);
  // Bu arada izleyici ayrıldıysa boşuna teklif yazma
  try { if (!(await vref.child('join').get()).exists()) return; } catch (e) { return; }
  if (rtc.role !== 'host' || rtc.key !== key) return;

  hostDropViewer(sid);
  const pc = new RTCPeerConnection(rtcConfig());
  const peer = { pc, listeners: [] };
  rtc.peers[sid] = peer;

  stream.getTracks().forEach((t) => {
    if (t.kind === 'video') { try { t.contentHint = 'motion'; } catch (e) {} }
    pc.addTrack(t, stream);
  });
  pc.onicecandidate = (e) => { if (e.candidate) vref.child('hostCand').push(plainJson(e.candidate)); };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    limitVideoBitrate(pc);
    await vref.child('offer').set({ type: offer.type, sdp: offer.sdp });
  } catch (e) { console.error('Teklif oluşturulamadı:', e); return; }

  rtcListen(peer.listeners, vref.child('answer'), 'value', async (s) => {
    const ans = s.val();
    if (!ans || pc.remoteDescription || pc.signalingState === 'closed') return;
    try { await pc.setRemoteDescription(ans); flushCands(pc); } catch (e) { console.error(e); }
  });
  rtcListen(peer.listeners, vref.child('viewerCand'), 'child_added', (s) => addCand(pc, s.val()));
}

function hostDropViewer(sid) {
  const peer = rtc.peers[sid];
  if (!peer) return;
  rtcUnlisten(peer.listeners);
  try { peer.pc.close(); } catch (e) {}
  delete rtc.peers[sid];
}

/* ---------- İzleyici tarafı ---------- */
async function startViewerStream(key) {
  rtc.role = 'viewer';
  rtc.key = key;
  rtc.sid = state.uid + '_' + Math.random().toString(36).slice(2, 6);
  rtc.remoteStream = new MediaStream();

  const v = el('videoEl');
  const vref = db.ref(`rooms/${state.roomCode}/rtc/${key}/${rtc.sid}`);
  const pc = new RTCPeerConnection(rtcConfig());
  rtc.viewerPc = pc;

  pc.ontrack = (e) => {
    rtc.remoteStream.addTrack(e.track);
    if (v.srcObject !== rtc.remoteStream) v.srcObject = rtc.remoteStream;
    v.play().catch((err) => {
      // Sadece tarayıcı sesli otomatik oynatmayı engellediyse sessiz başlat, dokununca aç
      if (!err || err.name !== 'NotAllowedError') return;
      v.muted = true;
      v.play().catch(() => {});
      showToast('Ses kapalı — açmak için ekrana dokun');
    });
  };
  pc.onicecandidate = (e) => { if (e.candidate) vref.child('viewerCand').push(plainJson(e.candidate)); };
  pc.onconnectionstatechange = () => {
    if (pc !== rtc.viewerPc) return;
    if (pc.connectionState === 'connected') clearTimeout(rtc.timeout);
    if (pc.connectionState === 'failed') {
      showToast('Bağlantı kurulamadı — 🔄 ile tekrar dene (bazı ağlar doğrudan bağlantıya izin vermez)');
    }
  };

  rtcListen(rtc.listeners, vref.child('offer'), 'value', async (s) => {
    const offer = s.val();
    if (!offer || pc.remoteDescription || pc !== rtc.viewerPc) return;
    try {
      await pc.setRemoteDescription(offer);
      flushCands(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await vref.child('answer').set({ type: answer.type, sdp: answer.sdp });
    } catch (e) { console.error('Yanıt oluşturulamadı:', e); }
  });
  rtcListen(rtc.listeners, vref.child('hostCand'), 'child_added', (s) => addCand(pc, s.val()));

  try {
    vref.onDisconnect().remove();
    await vref.child('join').set(firebase.database.ServerValue.TIMESTAMP);
  } catch (e) { console.error(e); }

  clearTimeout(rtc.timeout);
  rtc.timeout = setTimeout(() => {
    if (pc === rtc.viewerPc && pc.connectionState !== 'connected') {
      showToast('Yayıncıya bağlanılamadı — yayıncı odada olmayabilir ya da ağ engelliyor');
    }
  }, 20000);
}

function restartViewerStream() {
  const key = state.currentItemId;
  if (!key || state.currentType !== 'stream') return;
  stopAllStreaming();
  startViewerStream(key);
}

/* ---------- Temizlik ---------- */
function stopAllStreaming() {
  clearTimeout(rtc.timeout);
  rtcUnlisten(rtc.listeners);
  Object.keys(rtc.peers).forEach(hostDropViewer);
  if (rtc.viewerPc) { try { rtc.viewerPc.close(); } catch (e) {} rtc.viewerPc = null; }
  rtc.remoteStream = null;

  const v = document.getElementById('videoEl');
  if (v && v.srcObject) { v.srcObject = null; }
  if (v) v.muted = false;

  if (state.roomCode && rtc.key) {
    try {
      if (rtc.role === 'host') db.ref(`rooms/${state.roomCode}/rtc/${rtc.key}`).remove().catch(() => {});
      if (rtc.role === 'viewer' && rtc.sid) db.ref(`rooms/${state.roomCode}/rtc/${rtc.key}/${rtc.sid}`).remove().catch(() => {});
    } catch (e) {}
  }
  rtc.role = null; rtc.key = null; rtc.sid = null; rtc.ready = null;

  if (state.isStreamHost) { state.isStreamHost = false; updateControlsVisibility(); }
}

function revokeLocalFiles() {
  Object.values(state.localFiles).forEach((f) => { try { URL.revokeObjectURL(f.url); } catch (e) {} });
  state.localFiles = {};
}

// İlk dokunuşta sesi aç (otomatik oynatma sessize düştüyse)
document.addEventListener('click', () => {
  const v = el('videoEl');
  if (rtc.role === 'viewer' && v.srcObject && v.muted) { v.muted = false; v.play().catch(() => {}); }
}, true);

// Yayın sürerken sekme kapatılırsa uyar
window.addEventListener('beforeunload', (e) => {
  if (rtc.role === 'host' && Object.keys(rtc.peers).length) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- Dosya seçimi ---------- */
const VIDEO_NAME_RE = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;

/* Dosya adı/MIME'a bakmadan, tarayıcının videoyu GERÇEKTEN görüntü karesi
   üretecek şekilde açıp açamadığını test eder. Uzun/film gibi dosyalar çoğu
   zaman MKV konteyneri ya da HEVC/H.265 kodeği kullanır; bu durumda tarayıcı
   metadata'yı (süre, zaman) okuyabilir, hatta ses çalabilir ama görüntü
   karesi hiç üretmez → ekran siyah kalır (kısa telefon videoları genelde
   H.264 MP4 olduğu için sorunsuz açılır). Bunu dosya eklenmeden önce
   yakalayıp kullanıcıya net bir hata vermek için kullanılır. */
function probeVideoFile(url) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    probe.playsInline = true;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      probe.removeEventListener('loadedmetadata', onMeta);
      probe.removeEventListener('error', onError);
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      resolve(result);
    };
    const onMeta = () => {
      // Metadata yüklendi ama genişlik/yükseklik 0 ise video izi çözülemiyor demektir
      if (probe.videoWidth > 0 && probe.videoHeight > 0) finish({ ok: true });
      else finish({ ok: false, reason: 'no-video-track' });
    };
    const onError = () => finish({ ok: false, reason: 'decode-error' });
    probe.addEventListener('loadedmetadata', onMeta);
    probe.addEventListener('error', onError);
    // Büyük/uzun dosyalarda metadata okuma daha uzun sürebilir
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 20000);
    probe.src = url;
  });
}

function unplayableVideoMessage(fileName, reason) {
  if (reason === 'no-video-track') {
    return `"${fileName}" için görüntü çözülemedi (kodek desteklenmiyor olabilir).`;
  }
  if (reason === 'timeout') {
    return `"${fileName}" çok uzun sürede açılamadı — dosya çok büyük ya da format desteklenmiyor olabilir.`;
  }
  return `"${fileName}" açılamadı — dosya bozuk olabilir ya da format desteklenmiyor.`;
}

/* =========================================================
   TARAYICIDA OYNATILAMAYAN VİDEOLARI OTOMATİK DÖNÜŞTÜRME
   Bazı "film" dosyaları MKV konteyneri ya da HEVC/H.265 kodeği
   kullanır; bunlar Chrome/Firefox'ta doğrudan oynatılamaz (görüntü
   siyah kalır). Bu bölüm önce hızlı bir "remux" dener (kodeği
   DEĞİŞTİRMEDEN sadece MP4 kutusuna aktarır — saniyeler sürer,
   kalite kaybı yok). O işe yaramazsa (kodeğin kendisi desteklenmiyorsa)
   tam dönüştürme yapar (H.264/AAC'e yeniden kodlar — uzun/büyük
   dosyalarda epey sürebilir, bu yüzden ilerleme ve iptal seçeneği var).
   ========================================================= */
let ffmpegInstance = null;
let ffmpegLoadPromise = null;
let ffmpegProgressCb = null;
let activeFfmpegCancel = null;

function loadFfmpegCore() {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    if (typeof FFmpegWASM === 'undefined' || typeof FFmpegUtil === 'undefined') {
      throw new Error('ffmpeg.wasm yüklenemedi');
    }
    const ffmpeg = new FFmpegWASM.FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (ffmpegProgressCb && isFinite(progress)) ffmpegProgressCb(Math.min(1, Math.max(0, progress)));
    });
    const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
    await ffmpeg.load({
      coreURL: await FFmpegUtil.toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await FFmpegUtil.toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  ffmpegLoadPromise.catch(() => { ffmpegLoadPromise = null; });
  return ffmpegLoadPromise;
}

function setProgressUi(text, onCancel) {
  const box = el('queueError');
  box.classList.add('progress-text');
  box.innerHTML = '';
  box.appendChild(document.createTextNode(text));
  if (onCancel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-cancel-btn';
    btn.textContent = 'İptal';
    btn.addEventListener('click', onCancel);
    box.appendChild(btn);
  }
}
function clearProgressUi() {
  const box = el('queueError');
  box.classList.remove('progress-text');
  box.textContent = '';
}

/* args: ffmpeg -i <girdi> [...args] <çıktıAdı] çalıştırır, sonucu Blob olarak döner.
   Kullanıcı iptal ederse null döner. */
async function runFfmpegJob(file, args, outName, onProgress) {
  const ffmpeg = await loadFfmpegCore();
  const inName = 'in_' + Math.random().toString(36).slice(2, 8) + (file.name.match(/\.[^.]+$/)?.[0] || '.bin');
  let cancelled = false;
  activeFfmpegCancel = () => {
    cancelled = true;
    try { ffmpeg.terminate(); } catch (e) {}
    ffmpegInstance = null;
    ffmpegLoadPromise = null;
  };
  ffmpegProgressCb = onProgress || null;
  try {
    await ffmpeg.writeFile(inName, await FFmpegUtil.fetchFile(file));
    if (cancelled) return null;
    await ffmpeg.exec(['-i', inName, ...args, outName]);
    if (cancelled) return null;
    const data = await ffmpeg.readFile(outName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  } catch (e) {
    if (cancelled) return null;
    throw e;
  } finally {
    ffmpegProgressCb = null;
    activeFfmpegCancel = null;
    if (!cancelled) {
      try { await ffmpeg.deleteFile(inName); } catch (e) {}
      try { await ffmpeg.deleteFile(outName); } catch (e) {}
    }
  }
}

/* Dosyayı ekleyebilmek için gerekirse dönüştürür. Sonuç: { ok, file, url, cancelled, reason } */
async function ensurePlayableVideoFile(file) {
  let workingFile = file;
  let objectUrl = URL.createObjectURL(workingFile);
  let probeResult = await probeVideoFile(objectUrl);
  let userCancelled = false;
  const cancelNow = () => { userCancelled = true; if (activeFfmpegCancel) activeFfmpegCancel(); };

  // 1) Hızlı yol: sadece konteyneri değiştir (yeniden kodlama yok)
  if (!probeResult.ok && !userCancelled) {
    URL.revokeObjectURL(objectUrl);
    try {
      setProgressUi(`"${file.name}" — hızlı format düzeltmesi deneniyor…`, cancelNow);
      const remuxed = await runFfmpegJob(
        workingFile, ['-c', 'copy', '-movflags', '+faststart'], 'remux.mp4',
        (p) => setProgressUi(`"${file.name}" — hızlı format düzeltmesi: %${Math.round(p * 100)}`, cancelNow)
      );
      if (remuxed && !userCancelled) {
        objectUrl = URL.createObjectURL(remuxed);
        probeResult = await probeVideoFile(objectUrl);
        if (probeResult.ok) workingFile = remuxed; else URL.revokeObjectURL(objectUrl);
      }
    } catch (e) { console.error('remux başarısız:', e); }
  }

  // 2) Konteyner değil kodeğin kendisi desteklenmiyorsa: tam dönüştürme
  if (!probeResult.ok && !userCancelled) {
    try {
      setProgressUi(`"${file.name}" — video MP4/H.264'e dönüştürülüyor (uzun sürebilir, sekmeyi kapatma)…`, cancelNow);
      const transcoded = await runFfmpegJob(
        workingFile,
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
        'transcode.mp4',
        (p) => setProgressUi(`"${file.name}" — dönüştürülüyor: %${Math.round(p * 100)} (sekmeyi kapatma)`, cancelNow)
      );
      if (transcoded && !userCancelled) {
        objectUrl = URL.createObjectURL(transcoded);
        probeResult = await probeVideoFile(objectUrl);
        if (probeResult.ok) workingFile = transcoded; else URL.revokeObjectURL(objectUrl);
      }
    } catch (e) { console.error('dönüştürme başarısız:', e); }
  }

  clearProgressUi();

  if (userCancelled) { try { URL.revokeObjectURL(objectUrl); } catch (e) {} return { ok: false, cancelled: true }; }
  if (!probeResult.ok) { try { URL.revokeObjectURL(objectUrl); } catch (e) {} return { ok: false, reason: probeResult.reason }; }
  return { ok: true, file: workingFile, url: objectUrl };
}

el('localFileBtn').addEventListener('click', () => {
  if (!state.roomCode) return;
  if (!canCaptureMedia()) {
    showToast('Bu tarayıcı video yayınlayamıyor — Chrome, Edge ya da Firefox kullan (telefonda Chrome olur)');
    return;
  }
  el('localFileInput').click();
});

el('localFileInput').addEventListener('change', async () => {
  const files = Array.from(el('localFileInput').files || []);
  el('localFileInput').value = '';
  if (!files.length || !state.roomCode) return;
  el('queueError').textContent = '';

  for (const file of files) {
    const looksLikeVideo = (file.type && file.type.startsWith('video/')) || VIDEO_NAME_RE.test(file.name);
    if (!looksLikeVideo) { showToast(`"${file.name}" bir video dosyası değil`); continue; }

    showToast(`"${file.name}" kontrol ediliyor…`);
    const result = await ensurePlayableVideoFile(file);
    if (!result.ok) {
      if (result.cancelled) { showToast(`"${file.name}" dönüştürme iptal edildi`); continue; }
      const msg = unplayableVideoMessage(file.name, result.reason);
      showToast(msg);
      el('queueError').textContent = msg;
      continue;
    }

    const localId = 'l_' + Math.random().toString(36).slice(2, 10);
    const title = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Video';
    state.localFiles[localId] = { file: result.file, url: result.url };

    const ref = db.ref(`rooms/${state.roomCode}/queue`).push();
    await ref.set({
      type: 'stream', refId: localId, localId,
      hostUid: state.uid, hostName: state.name,
      title, addedBy: state.name,
      addedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    if (!state.currentItemId) await setCurrentItem(ref.key, { force: true });
    pushSystemMessage(`${state.name} listeye "${title}" videosunu ekledi (canlı yayın)`);
  }
});

/* =========================================================
   LINK ALGILAMA
   ========================================================= */
function parseLink(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return null; }
  const host = url.hostname.replace(/^www\./, '');

  const yt = raw.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return { type: 'youtube', refId: yt[1], title: 'YouTube videosu' };

  const isPlaylistUrl = /youtube\.com\/playlist/.test(raw);
  const listParam = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (isPlaylistUrl && listParam) {
    return { type: 'youtube_playlist', refId: listParam[1], title: 'YouTube oynatma listesi' };
  }

  if (host === 'kick.com') {
    const channel = url.pathname.replace(/^\//, '').split('/')[0];
    if (channel && channel !== 'video') {
      return { type: 'kick', refId: channel, title: `Kick: ${channel}`, live: true };
    }
  }

  if (host === 'twitch.tv') {
    const parts = url.pathname.replace(/^\//, '').split('/');
    if (parts[0] === 'videos' && parts[1]) {
      return { type: 'twitch_vod', refId: parts[1], title: `Twitch VOD` };
    }
    if (parts[0] && parts[0] !== 'directory') {
      return { type: 'twitch', refId: parts[0], title: `Twitch: ${parts[0]}`, live: true };
    }
  }

  if (host === 'vimeo.com') {
    const vid = url.pathname.match(/\/(\d+)/);
    if (vid) return { type: 'vimeo', refId: vid[1], title: 'Vimeo videosu' };
  }

  const drive = raw.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/);
  if (drive) return { type: 'drive', refId: drive[1], title: 'Drive videosu' };

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
    await enterRoom(code, name, true); // isCreator = true
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
    await enterRoom(code, name, false);
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
async function enterRoom(code, name, isCreator = false) {
  state.uid = getOrCreateUid();
  state.name = name;
  state.roomCode = code;
  localStorage.setItem('wt_room', code);
  localStorage.setItem('wt_name', name);

  const userRef = db.ref(`rooms/${code}/users/${state.uid}`);
  state.userRef = userRef;
  await userRef.set({ name, online: true, joinedAt: firebase.database.ServerValue.TIMESTAMP });
  userRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });

  // Admin atama: oda kurucusu ise UID'yi meta'ya yaz
  if (isCreator) {
    await db.ref(`rooms/${code}/meta/adminUid`).set(state.uid);
  }

  // Admin olup olmadığımızı belirle
  const metaSnap = await db.ref(`rooms/${code}/meta`).get();
  const meta = metaSnap.val() || {};
  state.isAdmin = (meta.adminUid === state.uid);
  state.canControl = state.isAdmin;

  // Oda sahibiyse: bağlantı kopsa bile (sekme kapatma, çökme, ağ kaybı vb.)
  // sunucu tarafında tüm oda otomatik silinsin.
  if (state.isAdmin) {
    db.ref(`rooms/${code}`).onDisconnect().remove();
  }

  landingView.classList.add('hidden');
  roomView.classList.remove('hidden');
  el('roomCodeText').textContent = code;

  updateControlsVisibility();

  startConnectionWatcher();
  listenServerOffset();
  listenRoomAlive();
  listenUsers();
  listenQueue();
  listenCurrentItem();
  listenPlayback();
  listenChat();
  listenReactions();
  listenTyping();
  listenHistory();

  pushSystemMessage(`${name} odaya katıldı`);
  requestNotifPermission();
}

el('leaveRoomBtn').addEventListener('click', leaveRoom);

async function leaveRoom() {
  if (state.roomCode && state.uid) {
    state.leavingIntentionally = true;
    // Kendi kullanıcı düğümümüze bağlı onDisconnect kaydını iptal et; yoksa
    // ileride bu sekme kapanınca oda silinmiş olsa bile yeniden "hayalet"
    // bir users/{uid} kaydı oluşturabilir.
    if (state.userRef) {
      try { await state.userRef.onDisconnect().cancel(); } catch (e) { console.error('userRef onDisconnect iptali başarısız:', e); }
    }
    if (state.isAdmin) {
      // Oda sahibi çıkıyor: herkesi atmak ve odayı temizlemek için
      // tüm oda düğümünü sil. (Diğer kullanıcılar listenRoomAlive ile fark edip atılır.)
      try { await db.ref(`rooms/${state.roomCode}`).onDisconnect().cancel(); } catch (e) { console.error('room onDisconnect iptali başarısız:', e); }
      try {
        await db.ref(`rooms/${state.roomCode}`).remove();
      } catch (e) {
        console.error('Oda silinemedi:', e);
        showToast('Oda silinemedi: ' + (e && e.message ? e.message : 'izin hatası olabilir'));
      }
    } else {
      pushSystemMessage(`${state.name} odadan çıktı`);
      try {
        await db.ref(`rooms/${state.roomCode}/users/${state.uid}`)
          .update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
      } catch (e) {}
      try { await db.ref(`rooms/${state.roomCode}/typing/${state.uid}`).remove(); } catch (e) {}
    }
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
  state.isAdmin = false;
  state.canControl = false;
  state.userRef = null;
  state.leavingIntentionally = false;
  roomView.classList.add('hidden');
  landingView.classList.remove('hidden');
  el('joinCodeInput').value = '';
}

/* =========================================================
   ODA CANLILIK TAKİBİ — oda sahibi çıkarsa/kopar sa herkesi at
   ========================================================= */
function listenRoomAlive() {
  let sawData = false;
  trackListener(db.ref(`rooms/${state.roomCode}`), 'value', (snap) => {
    if (snap.exists()) { sawData = true; return; }
    if (!sawData) return; // ilk yüklemeden önceki gürültülü null'ları yok say
    if (state.leavingIntentionally) return; // odayı zaten kendimiz siliyorsak yok say
    forceLeaveRoomClosed();
  });
}

function forceLeaveRoomClosed() {
  clearAllListeners();
  hideEndCountdown();
  document.body.classList.remove('cinema-mode');
  localStorage.removeItem('wt_room');
  localStorage.removeItem('wt_name');
  pauseLocal();
  el('videoEl').src = '';
  state.currentItemId = null;
  state.roomCode = null;
  state.isAdmin = false;
  state.canControl = false;
  roomView.classList.add('hidden');
  landingView.classList.remove('hidden');
  el('joinCodeInput').value = '';
  showToast('Oda sahibi çıktı, oda kapatıldı 🚪');
}

/* sayfa yenilenince odaya otomatik dön */
(async function autoRejoin() {
  const code = localStorage.getItem('wt_room');
  const name = localStorage.getItem('wt_name');
  if (code && name) {
    try {
      const snap = await db.ref(`rooms/${code}`).get();
      if (snap.exists()) { await enterRoom(code, name, false); return; }
    } catch (e) {}
    localStorage.removeItem('wt_room');
    localStorage.removeItem('wt_name');
  }
})();

/* =========================================================
   TERK EDİLMİŞ ODALARIN OTOMATİK TEMİZLİĞİ (client-side)
   Sunucu/Cloud Function olmadan, uygulama her açıldığında
   düşük ihtimalle çalışıp içinde kimse olmayan ve uzun süredir
   hareketsiz odaları siler. Böylece DB'de yer kaplamaz.
   ========================================================= */
const STALE_ROOM_MS = 24 * 60 * 60 * 1000; // 24 saatten uzun süredir hareketsiz odalar silinir
const CLEANUP_CHANCE = 0.15; // her yüklemede %15 ihtimalle tetiklenir (DB okuma yükünü sınırlamak için)

async function cleanupStaleRooms() {
  if (Math.random() > CLEANUP_CHANCE) return;
  try {
    const snap = await db.ref('rooms').get();
    if (!snap.exists()) return;
    const now = Date.now();
    const rooms = snap.val();
    const staleCodes = [];

    Object.entries(rooms).forEach(([code, room]) => {
      const users = room.users || {};
      const anyOnline = Object.values(users).some((u) => u && u.online);
      if (anyOnline) return; // içinde biri varsa dokunma

      // odanın en son ne zaman "canlı" olduğunu bul
      let lastActivity = (room.meta && room.meta.createdAt) || 0;
      Object.values(users).forEach((u) => {
        const t = (u && (u.lastSeen || u.joinedAt)) || 0;
        if (t > lastActivity) lastActivity = t;
      });
      if (room.chat) {
        Object.values(room.chat).forEach((m) => {
          const t = (m && m.sentAt) || 0;
          if (t > lastActivity) lastActivity = t;
        });
      }

      // zaman bilgisi hiç yoksa (bozuk/yarım kalmış oda) ya da eşikten eskiyse sil
      if (!lastActivity || (now - lastActivity) > STALE_ROOM_MS) {
        staleCodes.push(code);
      }
    });

    if (staleCodes.length) {
      const updates = {};
      staleCodes.forEach((code) => { updates[`rooms/${code}`] = null; });
      await db.ref().update(updates);
      console.log('Terk edilmiş odalar temizlendi:', staleCodes);
    }
  } catch (err) {
    console.error('cleanupStaleRooms hata:', err);
  }
}
cleanupStaleRooms();

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

    // Kendi canControl durumunu güncelle (admin değilsek)
    if (!state.isAdmin && data[state.uid]) {
      const prevControl = state.canControl;
      state.canControl = !!data[state.uid].canControl;
      if (prevControl !== state.canControl) {
        updateControlsVisibility();
        if (state.canControl) {
          showToast('Kontrol yetkisi verildi 👑');
        } else {
          showToast('Kontrol yetkisi alındı');
        }
      }
    }

    const list = el('presenceList');
    list.innerHTML = '';

    // Meta'dan adminUid al (presence render için)
    db.ref(`rooms/${state.roomCode}/meta/adminUid`).get().then((metaSnap) => {
      const adminUid = metaSnap.val();

      Object.entries(data).sort(([, a], [, b]) => {
        if (a.online === b.online) return (a.name || '').localeCompare(b.name || '');
        return a.online ? -1 : 1;
      }).forEach(([uid, u]) => {
        const isMe = uid === state.uid;
        const isUserAdmin = uid === adminUid;
        const hasControl = isUserAdmin || !!u.canControl;

        const pill = document.createElement('span');
        pill.className = 'presence-pill'
          + (u.online ? ' online' : '')
          + (isMe ? ' is-me' : '')
          + (isUserAdmin ? ' is-admin' : '')
          + (hasControl && !isUserAdmin ? ' has-control' : '');

        let tooltip = u.online ? 'Çevrimiçi' : 'Çevrimdışı';
        if (!u.online && u.lastSeen) {
          const diff = Math.round((Date.now() - u.lastSeen) / 1000);
          if (diff < 60) tooltip = `${diff}sn önce görüldü`;
          else if (diff < 3600) tooltip = `${Math.round(diff/60)}dk önce görüldü`;
          else tooltip = `${Math.round(diff/3600)}sa önce görüldü`;
        }

        let rozetHtml = '';
        if (isUserAdmin) rozetHtml = ' <span class="presence-crown" title="Oda sahibi">👑</span>';
        else if (hasControl) rozetHtml = ' <span class="presence-crown" title="Kontrol yetkisi var">🎮</span>';

        pill.innerHTML = `
          <span class="presence-dot"></span>
          ${escapeHtml(u.name || '?')}${rozetHtml}
          <span class="presence-tooltip">${tooltip}</span>
        `;

        // Admin başkalarına yetki ver/al butonu gösterir
        if (state.isAdmin && !isUserAdmin && !isMe) {
          const grantBtn = document.createElement('button');
          grantBtn.className = 'grant-btn' + (hasControl ? ' revoke' : '');
          grantBtn.textContent = hasControl ? '✕ Yetki Al' : '+ Yetki Ver';
          grantBtn.title = hasControl ? 'Kontrol yetkisini geri al' : 'Kontrol yetkisi ver';
          grantBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleUserControl(uid, !hasControl, u.name || '?');
          });
          pill.appendChild(grantBtn);
        }

        list.appendChild(pill);
      });
    }).catch(() => {
      // meta okunamazsa düz render
      Object.values(data).sort((a, b) => {
        if (a.online === b.online) return (a.name || '').localeCompare(b.name || '');
        return a.online ? -1 : 1;
      }).forEach((u) => {
        const pill = document.createElement('span');
        pill.className = 'presence-pill' + (u.online ? ' online' : '');
        pill.innerHTML = `<span class="presence-dot"></span>${escapeHtml(u.name || '?')}`;
        list.appendChild(pill);
      });
    });
  });
}

/* Kullanıcıya kontrol yetkisi ver / al — sadece admin yapabilir */
async function toggleUserControl(uid, grant, userName) {
  if (!state.isAdmin) { showToast('Bu işlem için oda sahibi olmalısınız'); return; }
  try {
    if (grant) {
      await db.ref(`rooms/${state.roomCode}/users/${uid}/canControl`).set(true);
      showToast(`${userName} adlı kişiye yetki verildi 🎮`);
    } else {
      await db.ref(`rooms/${state.roomCode}/users/${uid}/canControl`).remove();
      showToast(`${userName} adlı kişinin yetkisi alındı`);
    }
  } catch (err) {
    console.error(err);
    showToast('Yetki değiştirilemedi');
  }
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

  // Kuyruk boşsa, kim eklerse eklesin ilk video otomatik oynatılan video olsun.
  // (Zaten bir video oynuyorsa, değiştirmek hâlâ sadece yetkili kullanıcılarda.)
  if (!state.currentItemId) {
    await setCurrentItem(ref.key, { force: true });
  }
  pushSystemMessage(`${state.name} listeye "${parsed.title}" videosunu ekledi`);
  input.value = '';

  if (parsed.type === 'drive') {
    showToast('Drive linki eklendi — dosya paylaşımı "bağlantıya sahip olan herkes" olmalı');
  }
}

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
    if (!state.currentItemId && firstKey) await setCurrentItem(firstKey, { force: true });
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
    const keys = Object.keys(data);
    const hasOrder = keys.some((k) => typeof data[k].order === 'number');
    if (hasOrder) {
      keys.sort((a, b) => {
        const oa = typeof data[a].order === 'number' ? data[a].order : Infinity;
        const ob = typeof data[b].order === 'number' ? data[b].order : Infinity;
        if (oa !== ob) return oa - ob;
        return a < b ? -1 : 1;
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
  const typeIcon = { youtube: '▶', drive: '⛁', video: '🎬', stream: '📡', kick: '🟣', twitch: '💜', twitch_vod: '💜', vimeo: '🎞' };
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
    // Sadece admin/yetkili video seçebilir
    if (state.canControl) {
      li.querySelector('.queue-title').addEventListener('click', () => setCurrentItem(key));
      li.querySelector('.queue-type').addEventListener('click', () => setCurrentItem(key));
    }
    li.querySelector('.queue-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeQueueItem(key);
    });
    attachDragHandlers(li);
    list.appendChild(li);
  });
}

/* =========================================================
   SÜRÜKLE-BIRAK İLE LİSTE SIRALAMA
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
  if (!canWrite()) return; // sadece yetkili kullanıcılar sıralamayı değiştirebilir
  const items = Array.from(el('queueList').querySelectorAll('.queue-item[data-key]'));
  if (!items.length || !state.roomCode) return;
  const updates = {};
  items.forEach((li, index) => {
    updates[`rooms/${state.roomCode}/queue/${li.dataset.key}/order`] = index;
  });
  db.ref().update(updates).catch((err) => console.error(err));
}

async function removeQueueItem(key) {
  if (!canWrite()) { showToast('Bunun için yetkiniz yok'); return; }
  await db.ref(`rooms/${state.roomCode}/queue/${key}`).remove();
  if (state.currentItemId === key) {
    await db.ref(`rooms/${state.roomCode}/currentItemId`).set(null);
    await db.ref(`rooms/${state.roomCode}/playback`).set({
      isPlaying: false, position: 0, speed: state.speed,
      updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: state.uid,
    });
  }
}

async function setCurrentItem(key, opts = {}) {
  const force = !!opts.force;
  if (!force && !canWrite()) return;
  const item = state.queueCache[key];
  await db.ref(`rooms/${state.roomCode}/currentItemId`).set(key);
  await db.ref(`rooms/${state.roomCode}/playback`).set({
    isPlaying: false, position: 0, speed: state.speed,
    updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: state.uid,
  });
  if (item) pushSystemMessage(`Sıradaki video "${item.title || item.refId}" olarak güncellendi`);
}

async function advanceQueue() {
  // Sadece yetkili kullanıcılar (admin veya canControl) ya da videoyu yayınlayan kişi kuyruğu ilerletebilir
  if (!canWrite() && !state.isStreamHost) return;
  const finishedKey = state.currentItemId;
  const finishedItem = finishedKey ? state.queueCache[finishedKey] : null;
  const idx = state.queueOrder.indexOf(finishedKey);
  const nextKey = idx >= 0 ? (state.queueOrder[idx + 1] || null) : null;

  const itemRef = db.ref(`rooms/${state.roomCode}/currentItemId`);
  let result;
  try {
    result = await itemRef.transaction((current) => {
      if (current !== finishedKey) return;
      return nextKey;
    });
  } catch (err) {
    console.error(err);
    return;
  }
  if (!result.committed) return;

  if (finishedKey && finishedItem) {
    db.ref(`rooms/${state.roomCode}/history`).push({
      type: finishedItem.type, refId: finishedItem.refId, title: finishedItem.title,
      addedBy: finishedItem.addedBy || null,
      localId: finishedItem.localId || null, hostUid: finishedItem.hostUid || null, hostName: finishedItem.hostName || null,
      watchedAt: firebase.database.ServerValue.TIMESTAMP,
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
   GEÇMİŞ
   ========================================================= */
function listenHistory() {
  trackListener(db.ref(`rooms/${state.roomCode}/history`), 'value', (snap) => {
    const data = snap.val() || {};
    state.historyCache = data;
    state.historyOrder = Object.keys(data).reverse();
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
  const typeIcon = { youtube: '▶', drive: '⛁', video: '🎬', stream: '📡', kick: '🟣', twitch: '💜', twitch_vod: '💜', vimeo: '🎞' };
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
  if (item.type === 'stream') {
    // Yayın videosu sadece dosyanın sahibi tarafından (sekmesi açıkken) tekrar eklenebilir
    if (item.hostUid !== state.uid) { showToast('Bu videoyu sadece yayınlayan kişi tekrar ekleyebilir'); return; }
    if (!state.localFiles[item.localId]) { showToast('Dosya artık yok — videoyu 📁 ile yeniden seç'); return; }
  }
  const ref = db.ref(`rooms/${state.roomCode}/queue`).push();
  await ref.set({
    type: item.type, refId: item.refId, title: item.title,
    localId: item.localId || null, hostUid: item.hostUid || null, hostName: item.hostName || null,
    addedBy: state.name, addedAt: firebase.database.ServerValue.TIMESTAMP,
  });
  if (!state.currentItemId) await setCurrentItem(ref.key, { force: true });
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
  stopAllStreaming();

  if (!item) {
    // currentItemId zaten ayarlı ama kuyruk verisi henüz senkronize olmamış olabilir
    // (iki farklı Firebase dinleyicisi arasındaki kısa gecikme). Doğrudan çekip tekrar dene.
    if (state.currentItemId) {
      const key = state.currentItemId;
      db.ref(`rooms/${state.roomCode}/queue/${key}`).get().then((snap) => {
        if (snap.exists() && state.currentItemId === key) {
          state.queueCache[key] = snap.val();
          loadPlayerForCurrentItem();
        }
      }).catch(() => {});
    }
    stage.classList.remove('active');
    empty.classList.remove('hidden');
    el('speedSelect').classList.add('hidden');
    el('qualitySelect').classList.add('hidden');
    el('pipBtn').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  stage.classList.add('active');

  lastPlaybackSnapshot = { isPlaying: false, position: 0, speed: state.speed, updatedAt: serverTimeNow(), updatedBy: null };
  blackFrameWarned = false;

  if (item.type === 'youtube') {
    state.currentType = 'youtube';
    el('liveHost').style.display = 'none';
    el('liveHost').innerHTML = '';
    videoEl.style.display = 'none';
    ytHost.style.display = 'block';
    videoEl.pause();
    videoEl.removeAttribute('src');
    el('qualitySelect').classList.remove('hidden');
    // Hız sadece yetkililere
    if (state.canControl) el('speedSelect').classList.remove('hidden');
    el('pipBtn').classList.add('hidden');
    setLiveBadge(false);
    el('seekRange').disabled = false;
    el('seekRange').style.opacity = '1';
    loadYoutube(item.refId);

  } else if (item.type === 'kick' || item.type === 'twitch' || item.type === 'twitch_vod' || item.type === 'vimeo') {
    state.currentType = 'iframe_live';
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

  } else if (item.type === 'stream') {
    const isHost = item.hostUid === state.uid;
    el('liveHost').style.display = 'none';
    el('liveHost').innerHTML = '';
    ytHost.style.display = 'none';
    videoEl.style.display = 'block';
    el('qualitySelect').classList.add('hidden');
    el('speedSelect').classList.add('hidden');
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
    const pipOk = !!(document.pictureInPictureEnabled || videoEl.webkitSupportsPresentationMode);
    el('pipBtn').classList.toggle('hidden', !pipOk);

    if (isHost) {
      const local = state.localFiles[item.localId];
      if (!local) {
        // Sayfa yenilendiyse dosya referansı kaybolur
        stage.classList.remove('active');
        empty.classList.remove('hidden');
        showToast('Sayfa yenilendiği için dosya kayboldu — videoyu 📁 ile yeniden seç');
        return;
      }
      state.currentType = 'html5';
      state.isStreamHost = true;
      updateControlsVisibility();
      setLiveBadge(false);
      el('seekRange').disabled = false;
      el('seekRange').style.opacity = '1';
      videoEl.removeAttribute('src');
      videoEl.src = local.url;
      videoEl.load();
      startHostBroadcast(state.currentItemId);
    } else {
      state.currentType = 'stream';
      videoEl.pause();
      videoEl.removeAttribute('src');
      setLiveBadge(true, `📡 ${item.hostName || 'Yayıncı'} yayınlıyor`);
      el('seekRange').disabled = true;
      el('seekRange').style.opacity = '.3';
      startViewerStream(state.currentItemId);
    }

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
}

/* =========================================================
   IFRAME OYNATICI — Kick / Twitch / Vimeo
   ========================================================= */
function loadIframePlayer(item) {
  const host = el('liveHost');
  host.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.allowFullscreen = true;
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'origin';

  const domain = window.location.hostname || 'localhost';

  if (item.type === 'kick') {
    iframe.src = `https://player.kick.com/${encodeURIComponent(item.refId)}?autoplay=true&muted=false`;
  } else if (item.type === 'twitch') {
    iframe.src = `https://player.twitch.tv/?channel=${encodeURIComponent(item.refId)}&parent=${domain}&autoplay=true&muted=false`;
  } else if (item.type === 'twitch_vod') {
    iframe.src = `https://player.twitch.tv/?video=${encodeURIComponent(item.refId)}&parent=${domain}&autoplay=true`;
  } else if (item.type === 'vimeo') {
    iframe.src = `https://player.vimeo.com/video/${encodeURIComponent(item.refId)}?autoplay=1&byline=0&portrait=0&title=0`;
  }

  if (!iframe.src) return;
  host.appendChild(iframe);
}

function setLiveBadge(show, text) {
  let badge = document.getElementById('liveBadge');
  if (show) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'liveBadge';
      badge.className = 'live-badge';
      badge.textContent = '🔴 CANLI';
      document.querySelector('.control-bar').prepend(badge);
    }
    badge.textContent = text || '🔴 CANLI';
    badge.style.display = '';
    el('playPauseBtn').style.display    = 'none';
    el('currentTimeText').style.display = 'none';
    el('durationTimeText').style.display = 'none';
  } else {
    if (badge) badge.style.display = 'none';
    // Sadece yetkililere play butonu göster
    el('playPauseBtn').style.display    = (state.canControl || state.isStreamHost) ? '' : 'none';
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

el('videoEl').addEventListener('ended', handleVideoEnded);
el('videoEl').addEventListener('error', () => {
  const v = el('videoEl');
  if (!v.getAttribute('src')) return; // src temizlenirken tetiklenen hatayı yok say
  const code = v.error && v.error.code;
  const msgs = {
    2: 'Video yüklenemedi (ağ hatası) — bağlantını kontrol edip tekrar dene.',
    3: 'Video çözülemedi — dosya bozuk olabilir.',
    4: 'Bu video formatı/kodeği tarayıcı tarafından desteklenmiyor (MKV, HEVC/H.265 gibi formatlarda sık görülür). MP4 (H.264 + AAC) formatına dönüştürüp tekrar dene.',
  };
  showToast(msgs[code] || 'Video oynatılamadı — format desteklenmiyor olabilir (en uyumlusu MP4 / H.264)');
});

/* =========================================================
   OTOMATİK PICTURE-IN-PICTURE
   ========================================================= */
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden) return;
  if (!state.isPlaying || !state.currentItemId) return;

  if (state.currentType === 'html5') {
    const v = el('videoEl');
    if (!v || !v.src || !v.readyState) return;
    if (document.pictureInPictureElement) return;
    if (!document.pictureInPictureEnabled) return;
    try {
      await v.requestPictureInPicture();
    } catch (e) {}
  }
});

document.addEventListener('leavepictureinpicture', () => {});

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
    setTimeout(() => n.close(), 8000);
  } catch (e) {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            newSW.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch(() => {});

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
    } else if (v.webkitSetPresentationMode) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } else {
      showToast('Bu tarayıcı resim içinde resmi desteklemiyor');
    }
  } catch (err) {
    console.error(err);
    showToast('Resim içinde resim başlatılamadı');
  }
});

/* --- Süre metnine tıklayınca manuel zaman girişi (sadece yetkililere) --- */
el('controlBar').addEventListener('click', (e) => {
  if (!canControlPlayback()) return; // yetkisi yoksa zaman girişi açılmasın
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

el('currentTimeText').title = 'Tıkla → süre gir (sadece yetkililere)';
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
   ========================================================= */
el('inviteBtn').addEventListener('click', openInviteModal);

function openInviteModal() {
  if (!state.roomCode) return;
  const url = `${location.origin}${location.pathname}?join=${state.roomCode}`;
  el('inviteLinkInput').value = url;

  const qrDiv = el('inviteQr');
  qrDiv.innerHTML = '';
  drawQrCanvas(url, qrDiv);

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

(function checkInviteParam() {
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    el('joinCodeInput').value = joinCode.toUpperCase();
    el('joinBox').classList.remove('hidden');
    history.replaceState({}, '', location.pathname);
  }
})();

function drawQrCanvas(text, container) {
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
    mediaRecorder.start(250);

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
  const durationSec = Math.round(audioChunks.length * 0.25);

  const reader = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result;
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
   VİDEO BİTİŞ GERİ SAYIMI
   ========================================================= */
let endCountdownTimer = null;

function handleVideoEnded() {
  const idx = state.queueOrder.indexOf(state.currentItemId);
  const hasNext = idx >= 0 && !!state.queueOrder[idx + 1];
  if (!hasNext) { advanceQueue(); return; }
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
  if (!canWrite() && !state.isStreamHost) { hideEndCountdown(); return; } // yetkisiz kullanıcı atlayamaz
  hideEndCountdown();
  advanceQueue();
});

/* =========================================================
   ORTAK OYNATICI KONTROLLERİ
   ========================================================= */
function getCurrentPlayerTime() {
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.getCurrentTime) {
    return state.ytPlayer.getCurrentTime() || 0;
  }
  if (state.currentType === 'html5') return el('videoEl').currentTime || 0;
  return 0;
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
}
function updatePlayButtonUi() {
  el('playIcon').textContent = state.isPlaying ? '❚❚' : '▶';
}

function writePlayback(isPlaying, position) {
  if (!state.roomCode) return;
  db.ref(`rooms/${state.roomCode}/playback`).set({
    isPlaying, position, speed: state.speed,
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
    updatedBy: state.uid,
  });
}

/* --- "Beni Yakala": anlık senkronize et (herkes kullanabilir) --- */
el('forceSyncBtn').addEventListener('click', async () => {
  if (!state.roomCode) return;
  if (state.currentType === 'stream') { showToast('Yayına yeniden bağlanılıyor…'); restartViewerStream(); return; }
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

    seekLocal(targetPos);
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

/* --- Oynatma hızı senkronu (sadece YouTube, sadece yetkili) --- */
el('speedSelect').addEventListener('change', () => {
  if (!canWrite()) return;
  const rate = parseFloat(el('speedSelect').value) || 1;
  state.speed = rate;
  if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.setPlaybackRate) {
    state.ytPlayer.setPlaybackRate(rate);
  }
  if (state.roomCode) db.ref(`rooms/${state.roomCode}/playback/speed`).set(rate);
});

/* Play/Pause: sadece yetkililere */
el('playPauseBtn').addEventListener('click', () => {
  if (!canControlPlayback()) return;
  if (state.isPlaying) { pauseLocal(); writePlayback(false, getCurrentPlayerTime()); }
  else { playLocal(); writePlayback(true, getCurrentPlayerTime()); }
});

/* Seek: sadece yetkililere */
const seekRange = el('seekRange');
seekRange.addEventListener('mousedown', () => { if (canControlPlayback()) state.seekDragging = true; });
seekRange.addEventListener('touchstart', () => { if (canControlPlayback()) state.seekDragging = true; });
seekRange.addEventListener('change', () => {
  if (!canControlPlayback()) return;
  const t = parseFloat(seekRange.value);
  seekLocal(t);
  writePlayback(state.isPlaying, t);
  state.seekDragging = false;
  hideEndCountdown();
});

/* ilerleme çubuğunu periyodik güncelle — herkes için */
let blackFrameWarned = false;
setInterval(() => {
  if (state.seekDragging) return;
  const cur = getCurrentPlayerTime();
  const dur = getDuration();
  if (dur > 0) { seekRange.max = dur; seekRange.value = cur; }
  el('currentTimeText').textContent = fmtTime(cur);
  el('durationTimeText').textContent = fmtTime(dur);

  // Süre ilerliyor ama görüntü karesi hiç gelmiyorsa (ekran siyah kalıyorsa) uyar
  if (state.currentType === 'html5' && state.isPlaying && !blackFrameWarned) {
    const v = el('videoEl');
    if (cur > 3 && v.videoWidth === 0) {
      blackFrameWarned = true;
      showToast('Görüntü gelmiyor gibi görünüyor — video formatı/kodeği desteklenmiyor olabilir (MKV/HEVC yerine MP4/H.264 dene)');
    }
  }
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
  if (state.seekDragging) return;
  const serverNow = serverTimeNow();
  const updatedAt = data.updatedAt || serverNow;
  const elapsed = data.isPlaying ? Math.max(0, (serverNow - updatedAt) / 1000) : 0;
  const targetPos = Math.max(0, (data.position || 0) + elapsed);
  const cur = getCurrentPlayerTime();

  if (Math.abs(cur - targetPos) > 0.75) {
    seekLocal(targetPos);
    hideEndCountdown();
  }
  if (data.isPlaying && !state.isPlaying) playLocal();
  if (!data.isPlaying && state.isPlaying) pauseLocal();
  state.isPlaying = data.isPlaying;
  updatePlayButtonUi();

  const remoteSpeed = data.speed || 1;
  if (remoteSpeed !== state.speed) {
    state.speed = remoteSpeed;
    el('speedSelect').value = String(remoteSpeed);
    if (state.currentType === 'youtube' && state.ytPlayer && state.ytPlayer.setPlaybackRate) {
      state.ytPlayer.setPlaybackRate(remoteSpeed);
    }
  }
}

setInterval(() => {
  if (document.hidden) return;
  applyRemoteStateNow();
}, 2000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyRemoteStateNow();
});

/* =========================================================
   SEKME GEÇİŞİ
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

const lightbox = el('lightbox');
lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
function openLightbox(src) {
  el('lightboxImg').src = src;
  lightbox.classList.remove('hidden');
}

/* =========================================================
   ANLIK EMOJİ TEPKİLERİ
   ========================================================= */
const reactionsLayer = el('reactionsLayer');
el('reactionBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn || !state.roomCode) return;
  const ref = db.ref(`rooms/${state.roomCode}/reactions`).push();
  ref.set({ emoji: btn.dataset.emoji, sentAt: firebase.database.ServerValue.TIMESTAMP, sentBy: state.uid });
  setTimeout(() => ref.remove().catch(() => {}), 6000);
  spawnFlyingEmoji(btn.dataset.emoji);
});

function listenReactions() {
  const joinedAt = serverTimeNow();
  const ref = db.ref(`rooms/${state.roomCode}/reactions`).limitToLast(20);
  trackListener(ref, 'child_added', (snap) => {
    const r = snap.val();
    if (!r || !r.sentAt) return;
    if (r.sentBy === state.uid) return;
    if (r.sentAt < joinedAt - 4000) return;
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
   SİSTEM BİLDİRİM MESAJLARI
   ========================================================= */
function pushSystemMessage(text) {
  if (!state.roomCode) return;
  db.ref(`rooms/${state.roomCode}/chat`).push({
    name: '🔔',
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
   GÜVENLİK: basit HTML kaçışı
   ========================================================= */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
