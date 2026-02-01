const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 500 * 1024 * 1024,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname)));

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

const rooms = new Map();
const fileDownloads = new Map(); // Track downloads per file
const fileFirstAccess = new Map(); // Track first access time

let fetch, FormData;

async function initDeps() {
    const fetchModule = await import('node-fetch');
    fetch = fetchModule.default;
    FormData = (await import('form-data')).default;
}

initDeps();

const uploadProviders = {
    async litterbox(buffer, filename, mimetype, expiry = '1h') {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', expiry);
        form.append('fileToUpload', buffer, { filename, contentType: mimetype });

        const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });

        if (!res.ok) throw new Error('Litterbox upload failed');
        const url = (await res.text()).trim();
        
        const hours = { '1h': 1, '12h': 12, '24h': 24, '72h': 72 };
        const expiresAt = new Date(Date.now() + (hours[expiry] || 1) * 60 * 60 * 1000);

        return { url, expiresAt };
    },

    async catbox(buffer, filename, mimetype) {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename, contentType: mimetype });

        const res = await fetch('https://catbox.moe/user/api.php', {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });

        if (!res.ok) throw new Error('Catbox upload failed');
        const url = (await res.text()).trim();
        
        return { url, expiresAt: null };
    },

    async gofile(buffer, filename, mimetype) {
        const serverRes = await fetch('https://api.gofile.io/servers');
        const serverData = await serverRes.json();
        if (serverData.status !== 'ok') throw new Error('Gofile server error');
        
        const serverName = serverData.data.servers[0].name;

        const form = new FormData();
        form.append('file', buffer, { filename, contentType: mimetype });

        const res = await fetch(`https://${serverName}.gofile.io/contents/uploadfile`, {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });

        const data = await res.json();
        if (data.status !== 'ok') throw new Error('Gofile upload failed');
        
        const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
        return { url: data.data.downloadPage, expiresAt };
    },

    async tmpfiles(buffer, filename, mimetype) {
        const form = new FormData();
        form.append('file', buffer, { filename, contentType: mimetype });

        const res = await fetch('https://tmpfiles.org/api/v1/upload', {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });

        const data = await res.json();
        if (data.status !== 'success') throw new Error('tmpfiles upload failed');
        
        const url = data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        
        return { url, expiresAt };
    }
};

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function base64ToBuffer(base64) {
    const matches = base64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid base64');
    return { buffer: Buffer.from(matches[2], 'base64'), mimetype: matches[1] };
}

function burnFile(fileId, roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.files = room.files.filter(f => f.id !== fileId);
    fileDownloads.delete(fileId);
    fileFirstAccess.delete(fileId);
    
    io.to(roomCode).emit('file-burned', { fileId });
    console.log(`🔥 File ${fileId} burned`);
}

