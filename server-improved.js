const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// ================= ROOM & TIMER STORAGE =================
const rooms = {};
const turnTimers = {};
// ========================================================

// Generate 6-letter room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Home route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
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
        consecutiveTimeouts: 0
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
        turnCount: 0
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
        return { valid: false, reason: 'Need 3+ cards' };
    }

    const isSet = checkIfSet(cards, cutJoker);
    const isSequence = checkIfSequence(cards, cutJoker);

    if (isSet.valid) {
        return { valid: true, type: 'set', pure: isSet.pure };
    }

    if (isSequence.valid) {
        return { valid: true, type: 'sequence', pure: isSequence.pure };
    }

    return { valid: false, reason: 'Invalid set/sequence' };
}

function checkIfSet(cards, cutJoker) {
    let hasJoker = false;
    const nonJokerCards = cards.filter(c => {
        const isJoker = c.value === 'JOKER' || 
                       (c.value === getWildCardValue(cutJoker) && c.suit !== cutJoker.suit);
        if (isJoker) hasJoker = true;
        return !isJoker;
    });

    if (nonJokerCards.length === 0) {
        return { valid: false };
    }

    const baseValue = nonJokerCards[0].value;
    const allSameValue = nonJokerCards.every(c => c.value === baseValue);
    
    if (!allSameValue) {
        return { valid: false };
    }

    const nonJokerSuits = nonJokerCards.map(c => c.suit);
    const uniqueSuits = new Set(nonJokerSuits);
    
    if (uniqueSuits.size !== nonJokerSuits.length) {
        return { valid: false };
    }

    return { valid: true, pure: !hasJoker };
}

function checkIfSequence(cards, cutJoker) {
    if (cards.length < 3) {
        return { valid: false };
    }

    let hasJoker = false;
    
    const nonJokerCards = cards.filter(c => {
        const isJoker = c.value === 'JOKER' || 
                       (c.value === getWildCardValue(cutJoker) && c.suit !== cutJoker.suit);
        if (isJoker) hasJoker = true;
        return !isJoker;
    });

    if (nonJokerCards.length === 0) {
        return { valid: false };
    }

    const baseSuit = nonJokerCards[0].suit;
    const sameSuit = nonJokerCards.every(c => c.suit === baseSuit);
    
    if (!sameSuit) {
        return { valid: false };
    }

    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const sortedCards = [...nonJokerCards].sort((a, b) => {
        return valueOrder.indexOf(a.value) - valueOrder.indexOf(b.value);
    });

    let jokerCount = cards.length - nonJokerCards.length;
    
    for (let i = 0; i < sortedCards.length - 1; i++) {
        const currentIndex = valueOrder.indexOf(sortedCards[i].value);
        const nextIndex = valueOrder.indexOf(sortedCards[i + 1].value);
        const gap = nextIndex - currentIndex - 1;
        
        if (gap > jokerCount) {
            return { valid: false };
        }
        
        jokerCount -= gap;
    }

    return { valid: true, pure: !hasJoker };
}

function getWildCardValue(cutJoker) {
    const valueOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const index = valueOrder.indexOf(cutJoker.value);
    return valueOrder[(index + 1) % valueOrder.length];
}

function startTurnTimer(roomCode, playerId) {
    // Clear any existing timer for this room
    if (turnTimers[roomCode]) {
        clearTimeout(turnTimers[roomCode]);
    }

    // Start 45-second timer
    turnTimers[roomCode] = setTimeout(() => {
        handleTurnTimeout(roomCode, playerId);
    }, 45000); // 45 seconds

    // Emit timer start to all players in room
    io.to(roomCode).emit('timerStarted', { 
        playerId: playerId,
        duration: 45 
    });
}

