const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAP_SIZE = 1200; // Increased map size
const INITIAL_RADIUS = 30; // Starting mass
const MIN_RADIUS = 15; // Minimum mass before death
const FOOD_COUNT = 150;
const TICK_RATE = 60; // 60 times per second

const SCORES_FILE = path.join(__dirname, 'scores.json');
let highScores = {};

// Load high scores
if (fs.existsSync(SCORES_FILE)) {
    try {
        highScores = JSON.parse(fs.readFileSync(SCORES_FILE));
    } catch (e) {
        console.error('Error loading scores:', e);
    }
}

function saveScore(name, score) {
    if (!highScores[name] || score > highScores[name]) {
        highScores[name] = score;
        fs.writeFileSync(SCORES_FILE, JSON.stringify(highScores, null, 2));
    }
}

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let food = [];
let bullets = [];
let nextTeam = 'red'; // Alternate teams

// Initialize 16 Capture Zones (4x4 Grid)
let zones = [];
const ZONE_SIZE = MAP_SIZE / 4; // 300x300
for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
        let initialOwner = 'neutral';
        if (col === 0) initialOwner = 'red';
        if (col === 3) initialOwner = 'blue';

        zones.push({
            id: row * 4 + col,
            x: col * ZONE_SIZE,
            y: row * ZONE_SIZE,
            size: ZONE_SIZE,
            owner: initialOwner,
            capturingTeam: null,
            captureProgress: 0 // 0 to 100
        });
    }
}

// Initialize food
for (let i = 0; i < FOOD_COUNT; i++) {
    genFood();
}

function genFood() {
    food.push({
        id: Math.random().toString(36).substr(2, 9),
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        radius: 4,
        value: 2 // How much mass you gain
    });
}

function spawnPlayer(id, name, currentTeam) {
    let team = currentTeam || nextTeam;
    // Alternate teams for new players
    if (!currentTeam) {
        if (nextTeam === 'red') nextTeam = 'blue';
        else nextTeam = 'red';
    }

    let spawnX = team === 'red' ? Math.random() * 200 + 50 : MAP_SIZE - (Math.random() * 200 + 50);
    let spawnY = Math.random() * (MAP_SIZE - 100) + 50;

    // Team colors (Red team uses red/orange, Blue team uses blue/cyan)
    let color = team === 'red' ? `hsl(${Math.random() * 40}, 100%, 50%)` : `hsl(${Math.random() * 40 + 200}, 100%, 50%)`;

    return {
        id: id,
        name: name || 'Guest',
        team: team,
        x: spawnX,
        y: spawnY,
        radius: INITIAL_RADIUS, // Represents "size" or strength
        color: color,
        score: 0,
        targetX: 0, // direction vector X
        targetY: 0,  // direction vector Y
        aimX: 0,
        aimY: 0,
        shieldActive: false
    };
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join', (name) => {
        players[socket.id] = spawnPlayer(socket.id, name);
        socket.emit('init', { mapSize: MAP_SIZE, id: socket.id });
    });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].targetX = data.x;
            players[socket.id].targetY = data.y;
            players[socket.id].aimX = data.aimX;
            players[socket.id].aimY = data.aimY;
        }
    });

    socket.on('action', (data) => {
        const p = players[socket.id];
        if (!p) return;

        if (data.type === 'shoot') {
            const BULLET_COST = 5;
            // Can only shoot if you have enough mass
            if (p.radius > MIN_RADIUS + BULLET_COST) {
                p.radius -= BULLET_COST; // Lose mass

                // Spawn bullet slightly ahead of player (using aim vector)
                const spawnDist = p.radius + 10;
                bullets.push({
                    id: Math.random().toString(36).substr(2, 9),
                    ownerId: p.id,
                    team: p.team,
                    x: p.x + p.aimX * spawnDist,
                    y: p.y + p.aimY * spawnDist,
                    vx: p.aimX * 10, // Base speed
                    vy: p.aimY * 10,
                    radius: 6,
                    damage: BULLET_COST, // Damage equals mass spent
                    amplified: false // Track if passed through ally shield
                });
            }
        } else if (data.type === 'shield_on') {
            p.shieldActive = true;
        } else if (data.type === 'shield_off') {
            p.shieldActive = false;
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            saveScore(players[socket.id].name, Math.floor(players[socket.id].score));
        }
        delete players[socket.id];
        console.log('User disconnected:', socket.id);
    });
});

// Helper for collision checking between two circles
function checkCircleCollision(x1, y1, r1, x2, y2, r2) {
    const dist = Math.hypot(x1 - x2, y1 - y2);
    return dist < r1 + r2;
}

// Helper to check collision between a line segment and a circle
function lineCircleCollision(x1, y1, x2, y2, cx, cy, r) {
    // Check if either end of line is inside circle
    if (Math.hypot(cx - x1, cy - y1) <= r || Math.hypot(cx - x2, cy - y2) <= r) return true;

    // Line segment length squared
    const lenSq = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
    if (lenSq === 0) return false;

    // Calculate dot product
    const t = Math.max(0, Math.min(1, ((cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1)) / lenSq));

    // Closest point on line segment
    const closeX = x1 + t * (x2 - x1);
    const closeY = y1 + t * (y2 - y1);

    // Distance from closest point to circle center
    return Math.hypot(cx - closeX, cy - closeY) <= r;
}

