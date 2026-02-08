// server.js - Real-time multiplayer Rummy server with improved features
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
app.use(express.static(path.join(__dirname,"public")));

// Serve the improved HTML file as index
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-improved.html'));
});

// Game rooms storage
const rooms = {};

// Helper functions
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];

    // Add 2 standard decks
    for (let d = 0; d < 2; d++) {
        for (let suit of suits) {
            for (let value of values) {
                deck.push({ suit, value });
            }
        }
    }

    // Add 3 jokers
    deck.push({ suit: '🃏', value: 'JOKER' });
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
    
    // Draw cut joker (the card that determines wild card)
    const cutJoker = deck.pop();
    
    const discardPile = [deck.pop()];
    
    const gamePlayers = players.map(p => ({
        id: p.id,
        name: p.name,
        hand: [],
        cardCount: 13,
        hasDrawn: false
    }));

    // Deal 13 cards to each player
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
        deckCount: deck.length
    };
}

function getPublicGameState(gameState, playerId) {
    // Return game state with only the requesting player's hand visible
    return {
        deck: [], // Don't send actual deck
        discardPile: gameState.discardPile,
        cutJoker: gameState.cutJoker, // Show cut joker to everyone
        players: gameState.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand.length,
            hand: p.id === playerId ? p.hand : [] // Only send hand to the player
        })),
        currentTurn: gameState.currentTurn,
        deckCount: gameState.deck.length,
        hand: gameState.players.find(p => p.id === playerId)?.hand || []
    };
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    // Create room
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
        
        console.log(`Room ${roomCode} created by ${playerName}`);
    });

    // Join room
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;

        if (!rooms[roomCode]) {
            socket.emit('error', 'Room not found!');
            return;
        }

        if (rooms[roomCode].started) {
            socket.emit('error', 'Game already started!');
            return;
        }

        if (rooms[roomCode].players.length >= 4) {
            socket.emit('error', 'Room is full! (Max 4 players)');
            return;
        }

        const nameExists = rooms[roomCode].players.some(p => p.name === playerName);
        if (nameExists) {
            socket.emit('error', 'Name already taken!');
            return;
        }

        rooms[roomCode].players.push({
            id: socket.id,
            name: playerName
        });

        socket.join(roomCode);
        socket.emit('roomJoined', { 
            roomCode,
            room: rooms[roomCode]
        });
        
        // Notify all players in room
        io.to(roomCode).emit('roomUpdate', rooms[roomCode]);
        
        console.log(`${playerName} joined room ${roomCode}`);
    });

    // Start game
    socket.on('startGame', (data) => {
        const { roomCode } = data;
        
        if (!rooms[roomCode]) return;
        if (rooms[roomCode].host !== socket.id) {
            socket.emit('error', 'Only host can start the game!');
            return;
        }
        if (rooms[roomCode].players.length < 2) {
            socket.emit('error', 'Need at least 2 players!');
            return;
        }

        rooms[roomCode].started = true;
        const gameState = initializeGame(rooms[roomCode].players);
        rooms[roomCode].gameState = gameState;

        // Send personalized game state to each player
        rooms[roomCode].players.forEach(player => {
            io.to(player.id).emit('gameStarted', getPublicGameState(gameState, player.id));
        });
        
        console.log(`Game started in room ${roomCode}`);
    });

    // Draw card
    socket.on('drawCard', (data) => {
        const { roomCode, source } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Not your turn!');
            return;
        }
        if (player.hasDrawn) {
            socket.emit('error', 'You already drew a card!');
            return;
        }

        let drawnCard;
        
        if (source === 'discard' && game.discardPile.length > 0) {
            drawnCard = game.discardPile.pop();
        } else if (game.deck.length > 0) {
            drawnCard = game.deck.pop();
        } else {
            socket.emit('error', 'No cards available!');
            return;
        }

        player.hand.push(drawnCard);
        player.hasDrawn = true;
        game.deckCount = game.deck.length;

        // Send updated state to all players
        rooms[roomCode].players.forEach(p => {
            io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
        });
    });

    // Discard card
    socket.on('discardCard', (data) => {
        const { roomCode, cardIndex } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        if (game.currentTurn !== socket.id) {
            socket.emit('error', 'Not your turn!');
            return;
        }
        if (!player.hasDrawn) {
            socket.emit('error', 'Draw a card first!');
            return;
        }

        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            socket.emit('error', 'Invalid card!');
            return;
        }

        const card = player.hand.splice(cardIndex, 1)[0];
        game.discardPile.push(card);
        player.hasDrawn = false;

        // Move to next player
        const currentIndex = game.players.findIndex(p => p.id === socket.id);
        const nextIndex = (currentIndex + 1) % game.players.length;
        game.currentTurn = game.players[nextIndex].id;

        // Send updated state to all players
        rooms[roomCode].players.forEach(p => {
            io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
        });
    });

    // Declare win
    socket.on('declareWin', (data) => {
        const { roomCode } = data;
        
        if (!rooms[roomCode] || !rooms[roomCode].gameState) return;

        const game = rooms[roomCode].gameState;
        const player = game.players.find(p => p.id === socket.id);
        
        if (!player) return;
        
        if (player.hand.length === 0) {
            io.to(roomCode).emit('gameWon', { winner: player.name });
            console.log(`${player.name} won in room ${roomCode}`);
            
            // Reset room after 3 seconds
            setTimeout(() => {
                if (rooms[roomCode]) {
                    rooms[roomCode].started = false;
                    rooms[roomCode].gameState = null;
                }
            }, 3000);
        } else {
            socket.emit('error', `You still have ${player.hand.length} cards!`);
        }
    });

    // Leave room
    socket.on('leaveRoom', (data) => {
        const { roomCode } = data;
        handlePlayerLeave(socket, roomCode);
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        for (let roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
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

    const playerName = room.players[playerIndex].name;
    room.players.splice(playerIndex, 1);

    if (room.players.length === 0) {
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted (empty)`);
    } else {
        // Transfer host if needed
        if (room.host === socket.id && room.players.length > 0) {
            room.host = room.players[0].id;
        }
        
        io.to(roomCode).emit('roomUpdate', room);
        
        // If game was in progress, handle game state
        if (room.started && room.gameState) {
            const game = room.gameState;
            const gamePlayerIndex = game.players.findIndex(p => p.id === socket.id);
            
            if (gamePlayerIndex !== -1) {
                game.players.splice(gamePlayerIndex, 1);
                
                if (game.players.length === 0) {
                    room.started = false;
                    room.gameState = null;
                } else {
                    // Move turn if it was the leaving player's turn
                    if (game.currentTurn === socket.id) {
                        game.currentTurn = game.players[0].id;
                    }
                    
                    // Send updated state to remaining players
                    room.players.forEach(p => {
                        io.to(p.id).emit('gameState', getPublicGameState(game, p.id));
                    });
                }
            }
        }
    }

    socket.leave(roomCode);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🎴 RUMMY GAME SERVER RUNNING 🎴     ║
╚════════════════════════════════════════╝

Server: http://localhost:${PORT}
Network: http://YOUR_IP_ADDRESS:${PORT}

✨ IMPROVED FEATURES:
   ✓ Drag and drop cards
   ✓ Table layout with avatars
   ✓ Card grouping & arrangement
   ✓ Visual turn indicators

Ready for players to connect!
    `);
});
