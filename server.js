const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

/* SERVE PUBLIC FOLDER */
app.use(express.static(path.join(__dirname, "public")));

/* ROOT ROUTE */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


const rooms = {};
const TURN_TIME = 45000;
const MAX_PLAYERS = 6;

/* ================== UTIL ================== */

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
          id: `${s}_${v}_${Math.random().toString(36).substr(2,9)}`
        });
      }
    }
  }

  deck.push({ suit:"🃏", value:"JOKER", id:"J1_"+Date.now() });
  deck.push({ suit:"🃏", value:"JOKER", id:"J2_"+Date.now()+1 });

  return shuffle(deck);
}

/* ================== GAME INIT ================== */

function initGame(players, roundNumber = 1) {

  const deck = generateDeck();
  const cutJoker = deck.pop();
  const discardPile = [deck.pop()];

  const gamePlayers = players.map(p => ({
    id: p.id,
    name: p.name,
    hand: [],
    hasDrawn: false,
    dropped: false,
    totalScore: p.totalScore || 0,
    eliminated: false,
    turnOrder: p.turnOrder || 0,
  }));

  gamePlayers.forEach(p => {
    for (let i = 0; i < 13; i++) {
      p.hand.push(deck.pop());
    }
  });

  const sorted = [...gamePlayers].sort((a,b)=>a.turnOrder-b.turnOrder);
  const firstIndex = (roundNumber-1)%sorted.length;
  const firstPlayer = sorted[firstIndex];

  return {
    deck,
    discardPile,
    cutJoker,
    players: gamePlayers,
    currentTurn: firstPlayer.id,
    roundNumber
  };
}

/* ================== TIMER ================== */

function startTimer(roomCode){
  const room = rooms[roomCode];
  if(!room) return;

  if(room.timer) clearTimeout(room.timer);

  const current = room.game.currentTurn;
  io.to(current).emit("timerStarted");

  room.timer = setTimeout(()=>{
    handleTimeout(roomCode,current);
  },TURN_TIME);
}

function stopTimer(roomCode){
  const room = rooms[roomCode];
  if(room && room.timer){
    clearTimeout(room.timer);
    room.timer=null;
  }
}

function handleTimeout(roomCode,playerId){
  const room = rooms[roomCode];
  if(!room) return;

  const game = room.game;
  const player = game.players.find(p=>p.id===playerId);
  if(!player || player.dropped || player.eliminated) return;

  // Auto Draw
  if(!player.hasDrawn && game.deck.length>0){
    player.hand.push(game.deck.pop());
    player.hasDrawn=true;
  }

  // Auto Discard
  if(player.hasDrawn && player.hand.length>0){
    game.discardPile.push(player.hand.pop());
    player.hasDrawn=false;
  }

  nextTurn(roomCode);
}

/* ================== TURN ================== */

function nextTurn(roomCode){

  const room = rooms[roomCode];
  const game = room.game;

  const active = game.players.filter(p=>!p.dropped && !p.eliminated);

  if(active.length<=1){
    endRound(roomCode);
    return;
  }

  const index = active.findIndex(p=>p.id===game.currentTurn);
  const nextIndex = (index+1)%active.length;

  game.currentTurn = active[nextIndex].id;
  active[nextIndex].hasDrawn=false;

  broadcastState(roomCode);
  startTimer(roomCode);
}

/* ================== VALIDATION ================== */

function getWildValue(cutJoker){
  const order=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const i=order.indexOf(cutJoker.value);
  return order[(i+1)%order.length];
}

function validateDeclaration(groups, ungrouped, cutJoker){

  if(!groups || groups.length<2) return false;
  if(ungrouped.length>1) return false;

  let pure=0;
  let sequences=0;

  for(let g of groups){
    const result=validateGroup(g,cutJoker);
    if(!result.valid) return false;

    if(result.type==="sequence"){
      sequences++;
      if(result.pure) pure++;
    }
  }

  return pure>=1 && sequences>=2;
}

function validateGroup(cards,cutJoker){

  if(cards.length<3) return {valid:false};

  const set=checkSet(cards,cutJoker);
  if(set.valid) return {valid:true,type:"set",pure:set.pure};

  const seq=checkSequence(cards,cutJoker);
  if(seq.valid) return {valid:true,type:"sequence",pure:seq.pure};

  return {valid:false};
}

function checkSet(cards,cutJoker){

  const wild=getWildValue(cutJoker);
  let joker=false;

  const normal=cards.filter(c=>{
    const isJ=c.value==="JOKER"||c.value===wild;
    if(isJ) joker=true;
    return !isJ;
  });

  if(normal.length===0) return {valid:false};

  const val=normal[0].value;
  if(!normal.every(c=>c.value===val)) return {valid:false};

  const suits=new Set(normal.map(c=>c.suit));
  if(suits.size!==normal.length) return {valid:false};

  return {valid:true,pure:!joker};
}