// Game Loop
setInterval(() => {
    // Update players
    Object.values(players).forEach(player => {
        // Penalty to speed if shield is active
        const shieldPenalty = player.shieldActive ? 0.5 : 1;
        // Speed decreases as size increases
        const speed = (5 * (30 / player.radius) + 1) * shieldPenalty;

        player.x += player.targetX * speed;
        player.y += player.targetY * speed;

        // Constrain to map
        player.x = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.y));

        // Constant slow drain/hunger? No, let's keep it simple for now as requested.

        // Collision with food
        food = food.filter(f => {
            if (checkCircleCollision(player.x, player.y, player.radius, f.x, f.y, f.radius)) {
                player.radius += f.value; // Gain size
                player.score += f.value;
                genFood(); // Replace food
                return false;
            }
            return true;
        });

        // Player vs Player eating (Eating is still possible, but teams can't eat each other)
        Object.values(players).forEach(other => {
            if (player.id !== other.id && player.team !== other.team) {
                const dist = Math.hypot(player.x - other.x, player.y - other.y);
                // Can eat if 15% larger
                if (dist < player.radius && player.radius > other.radius * 1.15) {
                    player.radius += other.radius * 0.5; // Gain half their mass
                    player.score += Math.floor(other.radius) + 10;

                    saveScore(other.name, Math.floor(other.score));
                    // Check if other died completely or just shrink? Standard is death.
                    io.to(other.id).emit('died', { killedBy: player.name });
                    // Respawn the eaten player
                    players[other.id] = spawnPlayer(other.id, other.name, other.team);
                }
            }
        });
    });

    // Process Zone Captures
    zones.forEach(zone => {
        let redCount = 0;
        let blueCount = 0;

        // Check players in this zone
        Object.values(players).forEach(p => {
            if (p.x >= zone.x && p.x <= zone.x + zone.size &&
                p.y >= zone.y && p.y <= zone.y + zone.size) {
                if (p.team === 'red') redCount++;
                if (p.team === 'blue') blueCount++;
            }
        });

        if (redCount > 0 && blueCount === 0 && zone.owner !== 'red') {
            // Red capturing
            if (zone.capturingTeam !== 'red') {
                zone.capturingTeam = 'red';
            }
            // 20 sec for 1 player = 5% per second. At 60 ticks, 5/60 per tick
            zone.captureProgress += (redCount * 5) / TICK_RATE;
            if (zone.captureProgress >= 100) {
                zone.owner = 'red';
                zone.captureProgress = 0;
                zone.capturingTeam = null;
            }
        } else if (blueCount > 0 && redCount === 0 && zone.owner !== 'blue') {
            // Blue capturing
            if (zone.capturingTeam !== 'blue') {
                zone.capturingTeam = 'blue';
            }
            zone.captureProgress += (blueCount * 5) / TICK_RATE;
            if (zone.captureProgress >= 100) {
                zone.owner = 'blue';
                zone.captureProgress = 0;
                zone.capturingTeam = null;
            }
        } else {
            // Contested or empty
            zone.captureProgress = Math.max(0, zone.captureProgress - (5 / TICK_RATE)); // Decay slowly
            if (zone.captureProgress === 0) zone.capturingTeam = null;
        }
    });

    // Update bullets
    bullets.forEach((b, index) => {
        b.x += b.vx;
        b.y += b.vy;

        // Boundary check
        if (b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            b.dead = true;
            return;
        }

        // Check collision with players
        for (let pid in players) {
            let p = players[pid];

            // Player's own bullet shouldn't hit them instantly
            if (b.ownerId === p.id) continue;

            const dist = Math.hypot(b.x - p.x, b.y - p.y);

            // Check Shield first (Straight Line)
            if (p.shieldActive && p.aimX !== undefined && p.aimY !== undefined) {
                // Shield line endpoints: perpendicular to direction, length = radius * 2
                const perpX = -p.aimY;
                const perpY = p.aimX;

                // Shield center is slightly in front of player
                const shieldCX = p.x + p.aimX * (p.radius + 15);
                const shieldCY = p.y + p.aimY * (p.radius + 15);

                const lx1 = shieldCX + perpX * p.radius;
                const ly1 = shieldCY + perpY * p.radius;
                const lx2 = shieldCX - perpX * p.radius;
                const ly2 = shieldCY - perpY * p.radius;

                const hittingShield = lineCircleCollision(lx1, ly1, lx2, ly2, b.x, b.y, b.radius);

                if (hittingShield) {
                    if (p.team === b.team && !b.amplified) {
                        // Ally shield -> Amplify bullet
                        b.radius *= 2;
                        b.vx *= 1.5;
                        b.vy *= 1.5;
                        b.damage *= 2;
                        b.amplified = true;
                    } else if (p.team !== b.team) {
                        // Enemy shield -> Block bullet completely
                        b.dead = true;
                    }
                    continue; // Skip hitting the player flesh if shield interacted
                }
            }

            // Hit flesh
            if (dist < p.radius + b.radius) {
                if (p.team !== b.team) {
                    // Deal damage (reduce mass)
                    p.radius -= b.damage;

                    // Award score to shooter
                    if (players[b.ownerId]) {
                        players[b.ownerId].score += b.damage;
                        // Vampirism? (Optional: shooter gains mass too. Let's not do vampirism for bullets to avoid snowballing too fast, or just a small amount)
                        players[b.ownerId].radius += b.damage * 0.5;
                    }

                    // Check if player died from damage
                    if (p.radius < MIN_RADIUS) {
                        saveScore(p.name, Math.floor(p.score));
                        let killerName = players[b.ownerId] ? players[b.ownerId].name : 'An enemy';
                        io.to(p.id).emit('died', { killedBy: `a bullet from ${killerName}` });
                        players[p.id] = spawnPlayer(p.id, p.name, p.team); // Respawn
                    }
                    b.dead = true;
                }
            }
        }
    });

    // Clean up dead bullets
    bullets = bullets.filter(b => !b.dead);

    io.emit('update', { players, food, bullets, zones, highScores });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
