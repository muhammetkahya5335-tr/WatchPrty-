// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyBdf8Hha69vz6iq4UAwybhBRuvg0ZslOFM",
    authDomain: "watchprty-51b47.firebaseapp.com",
    databaseURL: "https://watchprty-51b47-default-rtdb.firebaseio.com",
    projectId: "watchprty-51b47",
    storageBucket: "watchprty-51b47.firebasestorage.app",
    messagingSenderId: "786917847296",
    appId: "1:786917847296:web:d8291d32b81c15b0bd43e5"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const params = new URLSearchParams(window.location.search);
const uName  = params.get('user') || "Anonim";
const rCode  = params.get('room') || "TEST";
const role   = params.get('role') || "guest";

let player;
let currentPlaylistIndex = 0;
let micActive   = false;
let localStream = null;
let peers = {};

document.getElementById('roomLabel').innerText = "ODA: " + rCode;
document.getElementById('roleLabel').innerText = "ROL: " + role.toUpperCase();

// ── YARDIMCI ──────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;');
}

// appendMsg: hem sistem hem de sohbet mesajı için tek nokta
// FIX: Önceki kodda appendMsg tanımsızdı (addSystemMsg vardı), ses bağlantısı hataları bu yüzden ekrana yansımıyordu
// ve bazı durumlarda ReferenceError fırlatıp WebRTC akışını kesiyordu.
function appendMsg(user, text, isSystem) {
    const flow = document.getElementById('chat-flow');
    const div  = document.createElement('div');
    div.className = 'msg';
    if (isSystem) {
        div.style.borderColor  = '#7000ff';
        div.style.color        = '#aaa';
        div.style.fontSize     = '12px';
        div.innerText          = text;
    } else {
        div.innerHTML = `<b>${escHtml(user)}</b>${escHtml(text)}`;
    }
    flow.appendChild(div);
    flow.scrollTop = flow.scrollHeight;
}

// addSystemMsg: geriye dönük uyumluluk
function addSystemMsg(text) { appendMsg('', text, true); }

// ── VIDEO TİPİ VE ID ÇIKARMA ──────────────────────────────────────────────────
function parseVideoUrl(url) {
    if (!url) return null;
    const ytMatch = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return { type: 'youtube', id: ytMatch[1] };
    const driveMatch = url.match(/(?:drive\.google\.com\/file\/d\/|drive\.google\.com\/open\?id=|docs\.google\.com\/file\/d\/)([a-zA-Z0-9_-]+)/);
    if (driveMatch) return { type: 'drive', id: driveMatch[1] };
    return null;
}

// ── MESAJ GÖNDERME ────────────────────────────────────────────────────────────
function sendChat() {
    const inp  = document.getElementById('chatInp');
    const text = inp.value.trim();
    if (!text) return;
    db.ref('rooms/' + rCode + '/messages').push({ user: uName, text, time: Date.now() });
    inp.value = '';
    inp.focus();
}

// ── PLAYLİST (İZLEME ODASI) ──────────────────────────────────────────────────
let roomPlaylist = [];

function renderPlaylistPanel() {
    const list = document.getElementById('playlist-panel-list');
    if (!list) return;
    list.innerHTML = '';
    roomPlaylist.forEach((url, i) => {
        const parsed = parseVideoUrl(url);
        const type   = parsed ? parsed.type : 'unknown';
        const label  = type === 'youtube' ? 'YT' : type === 'drive' ? 'DRIVE' : '?';
        const cls    = type === 'youtube' ? 'badge-yt' : type === 'drive' ? 'badge-drive' : 'badge-unknown';
        const short  = url.length > 38 ? url.slice(0, 38) + '…' : url;
        const isActive = i === currentPlaylistIndex;

        const div = document.createElement('div');
        div.className = 'plist-item' + (isActive ? ' active' : '');
        div.innerHTML = `
            <span class="plist-badge ${cls}">${label}</span>
            <span class="plist-text" title="${escHtml(url)}">${escHtml(short)}</span>
            ${role === 'host' ? `<button class="plist-play-btn" onclick="hostSwitchTo(${i})" title="Bu videoyu oynat">▶</button>` : ''}
        `;
        list.appendChild(div);
    });
}