function checkSequence(cards,cutJoker){

  const order=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const wild=getWildValue(cutJoker);
  let joker=false;

  const normal=cards.filter(c=>{
    const isJ=c.value==="JOKER"||c.value===wild;
    if(isJ) joker=true;
    return !isJ;
  });

  if(normal.length===0) return {valid:false};

  const suit=normal[0].suit;
  if(!normal.every(c=>c.suit===suit)) return {valid:false};

  const sorted=normal.sort(
    (a,b)=>order.indexOf(a.value)-order.indexOf(b.value)
  );

  let jokerCount=cards.length-normal.length;

  for(let i=0;i<sorted.length-1;i++){
    const gap=
      order.indexOf(sorted[i+1].value)-
      order.indexOf(sorted[i].value)-1;

    if(gap>jokerCount) return {valid:false};
    jokerCount-=gap;
  }

  return {valid:true,pure:!joker};
}

/* ================== ROUND ================== */

function endRound(roomCode){

  const room=rooms[roomCode];
  const game=room.game;

  const active=game.players.filter(p=>p.totalScore<250);

  if(active.length<=1){
    io.to(roomCode).emit("gameWon",{winner:active[0]?.name||"No one"});
    return;
  }

  const nextRound=game.roundNumber+1;

  const carry=active.map(p=>({
    id:p.id,
    name:p.name,
    totalScore:p.totalScore,
    turnOrder:p.turnOrder
  }));

  room.game=initGame(carry,nextRound);
  broadcastState(roomCode);
  startTimer(roomCode);
}

/* ================== STATE ================== */

function publicState(game,id){
  return{
    discardPile:game.discardPile,
    cutJoker:game.cutJoker,
    currentTurn:game.currentTurn,
    players:game.players.map(p=>({
      id:p.id,
      name:p.name,
      cardCount:p.hand.length,
      totalScore:p.totalScore
    })),
    hand:game.players.find(p=>p.id===id)?.hand||[],
    hasDrawn:game.players.find(p=>p.id===id)?.hasDrawn
  };
}

function broadcastState(roomCode){
  const room=rooms[roomCode];
  room.players.forEach(p=>{
    io.to(p.id).emit("gameState",
      publicState(room.game,p.id)
    );
  });
}

/* ================== SOCKET ================== */

io.on("connection",socket=>{

  socket.on("createRoom",data=>{
    const code=generateRoomCode();
    rooms[code]={
      code,
      host:socket.id,
      players:[{id:socket.id,name:data.playerName,turnOrder:0}],
      game:null
    };
    socket.join(code);
    socket.emit("roomCreated",{roomCode:code});
  });

  socket.on("joinRoom",data=>{
    const room=rooms[data.roomCode];
    if(!room) return socket.emit("error","Room not found");
    if(room.players.length>=MAX_PLAYERS)
      return socket.emit("error","Room full");

    room.players.push({
      id:socket.id,
      name:data.playerName,
      turnOrder:room.players.length
    });

    socket.join(data.roomCode);
    io.to(data.roomCode).emit("roomUpdate",room);
  });

  socket.on("startGame",data=>{
    const room=rooms[data.roomCode];
    if(!room||room.players.length<2) return;

    room.game=initGame(room.players,1);
    broadcastState(data.roomCode);
    startTimer(data.roomCode);
  });

  socket.on("drawCard",data=>{
    const room=rooms[data.roomCode];
    if(!room?.game) return;

    const game=room.game;
    const player=game.players.find(p=>p.id===socket.id);

    if(!player||game.currentTurn!==socket.id||player.hasDrawn) return;

    const card=
      data.source==="deck"
      ? game.deck.pop()
      : game.discardPile.pop();

    if(!card) return;

    player.hand.push(card);
    player.hasDrawn=true;

    broadcastState(data.roomCode);
  });

  socket.on("discardCard",data=>{
    const room=rooms[data.roomCode];
    if(!room?.game) return;

    const game=room.game;
    const player=game.players.find(p=>p.id===socket.id);
    if(!player||!player.hasDrawn) return;

    const index=player.hand.findIndex(c=>c.id===data.cardId);
    if(index===-1) return;

    game.discardPile.push(player.hand.splice(index,1)[0]);
    player.hasDrawn=false;

    stopTimer(data.roomCode);
    nextTurn(data.roomCode);
  });

  socket.on("declareWin",data=>{
    const room=rooms[data.roomCode];
    if(!room?.game) return;

    const game=room.game;
    const player=game.players.find(p=>p.id===socket.id);

    const valid=validateDeclaration(
      data.groups,
      data.ungrouped,
      game.cutJoker
    );

    stopTimer(data.roomCode);

    if(valid){
      io.to(data.roomCode).emit("roundWon",{winner:player.name});
      setTimeout(()=>endRound(data.roomCode),3000);
    }else{
      player.totalScore+=80;
      io.to(data.roomCode).emit("wrongShow",{player:player.name});
      setTimeout(()=>endRound(data.roomCode),3000);
    }
  });

});

/* ================== START ================== */

const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log("Server running on "+PORT));
