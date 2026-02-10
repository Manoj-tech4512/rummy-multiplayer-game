const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};
const turnTimers = {};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];
    for (let d = 0; d < 2; d++) {
        for (let suit of suits) {
            for (let value of values) {
                deck.push({ suit, value });
            }
        }
    }
    deck.push({ suit: '🃏', value: 'JOKER' });
    deck.push({ suit: '🃏', value: 'JOKER' });
    return shuffleDeck(deck);
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function initializeGame(players) {
    const deck = generateDeck();
    const cutJoker = deck.pop();
    const discardPile = [deck.pop()];
    
    const gamePlayers = players.map(p => ({
        id: p.id,
        name: p.name,
        hand: [],
        cardCount: 13,
        hasDrawn: false,
        dropped: false,
        dropPoints: 0,
        totalScore: 0,
        eliminated: false,
        consecutiveTimeouts: 0,
        totalTimeouts: 0
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
        currentTurn: gamePlayers[0].id,
        deckCount: deck.length,
        isFirstRound: true
    };
}

function getPublicGameState(gameState, playerId) {
    const player = gameState.players.find(p => p.id === playerId);
    const hasDrawnCard = player ? player.hasDrawn : false;
    
    return {
        deck: [],
        discardPile: gameState.discardPile,
        cutJoker: gameState.cutJoker,
        players: gameState.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand.length,
            dropped: p.dropped,
            eliminated: p.eliminated,
            dropPoints: p.dropPoints,
            totalScore: p.totalScore,
            totalTimeouts: p.totalTimeouts || 0,
            hand: p.id === playerId ? p.hand : []
        })),
        currentTurn: gameState.currentTurn,
        deckCount: gameState.deck.length,
        hand: gameState.players.find(p => p.id === playerId)?.hand || [],
        hasDrawn: hasDrawnCard
    };
}

function validateDeclaration(groups, ungrouped, cutJoker) {
    if (ungrouped.length > 1) {
        return { valid: false, reason: 'More than 1 ungrouped card' };
    }
    let pureSequenceFound = false;
    let totalSequences = 0;
    for (let group of groups) {
        if (group.length < 3) {
            return { valid: false, reason: 'Groups need 3+ cards' };
        }
        const validation = validateGroup(group, cutJoker);
        if (!validation.valid) {
            return { valid: false, reason: validation.reason || 'Invalid group' };
        }
        if (validation.type === 'sequence') {
            totalSequences++;
            if (validation.pure) {
                pureSequenceFound = true;
            }
        }
    }
    if (!pureSequenceFound) {
        return { valid: false, reason: 'No pure sequence' };
    }
    if (totalSequences < 2) {
        return { valid: false, reason: 'Need 2+ sequences' };
    }
    return { valid: true };
}

function validateGroup(cards, cutJoker) {
    if (cards.length < 3) {
        return { valid: false };
    }
    const isSet = checkIfSet(cards, cutJoker);
    const isSequence = checkIfSequence(cards, cutJoker);
    if (isSet.valid) return { valid: true, type: 'set', pure: isSet.pure };
    if (isSequence.valid) return { valid: true, type: 'sequence', pure: isSequence.pure };
    return { valid: false };
}

function checkIfSet(cards, cutJoker) {
    let hasJoker = false;
    const nonJokerCards = cards.filter(c => {
        const isJoker = c.value === 'JOKER' || (c.value === getWildCardValue(cutJoker) && c.suit !== cutJoker.suit);
        if (isJoker) hasJoker = true;
        return !isJoker;
    });
    if (nonJokerCards.length === 0) return { valid: false };
    const baseValue = nonJokerCards[0].value;
    if (!nonJokerCards.every(c => c.value === baseValue)) return { valid: false };
    const suits = new Set(nonJokerCards.map(c => c.suit));
    if (suits.size !== nonJokerCards.length) return { valid: false };
    return { valid: true, pure: !hasJoker };
}

function checkIfSequence(cards, cutJoker) {
    if (cards.length < 3) return { valid: false };
    let hasJoker = false;
    const nonJokerCards = cards.filter(c => {
        const isJoker = c.value === 'JOKER' || (c.value === getWildCardValue(cutJoker) && c.suit !== cutJoker.suit);
        if (isJoker) hasJoker = true;
        return !isJoker;
    });
    if (nonJokerCards.length === 0) return { valid: false };
    const baseSuit = nonJokerCards[0].suit;
    if (!nonJokerCards.every(c => c.suit === baseSuit)) return { valid: false };
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const sortedCards = [...nonJokerCards].sort((a, b) => valueOrder.indexOf(a.value) - valueOrder.indexOf(b.value));
    let jokerCount = cards.length - nonJokerCards.length;
    for (let i = 0; i < sortedCards.length - 1; i++) {
        const gap = valueOrder.indexOf(sortedCards[i + 1].value) - valueOrder.indexOf(sortedCards[i].value) - 1;
        if (gap > jokerCount) return { valid: false };
        jokerCount -= gap;
    }
    return { valid: true, pure: !hasJoker };
}

