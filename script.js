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
const uName = params.get('user') || "Anonim";
const rCode = params.get('room') || "TEST";
const role  = params.get('role') || "guest";

let player;
let currentPlaylistIndex = 0;
let micActive = false;
let localStream = null;
let peers = {}; // peerId -> RTCPeerConnection

document.getElementById('roomLabel').innerText = "ODA: " + rCode;
document.getElementById('roleLabel').innerText = "ROL: " + role.toUpperCase();

// ── VIDEO ID ÇIKARMA ──────────────────────────────────────────────────────────
function extractVideoID(url) {
    if (!url) return null;
    // youtu.be/ID veya watch?v=ID
    const regExp = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regExp);
    return match ? match[1] : null;
}

// ── MESAJ GÖNDERME ────────────────────────────────────────────────────────────
function sendChat() {
    const inp = document.getElementById('chatInp');
    const text = inp.value.trim();
    if (!text) return;
    db.ref('rooms/' + rCode + '/messages').push({
        user: uName,
        text: text,
        time: Date.now()
    });
    inp.value = '';
    inp.focus(); // klavye açık kalsın
}

// ── ANA UYGULAMA ──────────────────────────────────────────────────────────────
function initApp() {
    const roomRef = db.ref('rooms/' + rCode);

    // Mesajları dinle
    roomRef.child('messages').on('child_added', (snapshot) => {
        const m = snapshot.val();
        const flow = document.getElementById('chat-flow');
        const div = document.createElement('div');
        div.className = 'msg';
        div.innerHTML = `<b>${escHtml(m.user)}</b>${escHtml(m.text)}`;
        flow.appendChild(div);
        flow.scrollTop = flow.scrollHeight;
    });

    // Senkronizasyon dinle
    roomRef.child('sync').on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data || !player || !player.loadVideoById) return;

        const vID = extractVideoID(data.videoId) || data.videoId;

        // Video değiştiyse yükle
        if (vID && player.getVideoData && player.getVideoData().video_id !== vID) {
            player.loadVideoById(vID);
        }

        // Guest senkronizasyonu
        if (role === 'guest') {
            const diff = Math.abs(player.getCurrentTime() - data.time);
            if (diff > 3) player.seekTo(data.time, true);
            data.state === 1 ? player.playVideo() : player.pauseVideo();
        }
    });

    // Host: her 2 saniyede durumu yaz
    if (role === 'host') {
        // Playlist'i Firebase'e yaz (ilk video + tüm liste)
        const playlist = JSON.parse(localStorage.getItem('playlist') || '[]');
        if (playlist.length > 0) {
            const firstVideoId = extractVideoID(playlist[0]) || playlist[0];
            roomRef.child('sync').update({ videoId: firstVideoId, time: 0, state: -1 });
            roomRef.child('playlist').set(playlist);
        }

        setInterval(() => {
            if (player && player.getCurrentTime) {
                roomRef.child('sync').update({
                    time: player.getCurrentTime(),
                    state: player.getPlayerState()
                });
            }
        }, 2000);
    }

    // WebRTC: diğer kullanıcıların signal'larını dinle
    listenForSignals();
}

// ── YOUTUBE API READY ─────────────────────────────────────────────────────────
function onYouTubeIframeAPIReady() {
    db.ref('rooms/' + rCode + '/sync/videoId').once('value', (snapshot) => {
        const rawId = snapshot.val();
        const initialID = (rawId ? (extractVideoID(rawId) || rawId) : null) || 'dQw4w9WgXcQ';
        player = new YT.Player('player', {
            height: '100%',
            width: '100%',
            videoId: initialID,
            playerVars: { controls: (role === 'host' ? 1 : 0), rel: 0, playsinline: 1 },
            events: { onReady: initApp }
        });
    });
}

// ── MİKROFON / SESLİ SOHBET ──────────────────────────────────────────────────
async function toggleMic() {
    const btn = document.getElementById('micBtn');
    if (!micActive) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            micActive = true;
            btn.classList.add('active');
            addSystemMsg('🎙️ Mikrofon açıldı');
            announcePresence();
        } catch (e) {
            addSystemMsg('⚠️ Mikrofon erişimi reddedildi');
        }
    } else {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        micActive = false;
        btn.classList.remove('active');
        addSystemMsg('🔇 Mikrofon kapatıldı');
        // Peer bağlantıları kapat
        Object.values(peers).forEach(pc => pc.close());
        peers = {};
        // Presence sil
        db.ref('rooms/' + rCode + '/voice/' + uName).remove();
    }
}

function announcePresence() {
    const myRef = db.ref('rooms/' + rCode + '/voice/' + uName);
    myRef.set({ online: true });
    myRef.onDisconnect().remove();

    // Odadaki diğer kullanıcılara offer gönder
    db.ref('rooms/' + rCode + '/voice').once('value', snap => {
        snap.forEach(child => {
            const otherId = child.key;
            if (otherId !== uName) createOffer(otherId);
        });
    });
}

function createOffer(targetId) {
    const pc = createPeerConnection(targetId);
    pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        db.ref('rooms/' + rCode + '/signals/' + targetId + '/' + uName).push({
            type: 'offer', sdp: offer.sdp
        });
    });
}

function listenForSignals() {
    db.ref('rooms/' + rCode + '/signals/' + uName).on('child_added', (snap) => {
        const fromId = snap.key;
        snap.forEach(msgSnap => {
            const msg = msgSnap.val();
            if (msg.type === 'offer') handleOffer(fromId, msg);
            else if (msg.type === 'answer') handleAnswer(fromId, msg);
            else if (msg.type === 'candidate') handleCandidate(fromId, msg);
            msgSnap.ref.remove();
        });
    });
}

function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peers[peerId] = pc;

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = e => {
        if (e.candidate) {
            db.ref('rooms/' + rCode + '/signals/' + peerId + '/' + uName).push({
                type: 'candidate',
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
            });
        }
    };

    pc.ontrack = e => {
        let audio = document.getElementById('audio_' + peerId);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'audio_' + peerId;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = e.streams[0];
        addSystemMsg('🔊 ' + peerId + ' bağlandı');
    };

    return pc;
}

function handleOffer(fromId, msg) {
    const pc = createPeerConnection(fromId);
    pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp }).then(() => {
        if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        return pc.createAnswer();
    }).then(answer => {
        pc.setLocalDescription(answer);
        db.ref('rooms/' + rCode + '/signals/' + fromId + '/' + uName).push({
            type: 'answer', sdp: answer.sdp
        });
    });
}

function handleAnswer(fromId, msg) {
    const pc = peers[fromId];
    if (pc) pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
}

function handleCandidate(fromId, msg) {
    const pc = peers[fromId];
    if (pc) pc.addIceCandidate(new RTCIceCandidate({
        candidate: msg.candidate,
        sdpMid: msg.sdpMid,
        sdpMLineIndex: msg.sdpMLineIndex
    }));
}

// ── YARDIMCI ─────────────────────────────────────────────────────────────────
function addSystemMsg(text) {
    const flow = document.getElementById('chat-flow');
    const div = document.createElement('div');
    div.className = 'msg';
    div.style.borderColor = '#7000ff';
    div.style.color = '#aaa';
    div.style.fontSize = '12px';
    div.innerText = text;
    flow.appendChild(div);
    flow.scrollTop = flow.scrollHeight;
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
