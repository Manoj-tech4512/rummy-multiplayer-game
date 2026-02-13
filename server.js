const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const TURN_TIME = 45000;
const MAX_PLAYERS = 6;

/* ================= DECK ================= */

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function generateDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const values = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];

  for (let d = 0; d < 2; d++) {
    for (let s of suits) {
      for (let v of values) {
        deck.push({
          suit: s,
          value: v,
          id: s + "_" + v + "_" + Math.random().toString(36).substr(2,9)
        });
      }
    }
  }

  deck.push({ suit:"🃏", value:"JOKER", id:"J1_"+Date.now() });
  deck.push({ suit:"🃏", value:"JOKER", id:"J2_"+Date.now()+1 });

  return shuffle(deck);
}

/* ================= GAME INIT ================= */

function initGame(players) {
  const deck = generateDeck();
  const discardPile = [deck.pop()];
  const cutJoker = deck.pop();

  const gamePlayers = players.map(p => ({
    id: p.id,
    name: p.name,
    hand: [],
    hasDrawn: false,
    totalScore: p.totalScore || 0,
    eliminated: false
  }));

  gamePlayers.forEach(p => {
    for (let i = 0; i < 13; i++) {
      p.hand.push(deck.pop());
    }
  });

  return {
    deck,
    discardPile,
    cutJoker,
    players: gamePlayers,
    currentTurn: gamePlayers[0].id
  };
}

/* ================= STATE ================= */

function publicState(game, id) {
  return {
    discardPile: game.discardPile,
    cutJoker: game.cutJoker,
    currentTurn: game.currentTurn,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      totalScore: p.totalScore
    })),
    hand: game.players.find(p => p.id === id)?.hand || []
  };
}

function broadcast(roomCode) {
  const room = rooms[roomCode];
  room.players.forEach(p => {
    io.to(p.id).emit("gameState",
      publicState(room.game, p.id)
    );
  });
}

/* ================= TURN ================= */

function nextTurn(roomCode) {
  const room = rooms[roomCode];
  const game = room.game;

  const index = game.players.findIndex(p => p.id === game.currentTurn);
  const next = (index + 1) % game.players.length;

  game.currentTurn = game.players[next].id;
  game.players[next].hasDrawn = false;

  broadcast(roomCode);
}

/* ================= SOCKET ================= */

io.on("connection", socket => {

  socket.on("createRoom", data => {
    const code = Math.random().toString(36).substr(2,6).toUpperCase();
    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: data.playerName }],
      game: null
    };
    socket.join(code);
    socket.emit("roomCreated", { roomCode: code });
  });

  socket.on("joinRoom", data => {
    const room = rooms[data.roomCode];
    if (!room) return socket.emit("error", "Room not found");
    if (room.players.length >= MAX_PLAYERS)
      return socket.emit("error", "Room full");

    room.players.push({
      id: socket.id,
      name: data.playerName
    });

    socket.join(data.roomCode);
    io.to(data.roomCode).emit("roomUpdate", room);
    socket.emit("roomJoined", { roomCode: data.roomCode });
  });

  socket.on("startGame", data => {
    const room = rooms[data.roomCode];
    if (!room || room.players.length < 2) return;

    room.game = initGame(room.players);
    broadcast(data.roomCode);
  });

  socket.on("drawCard", data => {
    const room = rooms[data.roomCode];
    if (!room?.game) return;

    const game = room.game;
    const player = game.players.find(p => p.id === socket.id);

    if (!player || game.currentTurn !== socket.id) return;

    const card =
      data.source === "deck"
        ? game.deck.pop()
        : game.discardPile.pop();

    if (!card) return;

    player.hand.push(card);
    player.hasDrawn = true;

    broadcast(data.roomCode);
  });

  socket.on("discardCard", data => {
    const room = rooms[data.roomCode];
    if (!room?.game) return;

    const game = room.game;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.hasDrawn) return;

    const index = player.hand.findIndex(c => c.id === data.cardId);
    if (index === -1) return;

    game.discardPile.push(player.hand.splice(index,1)[0]);
    player.hasDrawn = false;

    nextTurn(data.roomCode);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on " + PORT));