function getWildCardValue(cutJoker) {
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const index = valueOrder.indexOf(cutJoker.value);
    return valueOrder[(index + 1) % valueOrder.length];
}

function moveToNextPlayer(room) {
    const game = room.gameState;
    const activePlayers = game.players.filter(p => !p.dropped && !p.eliminated);
    if (activePlayers.length === 0) return;
    const currentIndex = activePlayers.findIndex(p => p.id === game.currentTurn);
    const nextIndex = (currentIndex + 1) % activePlayers.length;
    game.currentTurn = activePlayers[nextIndex].id;
    const nextPlayer = game.players.find(p => p.id === game.currentTurn);
    if (nextPlayer) nextPlayer.hasDrawn = false;
    startTurnTimer(room.code, game.currentTurn);
}

function startTurnTimer(roomCode, playerId) {
    if (turnTimers[roomCode]) clearTimeout(turnTimers[roomCode]);
    io.to(playerId).emit('timerStarted', { playerId, duration: 45 });
    turnTimers[roomCode] = setTimeout(() => handleTimeout(roomCode, playerId), 45000);
}

function handleTimeout(roomCode, playerId) {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    const game = room.gameState;
    const player = game.players.find(p => p.id === playerId);
    if (!player || player.dropped || player.eliminated) return;
    player.consecutiveTimeouts = (player.consecutiveTimeouts || 0) + 1;
    player.totalTimeouts = (player.totalTimeouts || 0) + 1;
    if (player.consecutiveTimeouts >= 2) {
        player.dropped = true;
        player.dropPoints = game.isFirstRound ? 25 : 50;
        player.totalScore += player.dropPoints;
        player.hand = [];
        io.to(roomCode).emit('playerAutoDropped', { playerName: player.name, points: player.dropPoints });
        if (player.totalScore >= 250) {
            player.eliminated = true;
            io.to(roomCode).emit('playerEliminated', { playerName: player.name, reason: 'Reached 250 points' });
        }
    } else {
        autoPlay(game, player);
        io.to(roomCode).emit('autoPlayExecuted', { playerName: player.name });
    }
    moveToNextPlayer(room);
    room.players.forEach(p => io.to(p.id).emit('gameState', getPublicGameState(game, p.id)));
}

