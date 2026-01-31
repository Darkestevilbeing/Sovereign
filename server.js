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

const PORT = process.env.PORT || 3001;

/* -------------------- DATA STORES -------------------- */
const rooms = new Map(); // roomId -> { owner, users, messages, currentVideo, bannedUsers, mutedUsers }
const users = new Map(); // socketId -> user
const messageCooldown = new Map();

/* -------------------- HELPERS -------------------- */
function createUser(socketId, username, role = 'viewer') {
  return {
    id: socketId,
    username: username?.slice(0, 20) || `User${Math.floor(Math.random() * 1000)}`,
    color: `hsl(${Math.random() * 360}, 70%, 60%)`,
    role // 'owner' or 'viewer'
  };
}

function generateRoomId() {
  // Generate a proper 6-character alphanumeric room ID
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function isValidRoomId(roomId) {
  // Room IDs must be 6 alphanumeric characters
  return /^[A-Z0-9]{6}$/.test(roomId);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      owner: null,
      users: new Map(), // socketId -> user object
      messages: [],
      currentVideo: null,
      currentTime: 0,
      isPlaying: false,
      bannedUsers: new Set(), // usernames
      mutedUsers: new Set(), // socketIds
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

function isOwner(socketId, roomId) {
  const room = rooms.get(roomId);
  return room && room.owner === socketId;
}

function isBanned(username, roomId) {
  const room = rooms.get(roomId);
  return room && room.bannedUsers.has(username);
}

function isMuted(socketId, roomId) {
  const room = rooms.get(roomId);
  return room && room.mutedUsers.has(socketId);
}

/* -------------------- SOCKET LOGIC -------------------- */
io.on("connection", (socket) => {
  console.log("🟢 Connected:", socket.id);

  socket.on("create-room", ({ username }) => {
    const roomId = generateRoomId();
    const user = createUser(socket.id, username, 'owner');
    users.set(socket.id, user);
    
    const room = getRoom(roomId);
    room.owner = socket.id;
    room.users.set(socket.id, user);
    
    socket.join(roomId);
    
    socket.emit("room-created", {
      roomId,
      user,
      totalUsers: room.users.size
    });
    
    console.log(`🎬 Room ${roomId} created by ${username}`);
  });

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !isValidRoomId(roomId)) {
      socket.emit("join-error", { message: "Invalid room ID format" });
      return;
    }

    if (!rooms.has(roomId)) {
      socket.emit("join-error", { message: "Room does not exist" });
      return;
    }

    if (isBanned(username, roomId)) {
      socket.emit("join-error", { message: "You have been banned from this room" });
      return;
    }

    const user = createUser(socket.id, username, 'viewer');
    users.set(socket.id, user);
    
    const room = getRoom(roomId);
    room.users.set(socket.id, user);
    
    socket.join(roomId);
    
    socket.emit("room-joined", {
      user,
      currentVideo: room.currentVideo,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      messages: room.messages.slice(-50),
      totalUsers: room.users.size,
      isOwner: false
    });
    
    socket.to(roomId).emit("user-joined", {
      user,
      totalUsers: room.users.size
    });
  });

  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message) return;
    if (!canSendMessage(socket.id)) return;
    if (isMuted(socket.id, roomId)) {
      socket.emit("message-error", { message: "You are muted" });
      return;
    }

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
    if (!isOwner(socket.id, roomId)) {
      socket.emit("permission-error", { message: "Only the room owner can change videos" });
      return;
    }

    const room = rooms.get(roomId);
    room.currentVideo = videoId;
    room.currentTime = 0;
    room.isPlaying = true;

    io.to(roomId).emit("video-changed", { videoId });
  });

  socket.on("sync-video", ({ roomId, currentTime, isPlaying }) => {
    if (!roomId) return;
    if (!isOwner(socket.id, roomId)) return;

    const room = rooms.get(roomId);
    if (room) {
      room.currentTime = currentTime;
      room.isPlaying = isPlaying;
    }

    socket.to(roomId).emit("video-sync", {
      currentTime,
      isPlaying
    });
  });

  socket.on("kick-user", ({ roomId, targetSocketId }) => {
    if (!isOwner(socket.id, roomId)) return;
    
    const room = rooms.get(roomId);
    const targetUser = room?.users.get(targetSocketId);
    
    if (targetUser) {
      io.to(targetSocketId).emit("kicked", { message: "You have been kicked from the room" });
      io.to(targetSocketId).disconnectSockets();
    }
  });

  socket.on("ban-user", ({ roomId, targetSocketId }) => {
    if (!isOwner(socket.id, roomId)) return;
    
    const room = rooms.get(roomId);
    const targetUser = room?.users.get(targetSocketId);
    
    if (targetUser) {
      room.bannedUsers.add(targetUser.username);
      io.to(targetSocketId).emit("banned", { message: "You have been banned from this room" });
      io.to(targetSocketId).disconnectSockets();
    }
  });

  socket.on("mute-user", ({ roomId, targetSocketId }) => {
    if (!isOwner(socket.id, roomId)) return;
    
    const room = rooms.get(roomId);
    if (room) {
      room.mutedUsers.add(targetSocketId);
      io.to(targetSocketId).emit("muted", { message: "You have been muted" });
    }
  });

  socket.on("unmute-user", ({ roomId, targetSocketId }) => {
    if (!isOwner(socket.id, roomId)) return;
    
    const room = rooms.get(roomId);
    if (room) {
      room.mutedUsers.delete(targetSocketId);
      io.to(targetSocketId).emit("unmuted", { message: "You have been unmuted" });
    }
  });

  socket.on("get-users", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      const userList = Array.from(room.users.values()).map(u => ({
        ...u,
        isMuted: room.mutedUsers.has(u.id)
      }));
      socket.emit("users-list", { users: userList });
    }
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;

    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        
        // If owner left, delete the room
        if (room.owner === socket.id) {
          io.to(roomId).emit("room-closed", { message: "Room owner has left. Room closed." });
          rooms.delete(roomId);
        } else {
          socket.to(roomId).emit("user-left", {
            user,
            totalUsers: room.users.size
          });
        }
      }
    });

    users.delete(socket.id);
    messageCooldown.delete(socket.id);
    console.log("🔴 Disconnected:", socket.id);
  });
});

/* -------------------- CLEANUP -------------------- */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    // Delete empty rooms older than 1 hour
    if (room.users.size === 0 && now - room.createdAt > 3600000) {
      rooms.delete(roomId);
      console.log(`🧹 Cleaned up room ${roomId}`);
    }
  });
}, 300000); // Every 5 minutes

/* -------------------- SERVER -------------------- */
server.listen(PORT, () => {
  console.log(`🔥 Sovereign backend running on port ${PORT}`);
});
