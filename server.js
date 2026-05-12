const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TIMER_SECONDS = 60;
const playersByRoom = new Map();
const collectedCoinsByRoom = new Map();
const coinCountsByRoom = new Map();
const timersByRoom = new Map();

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

function getRoomCollectedCoins(room) {
  if (!collectedCoinsByRoom.has(room)) {
    collectedCoinsByRoom.set(room, new Set());
  }
  return collectedCoinsByRoom.get(room);
}

function getRoomCoinCounts(room) {
  if (!coinCountsByRoom.has(room)) {
    coinCountsByRoom.set(room, new Map());
  }
  return coinCountsByRoom.get(room);
}

function getRoomTimer(room) {
  if (!timersByRoom.has(room)) {
    timersByRoom.set(room, {
      startedAt: Date.now(),
      durationSeconds: ROOM_TIMER_SECONDS
    });
  }
  return timersByRoom.get(room);
}

function resetRoomTimer(room) {
  const timer = {
    startedAt: Date.now(),
    durationSeconds: ROOM_TIMER_SECONDS
  };
  timersByRoom.set(room, timer);
  return timer;
}

function serializeCoinCounts(room) {
  return Object.fromEntries(getRoomCoinCounts(room));
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
    collectedCoinsByRoom.delete(room);
    coinCountsByRoom.delete(room);
    timersByRoom.delete(room);
  }
}

function normalizeCoinCollection(payload, socket) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const room = typeof payload.room === "string" && payload.room.trim()
    ? payload.room.trim()
    : socket.data.room || "caribean-island-room";

  const playerId = typeof payload.playerId === "string" && payload.playerId.trim()
    ? payload.playerId.trim()
    : socket.data.playerId || socket.id;

  const coinId = typeof payload.coinId === "string" && payload.coinId.trim()
    ? payload.coinId.trim()
    : "";

  if (!coinId) {
    return null;
  }

  return { room, playerId, coinId };
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
    if (!getRoomCoinCounts(state.room).has(state.playerId)) {
      getRoomCoinCounts(state.room).set(state.playerId, 0);
    }

    socket.emit("room-snapshot", {
      players: Array.from(roomPlayers.values()),
      collectedCoinIds: Array.from(getRoomCollectedCoins(state.room)),
      coinCounts: serializeCoinCounts(state.room),
      timer: {
        ...getRoomTimer(state.room),
        serverNow: Date.now()
      }
    });
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

  socket.on("coin-collected", (payload) => {
    const collection = normalizeCoinCollection(payload, socket);
    if (!collection) {
      return;
    }

    const roomCollectedCoins = getRoomCollectedCoins(collection.room);
    if (roomCollectedCoins.has(collection.coinId)) {
      return;
    }

    roomCollectedCoins.add(collection.coinId);
    const roomCoinCounts = getRoomCoinCounts(collection.room);
    roomCoinCounts.set(collection.playerId, (roomCoinCounts.get(collection.playerId) || 0) + 1);

    io.to(collection.room).emit("coin-collected", {
      ...collection,
      coinCounts: serializeCoinCounts(collection.room)
    });
  });

  socket.on("restart-game", (payload) => {
    const room = payload && typeof payload.room === "string" && payload.room.trim()
      ? payload.room.trim()
      : socket.data.room || "caribean-island-room";

    collectedCoinsByRoom.delete(room);
    coinCountsByRoom.delete(room);
    const timer = resetRoomTimer(room);

    io.to(room).emit("game-restarted", {
      timer: {
        ...timer,
        serverNow: Date.now()
      }
    });
  });

  socket.on("disconnect", () => {
    removePlayerFromRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor Socket.IO corriendo en http://localhost:${PORT}`);
});
