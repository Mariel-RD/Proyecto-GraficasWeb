const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const playersByRoom = new Map();

app.use(express.static(path.resolve(__dirname)));

app.get("/", (_req, res) => {
  res.redirect("/VENTANAS/menu_inicial/index.html");
});

function getRoomPlayers(room) {
  if (!playersByRoom.has(room)) {
    playersByRoom.set(room, new Map());
  }
  return playersByRoom.get(room);
}

function normalizeState(payload, socket) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const room = typeof payload.room === "string" && payload.room.trim()
    ? payload.room.trim()
    : "caribean-island-room";

  const playerId = typeof payload.playerId === "string" && payload.playerId.trim()
    ? payload.playerId.trim()
    : socket.id;

  const playerName = typeof payload.playerName === "string" && payload.playerName.trim()
    ? payload.playerName.trim().slice(0, 24)
    : "Jugador";

  const position = payload.position && typeof payload.position === "object"
    ? payload.position
    : {};

  const x = Number(position.x) || 0;
  const y = Number(position.y) || 0;
  const z = Number(position.z) || 0;
  const rotationY = Number(payload.rotationY) || 0;

  return {
    room,
    playerId,
    playerName,
    position: { x, y, z },
    rotationY,
    at: Date.now(),
    socketId: socket.id
  };
}

function removePlayerFromRoom(socket) {
  const { room, playerId } = socket.data || {};
  if (!room || !playerId) {
    return;
  }

  const roomPlayers = playersByRoom.get(room);
  if (!roomPlayers) {
    return;
  }

  roomPlayers.delete(playerId);
  socket.to(room).emit("player-left", { playerId });

  if (roomPlayers.size === 0) {
    playersByRoom.delete(room);
  }
}

io.on("connection", (socket) => {
  socket.on("join-player", (payload) => {
    const state = normalizeState(payload, socket);
    if (!state) {
      return;
    }

    const roomPlayers = getRoomPlayers(state.room);
    socket.join(state.room);

    socket.data.room = state.room;
    socket.data.playerId = state.playerId;

    roomPlayers.set(state.playerId, state);

    socket.emit("room-snapshot", Array.from(roomPlayers.values()));
    socket.to(state.room).emit("player-joined", state);
  });

  socket.on("player-state", (payload) => {
    const state = normalizeState(payload, socket);
    if (!state) {
      return;
    }

    const roomPlayers = getRoomPlayers(state.room);
    roomPlayers.set(state.playerId, state);

    socket.data.room = state.room;
    socket.data.playerId = state.playerId;

    socket.to(state.room).emit("player-state", state);
  });

  socket.on("leave-player", () => {
    removePlayerFromRoom(socket);
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor Socket.IO corriendo en http://localhost:${PORT}`);
});