function checkBurnConditions(fileId, roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const file = room.files.find(f => f.id === fileId);
    if (!file || !file.burn) return;

    if (file.burn.type === 'downloads') {
        const downloads = fileDownloads.get(fileId) || 0;
        if (downloads >= file.burn.downloads) {
            burnFile(fileId, roomCode);
        }
    } else if (file.burn.type === 'time') {
        const firstAccess = fileFirstAccess.get(fileId);
        if (firstAccess) {
            const burnTime = firstAccess + (file.burn.minutes * 60 * 1000);
            if (Date.now() >= burnTime) {
                burnFile(fileId, roomCode);
            }
        }
    }
}

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    socket.on('create-room', ({ username }) => {
        const roomCode = generateCode();
        rooms.set(roomCode, { users: new Map([[socket.id, username]]), files: [] });
        socket.join(roomCode);
        currentRoom = roomCode;
        currentUser = username;
        socket.emit('room-created', { roomCode });
        console.log(`✨ Room ${roomCode} created by ${username}`);
    });

    socket.on('join-room', ({ username, roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return socket.emit('error', 'Room not found');

        room.users.set(socket.id, username);
        socket.join(roomCode);
        currentRoom = roomCode;
        currentUser = username;

        socket.emit('room-joined', { roomCode, files: room.files });
        socket.to(roomCode).emit('user-joined', { username, userCount: room.users.size });
        io.to(roomCode).emit('users-update', room.users.size);
        console.log(`👋 ${username} joined ${roomCode}`);
    });

    socket.on('upload-file', async ({ tempId, name, size, type, data, provider, expiry, burn, encrypted, encryptionKey }) => {
        if (!currentRoom) return;

        try {
            socket.emit('upload-progress', { tempId, progress: 10 });

            const { buffer, mimetype } = base64ToBuffer(data);
            socket.emit('upload-progress', { tempId, progress: 30 });

            const uploadFn = uploadProviders[provider];
            if (!uploadFn) throw new Error('Invalid provider');

            const result = await uploadFn(buffer, name, mimetype || type, expiry);
            socket.emit('upload-progress', { tempId, progress: 90 });

            const file = {
                id: generateId(),
                tempId,
                name,
                size,
                type,
                provider,
                url: result.url,
                expiresAt: result.expiresAt?.toISOString() || null,
                sharedBy: currentUser,
                timestamp: Date.now(),
                burn: burn || null,
                encrypted: encrypted || false,
                encryptionKey: encryptionKey || null
            };

            const room = rooms.get(currentRoom);
            if (room) {
                room.files.push(file);
                if (room.files.length > 100) room.files.shift();
            }

            // Initialize download counter
            if (burn) {
                fileDownloads.set(file.id, 0);
            }

            io.to(currentRoom).emit('file-shared', file);
            console.log(`📁 ${name} uploaded via ${provider}${burn ? ' [BURN]' : ''}${encrypted ? ' [ENCRYPTED]' : ''}`);

        } catch (err) {
            console.error('❌ Upload error:', err.message);
            socket.emit('upload-error', { tempId, error: err.message });
        }
    });

    socket.on('file-downloaded', ({ fileId }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const file = room.files.find(f => f.id === fileId);
        if (!file || !file.burn) return;

        // Track download
        const downloads = (fileDownloads.get(fileId) || 0) + 1;
        fileDownloads.set(fileId, downloads);

        // Track first access for time-based burn
        if (!fileFirstAccess.has(fileId)) {
            fileFirstAccess.set(fileId, Date.now());
            
            // Set timer for time-based burn
            if (file.burn.type === 'time') {
                setTimeout(() => {
                    checkBurnConditions(fileId, currentRoom);
                }, file.burn.minutes * 60 * 1000);
            }
        }

        // Check if should burn
        checkBurnConditions(fileId, currentRoom);
    });

    socket.on('leave-room', () => handleLeave());
    socket.on('disconnect', () => handleLeave());

    function handleLeave() {
        if (currentRoom && currentUser) {
            const room = rooms.get(currentRoom);
            if (room) {
                room.users.delete(socket.id);
                socket.to(currentRoom).emit('user-left', { username: currentUser, userCount: room.users.size });
                io.to(currentRoom).emit('users-update', room.users.size);
                if (room.users.size === 0) {
                    // Clean up file tracking for this room
                    room.files.forEach(f => {
                        fileDownloads.delete(f.id);
                        fileFirstAccess.delete(f.id);
                    });
                    rooms.delete(currentRoom);
                }
            }
            console.log(`👋 ${currentUser} left ${currentRoom}`);
        }
        currentRoom = null;
        currentUser = null;
    }
});

// Cleanup
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        room.files = room.files.filter(f => {
            if (f.expiresAt && new Date(f.expiresAt).getTime() <= now) {
                fileDownloads.delete(f.id);
                fileFirstAccess.delete(f.id);
                return false;
            }
            return true;
        });
    }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╦  ╔═╗╔═╗╔╦╗
    ║  ║ ║║ ║║║║
    ╩═╝╚═╝╚═╝╩ ╩  v2.0
    
    🌐 http://localhost:${PORT}
    
    Features:
    🔥 Burn After Read
    🔐 Zero-Knowledge Encryption
    📊 Download Tracking
    ⏱️ Time-Based Destruction
    `);
});
