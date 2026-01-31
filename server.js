const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001; // Use Render's PORT env var
/* -------------------- DATA STORES -------------------- */
const rooms = new Map(); // roomId -> { users, messages, currentVideo }
const users = new Map(); // socketId -> user
const messageCooldown = new Map(); // anti-spam
/* -------------------- HELPERS -------------------- */
function createUser(socketId, username) {
  return {
    id: socketId,
    username: username?.slice(0, 20) || `User${Math.floor(Math.random() * 1000)}`,
    color: `hsl(${Math.random() * 360}, 70%, 60%)`
  };
}
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Set(),
      messages: [],
      currentVideo: null,
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}
function canSendMessage(socketId) {
  const now = Date.now();
  const last = messageCooldown.get(socketId) || 0;
  if (now - last < 400) return false; // 2.5 msgs/sec
  messageCooldown.set(socketId, now);
  return true;
}
/* -------------------- SOCKET LOGIC -------------------- */
io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);
  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId) return;
    const user = createUser(socket.id, username);
    users.set(socket.id, user);
    const room = getRoom(roomId);
    room.users.add(socket.id);
    socket.join(roomId);
    socket.emit("room-joined", {
      user,
      currentVideo: room.currentVideo,
      messages: room.messages.slice(-50),
      totalUsers: room.users.size
    });
    socket.to(roomId).emit("user-joined", {
      user,
      totalUsers: room.users.size
    });
  });
  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message) return;
    if (!canSendMessage(socket.id)) return;
    const user = users.get(socket.id);
    if (!user || !rooms.has(roomId)) return;
    const msg = {
      id: crypto.randomUUID(),
      user,
      message: message.slice(0, 500),
      timestamp: Date.now()
    };
    const room = rooms.get(roomId);
    room.messages.push(msg);
    if (room.messages.length > 100) {
      room.messages.shift();
    }
    io.to(roomId).emit("new-message", msg);
  });
  socket.on("change-video", ({ roomId, videoId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    rooms.get(roomId).currentVideo = videoId;
    socket.to(roomId).emit("video-changed", { videoId });
  });
  socket.on("sync-video", ({ roomId, currentTime, isPlaying }) => {
    if (!roomId) return;
    socket.to(roomId).emit("video-sync", {
      currentTime,
      isPlaying
    });
  });
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    rooms.forEach((room, roomId) => {
      if (room.users.delete(socket.id)) {
        socket.to(roomId).emit("user-left", {
          user,
          totalUsers: room.users.size
        });
        if (room.users.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
    users.delete(socket.id);
    messageCooldown.delete(socket.id);
    console.log("🔴 Disconnected:", socket.id);
  });
});
/* -------------------- SERVER -------------------- */
server.listen(PORT, () => {
  console.log(`🔥 Sovereign backend running on port ${PORT}`);
});