// Host: odanın playlist'ine yeni video ekle
function addVideoToRoom() {
    if (role !== 'host') return;
    const inp  = document.getElementById('addVideoInp');
    const url  = inp.value.trim();
    if (!url) return;
    const parsed = parseVideoUrl(url);
    if (!parsed) {
        // FIX: Hata mesajını hem sistem mesajı olarak yaz hem de
        // playlist panelinde (input'un yanında) kısa bir uyarı göster —
        // çünkü kullanıcı playlist sekmesindeyken chat-flow görünmez.
        addSystemMsg('⚠️ Geçersiz link. Sadece YouTube veya Google Drive desteklenir.');
        inp.style.borderColor = '#ff4444';
        inp.placeholder = '⚠️ Geçersiz link! YouTube veya Drive girin.';
        setTimeout(() => {
            inp.style.borderColor = '';
            inp.placeholder = 'YouTube veya Drive linki ekle...';
        }, 3000);
        return;
    }
    inp.style.borderColor = '';
    inp.placeholder = 'YouTube veya Drive linki ekle...';
    const newList = [...roomPlaylist, url];
    db.ref('rooms/' + rCode + '/playlist').set(newList);
    inp.value = '';
}

// Host: belirli bir index'e geç
function hostSwitchTo(index) {
    if (role !== 'host') return;
    const url = roomPlaylist[index];
    if (!url) return;
    currentPlaylistIndex = index;
    db.ref('rooms/' + rCode + '/sync').update({ videoId: url, time: 0, state: -1, playlistIndex: index });
    loadVideo(url, { time: 0, state: -1 });
    renderPlaylistPanel();
}

// Host: sonraki video
function hostNext() {
    if (role !== 'host') return;
    if (currentPlaylistIndex < roomPlaylist.length - 1) hostSwitchTo(currentPlaylistIndex + 1);
    else addSystemMsg('📋 Bu son video.');
}

// Host: önceki video
function hostPrev() {
    if (role !== 'host') return;
    if (currentPlaylistIndex > 0) hostSwitchTo(currentPlaylistIndex - 1);
    else addSystemMsg('📋 Bu ilk video.');
}

// ── VIDEO YÜKLEME ─────────────────────────────────────────────────────────────
let currentVideoType = null;

function loadVideo(url, syncData) {
    const parsed = parseVideoUrl(url);
    if (!parsed) return;
    if (parsed.type === 'youtube') {
        switchToYouTube(parsed.id, syncData);
    } else if (parsed.type === 'drive') {
        switchToDrive(parsed.id, syncData);
    }
}

function switchToYouTube(videoId, syncData) {
    // Drive'ı kaldır
    const driveWrap = document.getElementById('driveWrap');
    if (driveWrap) driveWrap.remove();
    document.getElementById('player').style.display = 'block';
    currentVideoType = 'youtube';
    loadYouTubeById(videoId);
}

function loadYouTubeById(videoId) {
    if (!player || !player.loadVideoById) return;
    if (player.getVideoData && player.getVideoData().video_id !== videoId) {
        player.loadVideoById(videoId);
    }
}

function switchToDrive(fileId, syncData) {
    currentVideoType = 'drive';
    document.getElementById('player').style.display = 'none';

    let wrap = document.getElementById('driveWrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'driveWrap';
        wrap.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;background:#000;';
        document.querySelector('.video-container').appendChild(wrap);
    }

    if (wrap.dataset.fileId === fileId) return;
    wrap.dataset.fileId = fileId;

    const embedUrl = `https://drive.google.com/file/d/${fileId}/preview?rm=minimal`;
    wrap.innerHTML = `
        <iframe id="driveFrame" src="${embedUrl}" width="100%" height="100%"
            style="border:none;display:block;"
            allow="autoplay; fullscreen" allowfullscreen></iframe>
        <div style="position:absolute;bottom:0;left:0;right:0;
            background:linear-gradient(transparent,rgba(0,0,0,0.85));
            color:#aaa;font-size:11px;text-align:center;
            padding:6px;pointer-events:none;font-family:sans-serif;">
            📁 Google Drive — host videoyu kontrol eder
        </div>`;

    if (role === 'host') {
        setTimeout(() => addSystemMsg('📌 Drive videosu yüklendi. Hazır olduğunuzda sohbetten "HAZIR" yazın.'), 800);
    }
}

