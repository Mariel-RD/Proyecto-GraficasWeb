const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function loadEnvFile() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TIMER_SECONDS = 60;
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "coin_thieves"
};
const LOCAL_DATA_PATH = path.resolve(__dirname, "data", "game-db.json");
const playersByRoom = new Map();
const collectedCoinsByRoom = new Map();
const coinCountsByRoom = new Map();
const timersByRoom = new Map();
const stealCooldownsByPlayer = new Map();
let dbPool;
let storageMode = "mysql";

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.resolve(__dirname)));

app.get("/", (_req, res) => {
  res.redirect("/VENTANAS/menu_inicial/index.html");
});

function cleanText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function getPlayerId(value) {
  return cleanText(value, `player-${Date.now()}`, 80);
}

async function initializeMysqlDatabase() {
  const setupConnection = await mysql.createConnection({
    host: MYSQL_CONFIG.host,
    port: MYSQL_CONFIG.port,
    user: MYSQL_CONFIG.user,
    password: MYSQL_CONFIG.password,
    multipleStatements: true
  });

  await setupConnection.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await setupConnection.end();

  dbPool = mysql.createPool({
    ...MYSQL_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      player_id VARCHAR(80) NOT NULL,
      player_name VARCHAR(24) NOT NULL,
      scenario VARCHAR(32) NOT NULL,
      mode VARCHAR(16) NOT NULL,
      result VARCHAR(32) NOT NULL,
      score INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_scores_player (player_id),
      INDEX idx_scores_score_created (score DESC, created_at DESC),
      INDEX idx_scores_player_score (player_id, score DESC),
      CONSTRAINT fk_scores_player FOREIGN KEY (player_id)
        REFERENCES players(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pruneDuplicateScoreRows();
  await ensureSingleScorePerPlayer();
}

async function pruneDuplicateScoreRows() {
  await dbPool.query(`
    DELETE score_to_delete
    FROM scores score_to_delete
    JOIN scores score_to_keep
      ON score_to_keep.player_id = score_to_delete.player_id
      AND (
        score_to_keep.score > score_to_delete.score
        OR (score_to_keep.score = score_to_delete.score AND score_to_keep.created_at > score_to_delete.created_at)
        OR (score_to_keep.score = score_to_delete.score AND score_to_keep.created_at = score_to_delete.created_at AND score_to_keep.id > score_to_delete.id)
      )
  `);
}

async function ensureSingleScorePerPlayer() {
  try {
    await dbPool.query("ALTER TABLE scores ADD UNIQUE KEY uq_scores_player (player_id)");
  } catch (error) {
    if (error.code !== "ER_DUP_KEYNAME" && error.errno !== 1061) {
      throw error;
    }
  }
}

function createEmptyLocalStore() {
  return {
    players: {},
    scores: []
  };
}

async function readLocalStore() {
  try {
    const store = JSON.parse(await fs.promises.readFile(LOCAL_DATA_PATH, "utf8"));
    return {
      players: store && typeof store.players === "object" && !Array.isArray(store.players)
        ? store.players
        : {},
      scores: Array.isArray(store && store.scores) ? store.scores : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return createEmptyLocalStore();
    }
    throw error;
  }
}

async function writeLocalStore(store) {
  await fs.promises.mkdir(path.dirname(LOCAL_DATA_PATH), { recursive: true });
  await fs.promises.writeFile(LOCAL_DATA_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

async function initializeLocalDatabase() {
  storageMode = "local";
  const store = await readLocalStore();
  await writeLocalStore(store);
}

async function initializeDatabase() {
  try {
    await initializeMysqlDatabase();
    storageMode = "mysql";
  } catch (error) {
    console.warn("No se pudo conectar a MySQL; se usara almacenamiento local en data/game-db.json.");
    console.warn("Para usar MySQL, inicia el servicio y revisa MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD y MYSQL_DATABASE.");
    console.warn(error.message);
    await initializeLocalDatabase();
  }
}

function normalizeScoreRow(row) {
  return {
    id: String(row.id),
    playerId: row.player_id,
    playerName: row.player_name,
    scenario: row.scenario,
    mode: row.mode,
    result: row.result,
    score: Number(row.score) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

function normalizeLocalScore(score) {
  return {
    id: String(score.id),
    playerId: score.playerId,
    playerName: score.playerName,
    scenario: score.scenario,
    mode: score.mode,
    result: score.result,
    score: Number(score.score) || 0,
    createdAt: score.createdAt
  };
}

function compareScores(a, b) {
  return (Number(b.score) || 0) - (Number(a.score) || 0)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function getBestLocalScores(scores) {
  const bestScoresByPlayer = new Map();
  scores.forEach((score) => {
    const currentBest = bestScoresByPlayer.get(score.playerId);
    if (!currentBest || compareScores(currentBest, score) > 0) {
      bestScoresByPlayer.set(score.playerId, score);
    }
  });

  return Array.from(bestScoresByPlayer.values());
}

async function savePlayerProfile(playerId, playerName) {
  const id = getPlayerId(playerId);
  const name = cleanText(playerName, "Jugador", 24);

  if (storageMode === "local") {
    const store = await readLocalStore();
    const now = new Date().toISOString();
    const current = store.players[id] || {};

    store.players[id] = {
      id,
      name,
      createdAt: current.createdAt || now,
      updatedAt: now
    };
    await writeLocalStore(store);
    return store.players[id];
  }

  await dbPool.execute(`
    INSERT INTO players (id, name)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      updated_at = CURRENT_TIMESTAMP
  `, [id, name]);

  const [rows] = await dbPool.execute(
    "SELECT id, name, created_at, updated_at FROM players WHERE id = ?",
    [id]
  );

  return {
    id: rows[0].id,
    name: rows[0].name,
    createdAt: rows[0].created_at instanceof Date ? rows[0].created_at.toISOString() : rows[0].created_at,
    updatedAt: rows[0].updated_at instanceof Date ? rows[0].updated_at.toISOString() : rows[0].updated_at
  };
}

async function getRanking(period, limit) {
  if (storageMode === "local") {
    const store = await readLocalStore();
    const minTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
    return getBestLocalScores(store.scores)
      .filter((score) => period !== "semanal" || new Date(score.createdAt).getTime() >= minTime)
      .sort(compareScores)
      .slice(0, limit)
      .map(normalizeLocalScore);
  }

  const periodFilter = period === "semanal"
    ? "AND s.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
    : "";
  const periodFilterForOther = period === "semanal"
    ? "AND other_scores.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
    : "";
  const [rows] = await dbPool.query(`
    SELECT s.id, s.player_id, s.player_name, s.scenario, s.mode, s.result, s.score, s.created_at
    FROM scores s
    WHERE NOT EXISTS (
      SELECT 1
      FROM scores other_scores
      WHERE other_scores.player_id = s.player_id
        ${periodFilterForOther}
        AND (
          other_scores.score > s.score
          OR (other_scores.score = s.score AND other_scores.created_at > s.created_at)
          OR (other_scores.score = s.score AND other_scores.created_at = s.created_at AND other_scores.id > s.id)
        )
    )
    ${periodFilter}
    ORDER BY s.score DESC, s.created_at DESC
    LIMIT ?
  `, [limit]);

  return rows.map(normalizeScoreRow);
}

async function getBestScoreForPlayer(playerId) {
  const id = getPlayerId(playerId);

  if (storageMode === "local") {
    const store = await readLocalStore();
    return store.scores
      .filter((score) => score.playerId === id)
      .sort(compareScores)
      .map(normalizeLocalScore)[0] || null;
  }

  const [rows] = await dbPool.execute(`
    SELECT id, player_id, player_name, scenario, mode, result, score, created_at
    FROM scores
    WHERE player_id = ?
    ORDER BY score DESC, created_at DESC
    LIMIT 1
  `, [id]);

  return rows[0] ? normalizeScoreRow(rows[0]) : null;
}

async function saveScoreRecord(playerId, playerName, scenario, mode, result, score) {
  if (storageMode === "local") {
    const store = await readLocalStore();
    const now = new Date().toISOString();
    let record = store.scores
      .filter((localScore) => localScore.playerId === playerId)
      .sort(compareScores)[0];

    if (record) {
      record.playerName = playerName;
      if (score >= (Number(record.score) || 0)) {
        record.scenario = scenario;
        record.mode = mode;
        record.result = result;
        record.score = score;
        record.createdAt = now;
      }
      store.scores = store.scores.filter((localScore) => localScore.playerId !== playerId || localScore.id === record.id);
    } else {
      record = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        playerId,
        playerName,
        scenario,
        mode,
        result,
        score,
        createdAt: now
      };
      store.scores.push(record);
    }

    await writeLocalStore(store);
    return normalizeLocalScore(record);
  }

  let currentBest = await getBestScoreForPlayer(playerId);
  if (currentBest) {
    if (score >= currentBest.score) {
      await dbPool.execute(`
        UPDATE scores
        SET player_name = ?, scenario = ?, mode = ?, result = ?, score = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [playerName, scenario, mode, result, score, currentBest.id]);
    } else {
      await dbPool.execute("UPDATE scores SET player_name = ? WHERE id = ?", [playerName, currentBest.id]);
    }
    await dbPool.execute("DELETE FROM scores WHERE player_id = ? AND id <> ?", [playerId, currentBest.id]);
  } else {
    const [insertResult] = await dbPool.execute(`
      INSERT INTO scores (player_id, player_name, scenario, mode, result, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [playerId, playerName, scenario, mode, result, score]);
    currentBest = { id: String(insertResult.insertId) };
  }

  const [rows] = await dbPool.execute(`
    SELECT id, player_id, player_name, scenario, mode, result, score, created_at
    FROM scores
    WHERE id = ?
  `, [currentBest.id]);

  return normalizeScoreRow(rows[0]);
}

app.post("/api/player", async (req, res, next) => {
  try {
    const profile = await savePlayerProfile(req.body && req.body.playerId, req.body && req.body.name);
    res.json({ ok: true, player: profile });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scores", async (req, res, next) => {
  try {
    const body = req.body || {};
    const playerId = getPlayerId(body.playerId);
    const playerName = cleanText(body.playerName, "Jugador", 24);
    const scenario = cleanText(body.scenario, "Escenario", 32);
    const mode = cleanText(body.mode, "Juego", 16);
    const result = cleanText(body.result, "Juego terminado", 32);
    const score = Math.max(0, Math.floor(Number(body.score) || 0));
    const profile = await savePlayerProfile(playerId, playerName);
    const record = await saveScoreRecord(playerId, profile.name, scenario, mode, result, score);

    res.status(201).json({
      ok: true,
      score: record,
      bestScore: await getBestScoreForPlayer(playerId),
      ranking: await getRanking("global", 10)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scores", async (req, res, next) => {
  try {
    const period = req.query.period === "semanal" ? "semanal" : "global";
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));
    const playerId = req.query.playerId ? getPlayerId(req.query.playerId) : "";

    res.json({
      ok: true,
      period,
      ranking: await getRanking(period, limit),
      playerBest: playerId ? await getBestScoreForPlayer(playerId) : null
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Error en API:", error);
  res.status(500).json({
    ok: false,
    error: "Error de base de datos"
  });
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

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(storageMode === "mysql"
        ? `Base MySQL lista: ${MYSQL_CONFIG.database}`
        : `Almacenamiento local listo: ${LOCAL_DATA_PATH}`);
      console.log(`Servidor Socket.IO corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("No se pudo conectar a MySQL.");
    console.error("Revisa MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD y MYSQL_DATABASE.");
    console.error(error);
    process.exit(1);
  });
