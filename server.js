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
const stealCooldownsByPlayer = new Map();

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
    Array.from(stealCooldownsByPlayer.keys()).forEach((key) => {
      if (key.startsWith(`${room}:`)) {
        stealCooldownsByPlayer.delete(key);
      }
    });
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

function normalizeStealRequest(payload, socket) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const room = typeof payload.room === "string" && payload.room.trim()
    ? payload.room.trim()
    : socket.data.room || "caribean-island-room";

  const thiefId = typeof payload.thiefId === "string" && payload.thiefId.trim()
    ? payload.thiefId.trim()
    : socket.data.playerId || socket.id;

  const targetId = typeof payload.targetId === "string" && payload.targetId.trim()
    ? payload.targetId.trim()
    : "";

  if (!targetId || targetId === thiefId) {
    return null;
  }

  return { room, thiefId, targetId };
}

function getDistanceBetweenPlayers(room, playerAId, playerBId) {
  const roomPlayers = playersByRoom.get(room);
  if (!roomPlayers) {
    return Infinity;
  }

  const playerA = roomPlayers.get(playerAId);
  const playerB = roomPlayers.get(playerBId);
  if (!playerA || !playerB) {
    return Infinity;
  }

  const dx = playerA.position.x - playerB.position.x;
  const dy = playerA.position.y - playerB.position.y;
  const dz = playerA.position.z - playerB.position.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

  socket.on("steal-coin", (payload) => {
    const steal = normalizeStealRequest(payload, socket);
    if (!steal) {
      return;
    }

    if (getDistanceBetweenPlayers(steal.room, steal.thiefId, steal.targetId) > 4) {
      socket.emit("steal-failed", { reason: "too-far" });
      return;
    }

    const cooldownKey = `${steal.room}:${steal.thiefId}`;
    const now = Date.now();
    if (now - (stealCooldownsByPlayer.get(cooldownKey) || 0) < 700) {
      return;
    }
    stealCooldownsByPlayer.set(cooldownKey, now);

    const roomCoinCounts = getRoomCoinCounts(steal.room);
    const targetCoins = roomCoinCounts.get(steal.targetId) || 0;
    if (targetCoins <= 0) {
      socket.emit("steal-failed", { reason: "no-coins" });
      return;
    }

    roomCoinCounts.set(steal.targetId, targetCoins - 1);
    roomCoinCounts.set(steal.thiefId, (roomCoinCounts.get(steal.thiefId) || 0) + 1);

    io.to(steal.room).emit("coin-stolen", {
      thiefId: steal.thiefId,
      targetId: steal.targetId,
      coinCounts: serializeCoinCounts(steal.room)
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