function handleTurnTimeout(roomCode, playerId) {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const game = room.gameState;
    const player = game.players.find(p => p.id === playerId);
    
    if (!player || player.dropped || player.eliminated) return;

    // Increment consecutive timeout counter
    player.consecutiveTimeouts = (player.consecutiveTimeouts || 0) + 1;

    console.log(`${player.name} timeout #${player.consecutiveTimeouts} in ${roomCode}`);

    if (player.consecutiveTimeouts >= 2) {
        // Auto middle drop after 2 consecutive timeouts
        player.dropped = true;
        player.dropPoints = 50;
        player.totalScore += 50;
        player.hand = [];

        io.to(roomCode).emit('playerAutoDropped', {
            playerName: player.name,
            points: 50,
            reason: 'timeout'
        });

        // Check if only one player remains
        const activePlayers = game.players.filter(p => !p.dropped && !p.eliminated);
        if (activePlayers.length === 1) {
            io.to(roomCode).emit('gameWon', { 
                winner: activePlayers[0].name,
                reason: 'All others dropped/eliminated'
            });
            
            setTimeout(() => {
                if (rooms[roomCode]) {
                    rooms[roomCode].started = false;
                    rooms[roomCode].gameState = null;
                }
            }, 3000);
            return;
        }

        // Move to next player
        moveToNextPlayer(room);
    } else {
        // Auto-draw from pile and auto-discard first card
        if (game.deck.length > 0) {
            const drawnCard = game.deck.pop();
            player.hand.push(drawnCard);
            game.deckCount = game.deck.length;
        }

        if (player.hand.length > 0) {
            const discardedCard = player.hand.shift();
            game.discardPile.push(discardedCard);
        }

        player.hasDrawn = false;

        io.to(roomCode).emit('autoPlayExecuted', {
            playerName: player.name,
            timeoutCount: player.consecutiveTimeouts
        });

        // Move to next player
        moveToNextPlayer(room);
    }

    // Update game state for all players
    room.players.forEach(p => {
        io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
    });
}

