// Sunucu: Express + Socket.IO ile odalar, admin yönetimi ve senkronizasyon
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statik dosyaları public klasöründen sun
app.use(express.static('public'));

// Odaların durumlarını tutan ana nesne
const rooms = {};

// Bir video bağlantısını ayrıştırıp türünü (YouTube veya doğrudan MP4/Drive) belirler
function parseVideoUrl(url) {
  // YouTube: watch, embed, v/ veya youtu.be formatları
  const ytMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (ytMatch) {
    return { type: 'youtube', id: ytMatch[1], url: url };
  }

  // Google Drive paylaşım bağlantısı → doğrudan indirme bağlantısına çevir
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    const directUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
    return { type: 'direct', url: directUrl, originalUrl: url };
  }

  // Diğer tüm bağlantıları doğrudan medya olarak kabul et
  return { type: 'direct', url: url };
}

io.on('connection', (socket) => {
  console.log('Kullanıcı bağlandı:', socket.id);

  // Odaya katılma isteği
  socket.on('joinRoom', ({ roomId, username }) => {
    if (!roomId || !username) return;

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;

    // Oda yoksa oluştur, ilk kullanıcı admin olsun
    if (!rooms[roomId]) {
      rooms[roomId] = {
        adminSocketId: socket.id,
        playlist: [],
        currentIndex: 0,
        currentVideo: null, // { type, url/id, time, isPlaying }
        users: new Map(),
        adminOrder: [socket.id] // admin değişimi için katılım sırası
      };
      socket.isAdmin = true;
    } else {
      // Var olan odaya katıl
      rooms[roomId].users.set(socket.id, username);
      rooms[roomId].adminOrder.push(socket.id);
      socket.isAdmin = false;
    }

    // Admin ise oda kaydını güncelle ve kullanıcıya bildir
    if (socket.isAdmin) {
      rooms[roomId].adminSocketId = socket.id;
      socket.emit('role', { isAdmin: true });
    } else {
      socket.emit('role', { isAdmin: false });
    }

    // Yeni kullanıcıya güncel oda durumunu gönder
    const room = rooms[roomId];
    socket.emit('roomState', {
      currentVideo: room.currentVideo,
      playlist: room.playlist,
      currentIndex: room.currentIndex
    });

    console.log(`${username}, "${roomId}" odasına katıldı. Admin: ${socket.isAdmin}`);
  });

  // ---------- Admin olayları ----------

  // Admin oynatma başlattı
  socket.on('play', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.isPlaying = true;
    socket.to(socket.roomId).emit('syncPlay', { time: room.currentVideo.time });
  });

  // Admin duraklattı
  socket.on('pause', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.isPlaying = false;
    socket.to(socket.roomId).emit('syncPause', { time: room.currentVideo.time });
  });

  // Admin ileri/geri sardı
  socket.on('seek', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    const time = parseFloat(data.time) || 0;
    room.currentVideo.time = time;
    socket.to(socket.roomId).emit('syncSeek', { time });
  });

  // Admin istemcisinden periyodik durum güncellemesi (yeni katılanlar ve durum takibi için)
  socket.on('adminUpdate', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room?.currentVideo) return;
    room.currentVideo.time = parseFloat(data.currentTime) || room.currentVideo.time;
    room.currentVideo.isPlaying = data.isPlaying;
  });

  // Admin oynatma listesine video ekledi
  socket.on('addToPlaylist', (data) => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room) return;

    const videoInfo = parseVideoUrl(data.url);
    if (videoInfo) {
      videoInfo.title = data.url; // Başlık şimdilik URL'nin kendisi
      room.playlist.push(videoInfo);

      // Eğer oynatılan video yoksa bu videoyu otomatik yükle (ancak otomatik oynatma)
      if (!room.currentVideo && room.playlist.length === 1) {
        room.currentVideo = videoInfo;
        room.currentIndex = 0;
        room.currentVideo.time = 0;
        room.currentVideo.isPlaying = false; // Admin play'e basana kadar bekle
        io.to(socket.roomId).emit('loadVideo', { video: videoInfo, index: 0 });
      } else {
        // Sadece liste güncellendi bilgisi gönder
        io.to(socket.roomId).emit('playlistUpdate', { playlist: room.playlist });
      }
    } else {
      socket.emit('error', { message: 'Geçersiz video bağlantısı' });
    }
  });

  // Admin istemcisi videonun bittiğini bildirdi
  socket.on('videoEnded', () => {
    if (!socket.isAdmin) return;
    const room = rooms[socket.roomId];
    if (!room) return;

    // Sonraki video varsa ona geç
    if (room.playlist.length > room.currentIndex + 1) {
      room.currentIndex++;
      room.currentVideo = room.playlist[room.currentIndex];
      room.currentVideo.time = 0;
      room.currentVideo.isPlaying = true; // otomatik oynat
      io.to(socket.roomId).emit('loadVideo', {
        video: room.currentVideo,
        index: room.currentIndex
      });
    } else {
      // Liste bitti
      io.to(socket.roomId).emit('playlistEnded');
    }
  });

  // Kullanıcı manuel olarak durum isteyebilir (opsiyonel)
  socket.on('requestState', () => {
    const room = rooms[socket.roomId];
    if (room) {
      socket.emit('roomState', {
        currentVideo: room.currentVideo,
        playlist: room.playlist,
        currentIndex: room.currentIndex
      });
    }
  });

  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.users.delete(socket.id);

    // Admin sıralamasından çıkar
    const orderIndex = room.adminOrder.indexOf(socket.id);
    if (orderIndex !== -1) room.adminOrder.splice(orderIndex, 1);

    // Ayrılan admin ise yeni admin ata
    if (socket.isAdmin) {
      if (room.adminOrder.length > 0) {
        const newAdminId = room.adminOrder[0];
        room.adminSocketId = newAdminId;
        const newAdminSocket = io.sockets.sockets.get(newAdminId);
        if (newAdminSocket) {
          newAdminSocket.isAdmin = true;
          newAdminSocket.emit('role', { isAdmin: true });
          console.log(`Yeni admin: ${newAdminSocket.username}`);
        }
      } else {
        // Odada kimse kalmadıysa odayı sil
        delete rooms[roomId];
      }
    }
    console.log('Kullanıcı ayrıldı:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Sunucu 3000 portunda çalışıyor');
});
