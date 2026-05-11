const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function parseVideoUrl(url) {
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1], url };

  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    return {
      type: 'direct',
      url: `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`,
      originalUrl: url
    };
  }
  return { type: 'direct', url };
}

io.on('connection', (socket) => {
  console.log('Kullanıcı bağlandı:', socket.id);

  // Oda oluştur
  socket.on('createRoom', ({ username }) => {
    if (!username) return;
    const code = generateRoomCode();
    socket.roomId = code;
    socket.username = username;

    rooms[code] = {
      adminSocketId: socket.id,
      playlist: [],
      currentIndex: 0,
      currentVideo: null,
      users: new Map(),
      adminOrder: [socket.id],
      messages: []
    };
    socket.join(code);
    socket.isAdmin = true;
    socket.emit('roomCreated', { roomCode: code, isAdmin: true });
    socket.emit('roomState', rooms[code]);
  });

  // Odaya katıl
  socket.on('joinRoom', ({ roomCode, username }) => {
    if (!roomCode || !username) return;
    roomCode = roomCode.toUpperCase();
    if (!rooms[roomCode]) {
      return socket.emit('error', { message: 'Oda bulunamadı' });
    }

    const room = rooms[roomCode];
    socket.roomId = roomCode;
    socket.username = username;
    socket.join(roomCode);
    room.users.set(socket.id, username);
    room.adminOrder.push(socket.id);
    socket.isAdmin = false;

    socket.emit('roomJoined', { roomCode, isAdmin: false });
    socket.emit('roomState', {
      currentVideo: room.currentVideo,
      playlist: room.playlist,
      currentIndex: room.currentIndex,
      messages: room.messages
    });
  });

  // ---------- VİDEO KONTROLLERİ ----------
  socket.on('play', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.isPlaying = true;
    socket.to(socket.roomId).emit('syncPlay', { time: room.currentVideo.time });
  });

  socket.on('pause', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.isPlaying = false;
    socket.to(socket.roomId).emit('syncPause', { time: room.currentVideo.time });
  });

  socket.on('seek', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.time = parseFloat(data.time) || 0;
    socket.to(socket.roomId).emit('syncSeek', { time: room.currentVideo.time });
  });

  socket.on('adminUpdate', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.time = parseFloat(data.currentTime) || 0;
    room.currentVideo.isPlaying = data.isPlaying;
  });

  socket.on('addToPlaylist', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room) return;

    const videoInfo = parseVideoUrl(data.url);
    if (!videoInfo) {
      socket.emit('error', { message: 'Geçersiz video bağlantısı' });
      return;
    }

    videoInfo.title = data.url;
    room.playlist.push(videoInfo);

    if (!room.currentVideo && room.playlist.length === 1) {
      room.currentVideo = videoInfo;
      room.currentIndex = 0;
      room.currentVideo.time = 0;
      room.currentVideo.isPlaying = false;
      io.to(socket.roomId).emit('loadVideo', { video: videoInfo, index: 0 });
    } else {
      io.to(socket.roomId).emit('playlistUpdate', { playlist: room.playlist });
    }
  });

  socket.on('videoEnded', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room) return;

    if (room.playlist.length > room.currentIndex + 1) {
      room.currentIndex++;
      room.currentVideo = room.playlist[room.currentIndex];
      room.currentVideo.time = 0;
      room.currentVideo.isPlaying = true;
      io.to(socket.roomId).emit('loadVideo', { video: room.currentVideo, index: room.currentIndex });
    } else {
      io.to(socket.roomId).emit('playlistEnded');
    }
  });

  // ---------- CHAT ----------
  socket.on('chatMessage', (text) => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    const msg = { username: socket.username, text: text.substring(0, 200), time: Date.now() };
    rooms[socket.roomId].messages.push(msg);
    io.to(socket.roomId).emit('chatMessage', msg);
  });

  // ---------- WEBRTC SİNYALLEŞME ----------
  socket.on('webrtc_offer', ({ to, offer }) => {
    io.to(to).emit('webrtc_offer', { from: socket.id, offer });
  });
  socket.on('webrtc_answer', ({ to, answer }) => {
    io.to(to).emit('webrtc_answer', { from: socket.id, answer });
  });
  socket.on('webrtc_ice_candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc_ice_candidate', { from: socket.id, candidate });
  });
  socket.on('getRoomUsers', (callback) => {
    const room = rooms[socket.roomId];
    if (room) callback(Array.from(room.users.keys()));
  });

  // ---------- BAĞLANTI KOPMA ----------
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.users.delete(socket.id);
    const idx = room.adminOrder.indexOf(socket.id);
    if (idx !== -1) room.adminOrder.splice(idx, 1);

    if (socket.isAdmin) {
      if (room.adminOrder.length > 0) {
        const newAdminId = room.adminOrder[0];
        room.adminSocketId = newAdminId;
        const newSocket = io.sockets.sockets.get(newAdminId);
        if (newSocket) {
          newSocket.isAdmin = true;
          newSocket.emit('role', { isAdmin: true });
        }
      } else {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda`));