function moveToNextPlayer(room) {
    const game = room.gameState;
    const currentIndex = game.players.findIndex(p => p.id === game.currentTurn);
    let nextIndex = (currentIndex + 1) % game.players.length;
    
    // Skip dropped/eliminated players
    let attempts = 0;
    while ((game.players[nextIndex].dropped || game.players[nextIndex].eliminated) && attempts < game.players.length) {
        nextIndex = (nextIndex + 1) % game.players.length;
        attempts++;
    }
    
    game.currentTurn = game.players[nextIndex].id;
    game.turnCount++;
    
    // Start timer for next player
    startTurnTimer(room.code, game.currentTurn);
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        const playerName = data.playerName;

        rooms[roomCode] = {
            code: roomCode,
            players: [{ id: socket.id, name: playerName }],
            host: socket.id,
            gameState: null,
            started: false
        };

        socket.join(roomCode);
        socket.emit('roomCreated', { 
            roomCode,
            room: rooms[roomCode]
        });
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;

        if (!rooms[roomCode]) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (rooms[roomCode].started) {
            socket.emit('error', 'Game in progress');
            return;
        }

        if (rooms[roomCode].players.length >= 4) {
            socket.emit('error', 'Room full');
            return;
        }

        rooms[roomCode].players.push({ id: socket.id, name: playerName });
        socket.join(roomCode);
        
        socket.emit('roomJoined', { 
            roomCode,
            room: rooms[roomCode]
        });

        io.to(roomCode).emit('roomUpdate', rooms[roomCode]);
    });

    socket.on('startGame', (data) => {
        const { roomCode } = data;
        
        if (!rooms[roomCode]) return;
        if (socket.id !== rooms[roomCode].host) {
            socket.emit('error', 'Only host can start');
            return;
        }

        if (rooms[roomCode].players.length < 2) {
            socket.emit('error', 'Need 2+ players');
            return;
        }

        const game = initializeGame(rooms[roomCode].players);
        rooms[roomCode].gameState = game;
        rooms[roomCode].started = true;

        rooms[roomCode].players.forEach(player => {
            io.to(player.id).emit('gameStarted', getPublicGameState(game, player.id));
        });

        // Start timer for first player
        startTurnTimer(roomCode, game.currentTurn);

        console.log(`Game started in ${roomCode}`);
    });

    socket.on('drawCard', (data) => {
        const { roomCode, source } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (player.dropped || player.eliminated) {
            socket.emit('error', 'You are out!');
            return;
        }

        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Not your turn!');
            return;
        }

        if (player.hasDrawn) {
            socket.emit('error', 'Already drew!');
            return;
        }

        let drawnCard;
        
        if (source === 'deck' && game.deck.length > 0) {
            drawnCard = game.deck.pop();
        } else if (source === 'discard' && game.discardPile.length > 0) {
            drawnCard = game.discardPile.pop();
        } else {
            socket.emit('error', 'No cards available');
            return;
        }

        player.hand.push(drawnCard);
        player.hasDrawn = true;
        
        // Reset consecutive timeouts on successful play
        player.consecutiveTimeouts = 0;
        
        game.deckCount = game.deck.length;

        rooms[roomCode].players.forEach(p => {
            io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
        });
    });

    socket.on('discardCard', (data) => {
        const { roomCode, cardIndex } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (player.dropped || player.eliminated) {
            socket.emit('error', 'You are out!');
            return;
        }

        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Not your turn!');
            return;
        }

        if (!player.hasDrawn) {
            socket.emit('error', 'Draw card first!');
            return;
        }

        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            socket.emit('error', 'Invalid card!');
            return;
        }

        const discardedCard = player.hand.splice(cardIndex, 1)[0];
        game.discardPile.push(discardedCard);
        player.hasDrawn = false;

        // Clear turn timer
        if (turnTimers[roomCode]) {
            clearTimeout(turnTimers[roomCode]);
        }

        game.turnCount++;
        
        // Move to next active player
        moveToNextPlayer(rooms[roomCode]);

        rooms[roomCode].players.forEach(p => {
            io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
        });
    });

    socket.on('declareWin', (data) => {
        const { roomCode, groups, ungrouped } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (player.dropped || player.eliminated) {
            socket.emit('error', 'You are out!');
            return;
        }

        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Not your turn!');
            return;
        }

        if (!player.hasDrawn) {
            socket.emit('error', 'Draw card first!');
            return;
        }

        // Clear turn timer
        if (turnTimers[roomCode]) {
            clearTimeout(turnTimers[roomCode]);
        }

        // Validate declaration
        const validation = validateDeclaration(groups || [], ungrouped || [], game.cutJoker);
        
        if (validation.valid) {
            // Correct show - player wins
            io.to(roomCode).emit('gameWon', { 
                winner: player.name,
                reason: 'Valid declaration!'
            });
            
            console.log(`${player.name} won in ${roomCode}`);
            
            setTimeout(() => {
                if (rooms[roomCode]) {
                    rooms[roomCode].started = false;
                    rooms[roomCode].gameState = null;
                    if (turnTimers[roomCode]) {
                        clearTimeout(turnTimers[roomCode]);
                    }
                }
            }, 3000);
        } else {
            // Wrong show - 80 points penalty
            player.totalScore += 80;
            
            // Count active players
            const activePlayers = game.players.filter(p => !p.dropped && !p.eliminated);
            
            if (activePlayers.length <= 2) {
                // If only 2 players left (including this one), game ends
                io.to(roomCode).emit('gameWon', {
                    winner: activePlayers.find(p => p.id !== player.id)?.name || 'Other player',
                    reason: `${player.name} made wrong show!`
                });
                
                setTimeout(() => {
                    if (rooms[roomCode]) {
                        rooms[roomCode].started = false;
                        rooms[roomCode].gameState = null;
                        if (turnTimers[roomCode]) {
                            clearTimeout(turnTimers[roomCode]);
                        }
                    }
                }, 3000);
            } else {
                // More than 2 players - eliminate this player and continue
                player.eliminated = true;
                player.hand = [];
                
                io.to(roomCode).emit('wrongShow', {
                    player: player.name,
                    reason: validation.reason,
                    points: 80
                });
                
                io.to(roomCode).emit('playerEliminated', {
                    playerName: player.name
                });

                // Move to next player
                moveToNextPlayer(rooms[roomCode]);

                // Send updated state
                rooms[roomCode].players.forEach(p => {
                    io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
                });
                
                console.log(`${player.name} eliminated (wrong show) in ${roomCode}`);
            }
        }
    });

    socket.on('playerDrop', (data) => {
        const { roomCode, dropType, points } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (player.dropped || player.eliminated) {
            socket.emit('error', 'Already out!');
            return;
        }

        // Player can only drop BEFORE drawing first card
        if (player.hasDrawn) {
            socket.emit('error', 'Cannot drop after drawing card!');
            return;
        }

        // Clear turn timer if this player is dropping
        if (game.currentTurn === socket.id && turnTimers[roomCode]) {
            clearTimeout(turnTimers[roomCode]);
        }

        // Mark player as dropped
        player.dropped = true;
        player.dropPoints = points;
        player.totalScore += points;
        player.hand = []; // Hide cards

        io.to(roomCode).emit('playerDropped', {
            playerName: player.name,
            points: points,
            dropType: dropType
        });

        // Check if only one player remains
        const activePlayers = game.players.filter(p => !p.dropped && !p.eliminated);
        if (activePlayers.length === 1) {
            io.to(roomCode).emit('gameWon', { 
                winner: activePlayers[0].name,
                reason: 'All others dropped/eliminated'
            });
            
            setTimeout(() => {
                if (rooms[roomCode]) {
                    rooms[roomCode].started = false;
                    rooms[roomCode].gameState = null;
                    if (turnTimers[roomCode]) {
                        clearTimeout(turnTimers[roomCode]);
                    }
                }
            }, 3000);
            return;
        }

        // Move to next active player if current player dropped
        if (game.currentTurn === socket.id) {
            moveToNextPlayer(rooms[roomCode]);
        }

        rooms[roomCode].players.forEach(p => {
            io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
        });
        
        console.log(`${player.name} dropped (${dropType}, ${points} pts) in ${roomCode}`);
    });

    socket.on('leaveRoom', (data) => {
        const { roomCode } = data;
        handlePlayerLeave(socket, roomCode);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        for (let roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.players.find(p => p.id === socket.id)) {
                handlePlayerLeave(socket, roomCode);
            }
        }
    });
});

