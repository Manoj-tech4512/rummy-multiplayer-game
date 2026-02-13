const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const rooms = {};
const turnTimers = {};

/* ---------------- ROOM CODE ---------------- */

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* ---------------- DECK ---------------- */

function generateDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const deck = [];

    for (let d = 0; d < 2; d++) {
        for (let suit of suits) {
            for (let value of values) {
                deck.push({
                    suit,
                    value,
                    id: `${suit}_${value}_${Math.random().toString(36).substr(2,9)}`
                });
            }
        }
    }

    deck.push({ suit:'🃏', value:'JOKER', id:'joker1_'+Date.now() });
    deck.push({ suit:'🃏', value:'JOKER', id:'joker2_'+Date.now() });

    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/* ---------------- GAME INIT ---------------- */

function initializeGame(players) {
    const deck = generateDeck();
    const cutJoker = deck.pop();
    const discardPile = [deck.pop()];

    const gamePlayers = players.map(p => ({
        id: p.id,
        name: p.name,
        hand: [],
        hasDrawn:false,
        dropped:false,
        totalScore: p.totalScore || 0,
        eliminated:false
    }));

    gamePlayers.forEach(player => {
        for (let i = 0; i < 13; i++) {
            player.hand.push(deck.pop());
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

/* ---------------- INDIAN RUMMY VALIDATION ---------------- */

function validateDeclaration(groups, ungrouped, cutJoker) {

    if (!groups || groups.length < 2)
        return { valid:false, reason:'Need minimum 2 sequences' };

    if (ungrouped.length > 1)
        return { valid:false, reason:'Only 1 ungrouped card allowed' };

    let pureSeq = 0;
    let totalSeq = 0;

    for (let group of groups) {

        const result = validateGroup(group, cutJoker);
        if (!result.valid)
            return { valid:false, reason:result.reason };

        if (result.type === 'sequence') {
            totalSeq++;
            if (result.pure) pureSeq++;
        }
    }

    if (pureSeq < 1)
        return { valid:false, reason:'Need at least 1 pure sequence' };

    if (totalSeq < 2)
        return { valid:false, reason:'Need 2 sequences' };

    return { valid:true };
}

function validateGroup(cards, cutJoker) {
    if (cards.length < 3)
        return { valid:false, reason:'Minimum 3 cards' };

    const setCheck = checkSet(cards, cutJoker);
    if (setCheck.valid)
        return { valid:true, type:'set', pure:setCheck.pure };

    const seqCheck = checkSequence(cards, cutJoker);
    if (seqCheck.valid)
        return { valid:true, type:'sequence', pure:seqCheck.pure };

    return { valid:false, reason:'Invalid group' };
}

function checkSet(cards, cutJoker) {

    const wild = getWildValue(cutJoker);
    let hasJoker = false;

    const normal = cards.filter(c => {
        const joker = c.value === 'JOKER' || c.value === wild;
        if (joker) hasJoker = true;
        return !joker;
    });

    if (normal.length === 0) return { valid:false };

    const val = normal[0].value;
    if (!normal.every(c => c.value === val))
        return { valid:false };

    const suits = new Set(normal.map(c => c.suit));
    if (suits.size !== normal.length)
        return { valid:false };

    return { valid:true, pure:!hasJoker };
}

function checkSequence(cards, cutJoker) {

    const order = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const wild = getWildValue(cutJoker);

    let hasJoker = false;

    const normal = cards.filter(c => {
        const joker = c.value === 'JOKER' || c.value === wild;
        if (joker) hasJoker = true;
        return !joker;
    });

    if (normal.length === 0) return { valid:false };

    const suit = normal[0].suit;
    if (!normal.every(c => c.suit === suit))
        return { valid:false };

    const sorted = normal.sort(
        (a,b)=> order.indexOf(a.value)-order.indexOf(b.value)
    );

    let jokerCount = cards.length - normal.length;

    for (let i = 0; i < sorted.length-1; i++) {
        const gap =
            order.indexOf(sorted[i+1].value) -
            order.indexOf(sorted[i].value) - 1;

        if (gap > jokerCount)
            return { valid:false };

        jokerCount -= gap;
    }

    return { valid:true, pure:!hasJoker };
}

function getWildValue(cutJoker) {
    const order = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const index = order.indexOf(cutJoker.value);
    return order[(index+1)%order.length];
}

/* ---------------- SOCKET EVENTS ---------------- */

io.on('connection', socket => {

    socket.on('createRoom', data => {
        const code = generateRoomCode();
        rooms[code] = {
            code,
            host: socket.id,
            players: [{ id:socket.id, name:data.playerName }],
            gameState:null
        };
        socket.join(code);
        socket.emit('roomCreated',{ roomCode:code, room:rooms[code] });
    });

    socket.on('joinRoom', data => {
        const room = rooms[data.roomCode];
        if (!room) return socket.emit('error','Room not found');

        room.players.push({ id:socket.id, name:data.playerName });
        socket.join(data.roomCode);
        socket.emit('roomJoined',{ roomCode:data.roomCode, room });
        io.to(data.roomCode).emit('roomUpdate',room);
    });

    socket.on('startGame', data => {
        const room = rooms[data.roomCode];
        room.gameState = initializeGame(room.players);

        room.players.forEach(p=>{
            io.to(p.id).emit('gameStarted',
                getPublic(room.gameState,p.id));
        });
    });

    socket.on('drawCard', data=>{
        const room = rooms[data.roomCode];
        const game = room.gameState;
        const player = game.players.find(p=>p.id===socket.id);

        if (!player || game.currentTurn!==socket.id || player.hasDrawn)
            return;

        const card = data.source==='deck'
            ? game.deck.pop()
            : game.discardPile.pop();

        player.hand.push(card);
        player.hasDrawn=true;

        updateAll(room);
    });

    /* -------- FIXED DISCARD (BY CARD ID) -------- */

    socket.on('discardCard', data=>{
        const room = rooms[data.roomCode];
        const game = room.gameState;
        const player = game.players.find(p=>p.id===socket.id);

        if (!player || !player.hasDrawn)
            return;

        const index = player.hand.findIndex(c=>c.id===data.cardId);
        if (index===-1) return;

        game.discardPile.push(player.hand.splice(index,1)[0]);
        player.hasDrawn=false;

        nextTurn(game);
        updateAll(room);
    });

    socket.on('declareWin', data=>{
        const room = rooms[data.roomCode];
        const game = room.gameState;
        const player = game.players.find(p=>p.id===socket.id);

        const result = validateDeclaration(
            data.groups,
            data.ungrouped,
            game.cutJoker
        );

        if (result.valid) {
            io.to(data.roomCode).emit('roundWon',{
                winner:player.name,
                reason:'Valid Show!'
            });
        } else {
            player.totalScore += 80;
            io.to(data.roomCode).emit('wrongShow',{
                player:player.name,
                reason:result.reason
            });
        }

        updateAll(room);
    });

});

/* ---------------- HELPERS ---------------- */

function getPublic(game,id){
    return {
        discardPile:game.discardPile,
        cutJoker:game.cutJoker,
        players:game.players.map(p=>({
            id:p.id,
            name:p.name,
            cardCount:p.hand.length,
            totalScore:p.totalScore
        })),
        currentTurn:game.currentTurn,
        hand:game.players.find(p=>p.id===id).hand,
        hasDrawn:game.players.find(p=>p.id===id).hasDrawn
    };
}

function updateAll(room){
    room.players.forEach(p=>{
        io.to(p.id).emit('gameState',
            getPublic(room.gameState,p.id));
    });
}

function nextTurn(game){
    const idx = game.players.findIndex(p=>p.id===game.currentTurn);
    const next = (idx+1)%game.players.length;
    game.currentTurn = game.players[next].id;
}

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log("Server running"));
