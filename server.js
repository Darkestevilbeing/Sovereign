// server.js (backend - deploy this updated version to Render)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const rooms = new Map();
const users = new Map();
const messageCooldown = new Map();

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
      owner: null,
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

function canSendMessage(socketId) {
  const now = Date.now();
  const last = messageCooldown.get(socketId) || 0;
  if (now - last < 400) return false;
  messageCooldown.set(socketId, now);
  return true;
}

io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId) return;
    const user = createUser(socket.id, username);
    users.set(socket.id, user);
    const room = getRoom(roomId);
    const isFirst = room.owner === null;
    room.users.add(socket.id);
    if (isFirst) room.owner = socket.id;
    socket.join(roomId);

    const usersList = Array.from(room.users).map(sid => {
      const u = users.get(sid);
      return { id: u.id, username: u.username, color: u.color };
    });

    socket.emit("room-joined", {
      user,
      currentVideo: room.currentVideo,
      messages: room.messages.slice(-50),
      totalUsers: room.users.size,
      currentOwnerId: room.owner,
      users: usersList
    });

    socket.to(roomId).emit("user-joined", {
      user: { id: user.id, username: user.username, color: user.color },
      totalUsers: room.users.size
    });
  });

  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message || !canSendMessage(socket.id)) return;
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
    if (room.messages.length > 100) room.messages.shift();
    io.to(roomId).emit("new-message", msg);
  });

  socket.on("change-video", ({ roomId, videoId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (socket.id !== room.owner) return;
    room.currentVideo = videoId;
    io.to(roomId).emit("video-changed", { videoId });
  });

  socket.on("sync-video", ({ roomId, currentTime, isPlaying }) => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (socket.id !== room.owner) return;
    io.to(roomId).emit("video-sync", { currentTime, isPlaying });
  });

  socket.on("kick-user", ({ roomId, targetId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (socket.id !== room.owner) return;
    if (!room.users.has(targetId)) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(roomId);
      targetSocket.emit("kicked");
    }
    room.users.delete(targetId);

    const leftUser = users.get(targetId);
    if (leftUser) {
      io.to(roomId).emit("user-left", {
        user: { id: targetId, username: leftUser.username, color: leftUser.color },
        totalUsers: room.users.size
      });
    }
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    rooms.forEach((room, roomId) => {
      if (room.users.delete(socket.id)) {
        let newOwnerId = null;
        if (socket.id === room.owner && room.users.size > 0) {
          const it = room.users.values();
          const newOwner = it.next().value;
          room.owner = newOwner;
          newOwnerId = newOwner;
        }

        io.to(roomId).emit("user-left", {
          user: { id: socket.id, username: user.username, color: user.color },
          totalUsers: room.users.size
        });

        if (newOwnerId) {
          io.to(roomId).emit("owner-changed", { newOwnerId });
        }

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

server.listen(PORT, () => {
  console.log(`🔥 Sovereign backend running on port ${PORT}`);
});