function autoPlay(game, player) {
    if (!player.hasDrawn && game.deck.length > 0) {
        player.hand.push(game.deck.pop());
        player.hasDrawn = true;
    }
    if (player.hasDrawn && player.hand.length > 0) {
        game.discardPile.push(player.hand.pop());
        player.hasDrawn = false;
    }
}

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const active = room.gameState.players.filter(p => p.totalScore < 250 && !p.eliminated);
    if (active.length < 2) return;
    const newGame = initializeGame(active.map(p => ({ id: p.id, name: p.name })));
    newGame.isFirstRound = false;
    newGame.players = newGame.players.map(p => {
        const old = room.gameState.players.find(op => op.id === p.id);
        return { ...p, totalScore: old?.totalScore || 0, totalTimeouts: old?.totalTimeouts || 0 };
    });
    room.gameState = newGame;
    io.to(roomCode).emit('newRoundStarted', { dealer: null, firstPlayer: newGame.players[0].name });
    active.forEach(p => io.to(p.id).emit('gameState', getPublicGameState(newGame, p.id)));
    startTurnTimer(roomCode, newGame.currentTurn);
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.id,
            players: [{ id: socket.id, name: data.playerName }],
            started: false,
            gameState: null
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, room: rooms[roomCode] });
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return socket.emit('error', 'Room not found!');
        if (room.started) return socket.emit('error', 'Game already started!');
        if (room.players.length >= 4) return socket.emit('error', 'Room is full!');
        room.players.push({ id: socket.id, name: data.playerName });
        socket.join(data.roomCode);
        socket.emit('roomJoined', { roomCode: data.roomCode, room });
        io.to(data.roomCode).emit('roomUpdate', room);
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.host !== socket.id) return socket.emit('error', 'Only host can start!');
        if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players!');
        room.started = true;
        room.gameState = initializeGame(room.players);
        room.players.forEach(p => io.to(p.id).emit('gameStarted', getPublicGameState(room.gameState, p.id)));
        startTurnTimer(data.roomCode, room.gameState.currentTurn);
    });

    socket.on('drawCard', (data) => {
        const room = rooms[data.roomCode];
        if (!room?.gameState) return;
        const game = room.gameState;
        const player = game.players.find(p => p.id === socket.id);
        if (!player || game.currentTurn !== socket.id || player.hasDrawn) return;
        player.consecutiveTimeouts = 0;
        const card = data.source === 'deck' ? game.deck.pop() : game.discardPile.pop();
        if (!card) return socket.emit('error', 'Empty!');
        player.hand.push(card);
        player.hasDrawn = true;
        room.players.forEach(p => io.to(p.id).emit('gameState', getPublicGameState(game, p.id)));
    });

    socket.on('discardCard', (data) => {
        const room = rooms[data.roomCode];
        if (!room?.gameState) return;
        const game = room.gameState;
        const player = game.players.find(p => p.id === socket.id);
        if (!player || game.currentTurn !== socket.id || !player.hasDrawn) return;
        if (data.cardIndex < 0 || data.cardIndex >= player.hand.length) return;
        game.discardPile.push(player.hand.splice(data.cardIndex, 1)[0]);
        player.hasDrawn = false;
        if (turnTimers[data.roomCode]) clearTimeout(turnTimers[data.roomCode]);
        moveToNextPlayer(room);
        room.players.forEach(p => io.to(p.id).emit('gameState', getPublicGameState(game, p.id)));
    });

    socket.on('declareWin', (data) => {
        const room = rooms[data.roomCode];
        if (!room?.gameState) return;
        const game = room.gameState;
        const player = game.players.find(p => p.id === socket.id);
        if (!player || !player.hasDrawn) return;
        const validation = validateDeclaration(data.groups, data.ungrouped, game.cutJoker);
        if (validation.valid) {
            player.hand = [];
            if (turnTimers[data.roomCode]) clearTimeout(turnTimers[data.roomCode]);
            io.to(data.roomCode).emit('roundWon', { winner: player.name, reason: 'Valid declaration!' });
            game.players.forEach(p => {
                if (p.id !== socket.id && !p.dropped && !p.eliminated) p.totalScore += 80;
                if (p.totalScore >= 250 && !p.eliminated) {
                    p.eliminated = true;
                    io.to(data.roomCode).emit('playerEliminated', { playerName: p.name, reason: 'Reached 250 points' });
                }
            });
            setTimeout(() => startNewRound(data.roomCode), 3000);
        } else {
            player.totalScore += 80;
            player.eliminated = true;
            player.hand = [];
            io.to(data.roomCode).emit('wrongShow', { player: player.name, reason: validation.reason, points: 80 });
            io.to(data.roomCode).emit('playerEliminated', { playerName: player.name, reason: 'Wrong show' });
            const active = game.players.filter(p => !p.eliminated && p.totalScore < 250);
            if (active.length <= 1) {
                io.to(data.roomCode).emit('gameWon', { winner: active[0]?.name || 'No one', reason: 'Last player standing!' });
                setTimeout(() => {
                    if (rooms[data.roomCode]) {
                        rooms[data.roomCode].started = false;
                        rooms[data.roomCode].gameState = null;
                        if (turnTimers[data.roomCode]) clearTimeout(turnTimers[data.roomCode]);
                    }
                }, 3000);
            } else {
                setTimeout(() => startNewRound(data.roomCode), 3000);
            }
        }
    });

    socket.on('playerDrop', (data) => {
        const room = rooms[data.roomCode];
        if (!room?.gameState) return;
        const game = room.gameState;
        const player = game.players.find(p => p.id === socket.id);
        if (!player || player.dropped || player.eliminated || player.hasDrawn) return;
        if (game.currentTurn === socket.id && turnTimers[data.roomCode]) clearTimeout(turnTimers[data.roomCode]);
        const points = game.isFirstRound ? 25 : 50;
        player.dropped = true;
        player.dropPoints = points;
        player.totalScore += points;
        player.hand = [];
        io.to(data.roomCode).emit('playerDropped', { playerName: player.name, points, dropType: game.isFirstRound ? 'First Drop' : 'Middle Drop' });
        if (player.totalScore >= 250) {
            player.eliminated = true;
            io.to(data.roomCode).emit('playerEliminated', { playerName: player.name, reason: 'Reached 250 points' });
        }
        const activeInRound = game.players.filter(p => !p.dropped && !p.eliminated);
        if (activeInRound.length === 1) {
            io.to(data.roomCode).emit('roundWon', { winner: activeInRound[0].name, reason: 'All others dropped/eliminated' });
            setTimeout(() => startNewRound(data.roomCode), 3000);
            return;
        }
        const under250 = game.players.filter(p => p.totalScore < 250 && !p.eliminated);
        if (under250.length <= 1) {
            io.to(data.roomCode).emit('gameWon', { winner: under250[0]?.name || 'No one', reason: 'Last player under 250!' });
            setTimeout(() => {
                if (rooms[data.roomCode]) {
                    rooms[data.roomCode].started = false;
                    rooms[data.roomCode].gameState = null;
                    if (turnTimers[data.roomCode]) clearTimeout(turnTimers[data.roomCode]);
                }
            }, 3000);
            return;
        }
        if (game.currentTurn === socket.id) moveToNextPlayer(room);
        room.players.forEach(p => io.to(p.id).emit('gameState', getPublicGameState(game, p.id)));
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                if (room.players.length === 0) {
                    if (turnTimers[code]) clearTimeout(turnTimers[code]);
                    delete rooms[code];
                } else {
                    if (room.host === socket.id) room.host = room.players[0].id;
                    io.to(code).emit('roomUpdate', room);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎴 Server running on port ${PORT}`));