// ── ANA UYGULAMA ──────────────────────────────────────────────────────────────
function initApp() {
    const roomRef = db.ref('rooms/' + rCode);

    // Mesajları dinle
    roomRef.child('messages').on('child_added', snap => {
        const m = snap.val();
        appendMsg(m.user, m.text, false);
    });

    // Playlist'i dinle (hem host hem guest için anlık güncelleme)
    roomRef.child('playlist').on('value', snap => {
        const list = snap.val();
        if (Array.isArray(list)) {
            roomPlaylist = list;
            renderPlaylistPanel();
        }
    });

    // Senkronizasyon dinle
    roomRef.child('sync').on('value', snap => {
        const data = snap.val();
        if (!data) return;

        // Playlist index senkronizasyonu
        if (typeof data.playlistIndex === 'number') {
            currentPlaylistIndex = data.playlistIndex;
            renderPlaylistPanel();
        }

        const parsed = parseVideoUrl(data.videoId);
        if (!parsed) return;

        if (parsed.type === 'youtube') {
            switchToYouTube(parsed.id, data);
            if (!player || !player.loadVideoById) return;
            if (player.getVideoData && player.getVideoData().video_id !== parsed.id) {
                player.loadVideoById(parsed.id);
            }
            // FIX: Sadece guest'ler senkronize edilir; host'un kendi kontrolü zaten var
            if (role === 'guest') {
                const diff = Math.abs(player.getCurrentTime() - data.time);
                if (diff > 3) player.seekTo(data.time, true);
                data.state === 1 ? player.playVideo() : player.pauseVideo();
            }
        } else if (parsed.type === 'drive') {
            if (role === 'guest') switchToDrive(parsed.id, data);
        }
    });

    // Host: playlist başlat & periyodik sync yaz
    if (role === 'host') {
        const savedPlaylist = JSON.parse(localStorage.getItem('playlist') || '[]');
        if (savedPlaylist.length > 0) {
            roomPlaylist = savedPlaylist;
            roomRef.child('playlist').set(savedPlaylist);
            roomRef.child('sync').update({ videoId: savedPlaylist[0], time: 0, state: -1, playlistIndex: 0 });
            loadVideo(savedPlaylist[0], { time: 0, state: -1 });
            // FIX: Oda başlatıldıktan sonra localStorage'ı temizle.
            // Aksi takdirde sayfa yenilendiğinde eski playlist Firebase'deki
            // mevcut (addVideoToRoom ile güncellenen) listeyi sıfırlar.
            localStorage.removeItem('playlist');
        }

        setInterval(() => {
            const driveEl = document.getElementById('driveVideo');
            if (driveEl) {
                roomRef.child('sync').update({ time: driveEl.currentTime, state: driveEl.paused ? 2 : 1 });
            } else if (player && player.getCurrentTime) {
                roomRef.child('sync').update({ time: player.getCurrentTime(), state: player.getPlayerState() });
            }
        }, 2000);
    }

    // WebRTC: sinyal dinlemeye başla
    listenForSignals();
}

// ── YOUTUBE API READY ─────────────────────────────────────────────────────────
function onYouTubeIframeAPIReady() {
    // FIX: Guest'ler için controls:0 → YT'nin kendi UI'ını tamamen kapatır
    player = new YT.Player('player', {
        height: '100%',
        width:  '100%',
        videoId: '',
        playerVars: {
            controls:   role === 'host' ? 1 : 0,  // Guest'te kontroller gizli
            disablekb:  role === 'host' ? 0 : 1,  // Guest'te klavye kısayolları kapalı
            rel:        0,
            playsinline: 1,
            modestbranding: 1
        },
        events: { onReady: initApp }
    });
}

// ── MİKROFON / SESLİ SOHBET ──────────────────────────────────────────────────
async function toggleMic() {
    const btn = document.getElementById('micBtn');
    if (!micActive) {
        try {
            // FIX: getUserMedia başarılı olmazsa catch'e düşmeli, appendMsg çağrılmalı
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            micActive = true;
            btn.classList.add('active');
            addSystemMsg('🎙️ Mikrofon açıldı');
            announcePresence(); // Presence yaz + peer'lara offer gönder
        } catch (e) {
            console.error('Mikrofon hatası:', e);
            addSystemMsg('⚠️ Mikrofon erişimi reddedildi: ' + e.message);
        }
    } else {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        micActive   = false;
        btn.classList.remove('active');
        addSystemMsg('🔇 Mikrofon kapatıldı');
        Object.values(peers).forEach(pc => pc.close());
        peers = {};
        db.ref('rooms/' + rCode + '/voice/' + uName).remove();
    }
}

// ── WebRTC: Presence & Signaling ─────────────────────────────────────────────
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

const pendingCandidates = {};

function announcePresence() {
    const myRef = db.ref('rooms/' + rCode + '/voice/' + uName);
    myRef.set({ online: true, ts: Date.now() });
    myRef.onDisconnect().remove();

    // Odada zaten olan kullanıcılara offer gönder
    db.ref('rooms/' + rCode + '/voice').once('value', snap => {
        snap.forEach(child => {
            if (child.key !== uName) createOffer(child.key);
        });
    });

    // Sonradan katılanlar için
    db.ref('rooms/' + rCode + '/voice').on('child_added', snap => {
        if (snap.key !== uName && !peers[snap.key]) createOffer(snap.key);
    });
}