function handlePlayerLeave(socket, roomCode) {
    if (!rooms[roomCode]) return;

    const room = rooms[roomCode];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    
    if (playerIndex === -1) return;

    room.players.splice(playerIndex, 1);

    // Clear timer if this room is empty
    if (room.players.length === 0) {
        if (turnTimers[roomCode]) {
            clearTimeout(turnTimers[roomCode]);
            delete turnTimers[roomCode];
        }
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted`);
    } else {
        if (room.host === socket.id) {
            room.host = room.players[0].id;
        }
        
        io.to(roomCode).emit('roomUpdate', room);
        
        if (room.started && room.gameState) {
            const game = room.gameState;
            const gamePlayerIndex = game.players.findIndex(p => p.id === socket.id);
            
            if (gamePlayerIndex !== -1) {
                game.players.splice(gamePlayerIndex, 1);
                
                if (game.players.length > 0) {
                    if (game.currentTurn === socket.id) {
                        const activePlayers = game.players.filter(p => !p.dropped && !p.eliminated);
                        if (activePlayers.length > 0) {
                            game.currentTurn = activePlayers[0].id;
                            startTurnTimer(roomCode, game.currentTurn);
                        }
                    }
                    
                    room.players.forEach(p => {
                        io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
                    });
                }
            }
        }
    }

    socket.leave(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║   🎴 RUMMY GAME SERVER RUNNING 🎴     ║
╚═══════════════════════════════════════╝

Server: http://localhost:${PORT}

✨ FEATURES:
   ✓ Mobile responsive (landscape)
   ✓ First drop: 25 points (before draw)
   ✓ Middle drop: 50 points
   ✓ 45-second turn timer
   ✓ Auto drop after 2 timeouts
   ✓ Drag to discard
   ✓ Card grouping with spacing
   ✓ Wrong show: eliminate player
   ✓ Score tracking

Ready!
    `);
});