function createOffer(targetId) {
    if (peers[targetId]) return;
    const pc = createPeerConnection(targetId);

    // FIX: offerToReceiveAudio:true — karşı taraftan ses almak için şart
    pc.createOffer({ offerToReceiveAudio: true })
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            db.ref('rooms/' + rCode + '/signals/' + targetId + '/' + uName).push({
                type: 'offer', sdp: pc.localDescription.sdp
            });
        })
        .catch(e => console.error('createOffer hata:', e));
}

function listenForSignals() {
    db.ref('rooms/' + rCode + '/signals/' + uName).on('child_added', snap => {
        const fromId = snap.key;
        snap.on('child_added', msgSnap => {
            const msg = msgSnap.val();
            if (!msg) return;
            msgSnap.ref.remove(); // Okundu, temizle
            if      (msg.type === 'offer')     handleOffer(fromId, msg);
            else if (msg.type === 'answer')    handleAnswer(fromId, msg);
            else if (msg.type === 'candidate') handleCandidate(fromId, msg);
        });
    });
}

function createPeerConnection(peerId) {
    if (peers[peerId]) peers[peerId].close();
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peers[peerId] = pc;
    pendingCandidates[peerId] = [];

    // Kendi ses track'ini ekle
    if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // ICE candidate'ları Firebase'e gönder
    pc.onicecandidate = e => {
        if (e.candidate) {
            db.ref('rooms/' + rCode + '/signals/' + peerId + '/' + uName).push({
                type:         'candidate',
                candidate:    e.candidate.candidate,
                sdpMid:       e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
            });
        }
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        // FIX: appendMsg yerine addSystemMsg kullanılıyordu ama appendMsg tanımlı değildi
        // Artık appendMsg düzgün tanımlı
        if (s === 'connected')    addSystemMsg('🔊 ' + peerId + ' sesli bağlandı');
        if (s === 'disconnected' || s === 'failed') {
            addSystemMsg('🔇 ' + peerId + ' bağlantısı kesildi');
            const a = document.getElementById('audio_' + peerId);
            if (a) a.remove();
            delete peers[peerId];
        }
    };

    // FIX: Karşı tarafın ses track'i geldiğinde <audio> elementine bağla
    // Bu kısım çalışmıyordu çünkü appendMsg ReferenceError fırlatıyordu ve
    // ontrack handler'ın üzerindeki kod execution'ı kesiyordu.
    pc.ontrack = e => {
        let audio = document.getElementById('audio_' + peerId);
        if (!audio) {
            audio          = document.createElement('audio');
            audio.id       = 'audio_' + peerId;
            audio.autoplay = true;
            audio.playsInline = true;
            document.body.appendChild(audio);
        }
        // FIX: srcObject'i streams[0]'dan al (e.track değil)
        audio.srcObject = e.streams[0];
        audio.play().catch(() => {
            // Mobil autoplay politikası: ilk kullanıcı etkileşiminde oynat
            const tryPlay = () => audio.play().catch(() => {});
            document.addEventListener('touchstart', tryPlay, { once: true });
            document.addEventListener('click',      tryPlay, { once: true });
        });
    };

    return pc;
}

async function handleOffer(fromId, msg) {
    const pc = createPeerConnection(fromId);

    // Track'i setRemoteDescription'dan önce ekle
    if (localStream) {
        localStream.getTracks().forEach(t => {
            if (!pc.getSenders().find(s => s.track === t)) pc.addTrack(t, localStream);
        });
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });

    // Birikmiş candidate'leri uygula
    for (const c of (pendingCandidates[fromId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    pendingCandidates[fromId] = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    db.ref('rooms/' + rCode + '/signals/' + fromId + '/' + uName).push({
        type: 'answer', sdp: pc.localDescription.sdp
    });
}

async function handleAnswer(fromId, msg) {
    const pc = peers[fromId];
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    for (const c of (pendingCandidates[fromId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    pendingCandidates[fromId] = [];
}

async function handleCandidate(fromId, msg) {
    const pc   = peers[fromId];
    const cand = { candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex };
    if (!pc || !pc.remoteDescription) {
        if (!pendingCandidates[fromId]) pendingCandidates[fromId] = [];
        pendingCandidates[fromId].push(cand);
    } else {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    }
}
