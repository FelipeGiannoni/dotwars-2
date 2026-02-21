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

// NPC Invasion constants
const NPC_SPAWN_INTERVAL = 120000; // 2 minutes in ms
const NPC_LIFESPAN = 30; // seconds
const NPC_TIERS = [
    { name: 'Weak', weight: 60, radius: 20, speed: 4, shootInterval: 90, blastRadius: 80, blastDamage: 5, reward: 15, shieldChance: 0 },
    { name: 'Strong', weight: 30, radius: 40, speed: 3, shootInterval: 45, blastRadius: 150, blastDamage: 15, reward: 40, shieldChance: 0 },
    { name: 'Boss', weight: 10, radius: 80, speed: 2, shootInterval: 20, blastRadius: 250, blastDamage: 30, reward: 100, shieldChance: 1 }
];

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
let npcs = [];
let explosions = []; // Visual-only, sent to client

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
    let team = currentTeam;

    // If no team specified, use smart balancing
    if (!team) {
        const playerList = Object.values(players);
        const redCount = playerList.filter(p => p.team === 'red').length;
        const blueCount = playerList.filter(p => p.team === 'blue').length;

        if (playerList.length === 0) {
            team = 'red'; // First player always red
        } else if (redCount < blueCount) {
            team = 'red';
        } else if (blueCount < redCount) {
            team = 'blue';
        } else {
            // Equal count — assign to team that does NOT have the #1 player
            let topPlayer = null;
            let topScore = -1;
            playerList.forEach(p => {
                if (p.score > topScore) {
                    topScore = p.score;
                    topPlayer = p;
                }
            });
            team = topPlayer && topPlayer.team === 'red' ? 'blue' : 'red';
        }
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

// ---- NPC INVASION SYSTEM ----
function pickNPCTier() {
    const roll = Math.random() * 100;
    let cumulative = 0;
    for (const tier of NPC_TIERS) {
        cumulative += tier.weight;
        if (roll < cumulative) return tier;
    }
    return NPC_TIERS[0];
}

function spawnNPC() {
    const tier = pickNPCTier();
    const edge = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left
    let x, y, aimX, aimY;

    switch (edge) {
        case 0: // Top
            x = Math.random() * MAP_SIZE; y = -tier.radius;
            aimX = 0; aimY = 1;
            break;
        case 1: // Right
            x = MAP_SIZE + tier.radius; y = Math.random() * MAP_SIZE;
            aimX = -1; aimY = 0;
            break;
        case 2: // Bottom
            x = Math.random() * MAP_SIZE; y = MAP_SIZE + tier.radius;
            aimX = 0; aimY = -1;
            break;
        case 3: // Left
            x = -tier.radius; y = Math.random() * MAP_SIZE;
            aimX = 1; aimY = 0;
            break;
    }

    npcs.push({
        id: 'npc_' + Math.random().toString(36).substr(2, 9),
        tier: tier.name,
        x: x,
        y: y,
        radius: tier.radius,
        maxRadius: tier.radius,
        speed: tier.speed,
        aimX: aimX,
        aimY: aimY,
        shootInterval: tier.shootInterval, // ticks between shots
        shootCooldown: tier.shootInterval,
        blastRadius: tier.blastRadius,
        blastDamage: tier.blastDamage,
        reward: tier.reward,
        shieldActive: tier.shieldChance > 0,
        shieldCooldown: 0, // Boss toggles shield
        timeLeft: NPC_LIFESPAN * TICK_RATE, // 30 seconds in ticks
        color: tier.name === 'Boss' ? '#9b59b6' : tier.name === 'Strong' ? '#8e44ad' : '#c39bd3',
        team: 'npc' // Neutral/hostile to all
    });
}

// Spawn first NPC after 30 seconds, then every 2 minutes
setTimeout(() => {
    spawnNPC();
    setInterval(spawnNPC, NPC_SPAWN_INTERVAL);
}, 30000);

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join', (name) => {
        players[socket.id] = spawnPlayer(socket.id, name);
        socket.emit('init', { mapSize: MAP_SIZE, id: socket.id });
    });

    // Ping handler
    socket.on('ping_check', () => {
        socket.emit('pong_check');
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

    // ---- NPC AI & COMBAT ----
    npcs.forEach(npc => {
        npc.timeLeft--;

        // Find nearest player
        let nearest = null;
        let nearestDist = Infinity;
        Object.values(players).forEach(p => {
            const d = Math.hypot(p.x - npc.x, p.y - npc.y);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = p;
            }
        });

        // Chase nearest player
        if (nearest) {
            const dx = nearest.x - npc.x;
            const dy = nearest.y - npc.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 0) {
                npc.aimX = dx / dist;
                npc.aimY = dy / dist;
            }
            npc.x += npc.aimX * npc.speed;
            npc.y += npc.aimY * npc.speed;
        } else {
            // No players, drift toward center
            const dx = MAP_SIZE / 2 - npc.x;
            const dy = MAP_SIZE / 2 - npc.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 10) {
                npc.aimX = dx / dist;
                npc.aimY = dy / dist;
            }
            npc.x += npc.aimX * npc.speed;
            npc.y += npc.aimY * npc.speed;
        }

        // Boss shield toggle (on 3 sec, off 2 sec)
        if (npc.tier === 'Boss') {
            npc.shieldCooldown++;
            if (npc.shieldActive && npc.shieldCooldown > 180) { // 3 sec on
                npc.shieldActive = false;
                npc.shieldCooldown = 0;
            } else if (!npc.shieldActive && npc.shieldCooldown > 120) { // 2 sec off
                npc.shieldActive = true;
                npc.shieldCooldown = 0;
            }
        }

        // NPC Shooting
        npc.shootCooldown--;
        if (npc.shootCooldown <= 0 && nearest) {
            npc.shootCooldown = npc.shootInterval;
            const spawnDist = npc.radius + 10;
            bullets.push({
                id: Math.random().toString(36).substr(2, 9),
                ownerId: npc.id,
                team: 'npc',
                x: npc.x + npc.aimX * spawnDist,
                y: npc.y + npc.aimY * spawnDist,
                vx: npc.aimX * 8,
                vy: npc.aimY * 8,
                radius: npc.tier === 'Boss' ? 10 : 6,
                damage: npc.tier === 'Boss' ? 10 : npc.tier === 'Strong' ? 7 : 4,
                amplified: false
            });
        }

        // NPC collision with player bullets
        bullets.forEach(b => {
            if (b.team === 'npc' || b.dead) return; // NPC bullets don't hurt NPCs
            const d = Math.hypot(b.x - npc.x, b.y - npc.y);

            // Check NPC shield first (Boss only)
            if (npc.shieldActive && npc.aimX !== undefined) {
                const perpX = -npc.aimY;
                const perpY = npc.aimX;
                const shieldCX = npc.x + npc.aimX * (npc.radius + 15);
                const shieldCY = npc.y + npc.aimY * (npc.radius + 15);
                const lx1 = shieldCX + perpX * npc.radius;
                const ly1 = shieldCY + perpY * npc.radius;
                const lx2 = shieldCX - perpX * npc.radius;
                const ly2 = shieldCY - perpY * npc.radius;
                if (lineCircleCollision(lx1, ly1, lx2, ly2, b.x, b.y, b.radius)) {
                    b.dead = true;
                    return;
                }
            }

            if (d < npc.radius + b.radius) {
                npc.radius -= b.damage;
                // Reward the shooter
                if (players[b.ownerId]) {
                    players[b.ownerId].score += b.damage * 2;
                    players[b.ownerId].radius += b.damage * 0.3;
                }
                b.dead = true;
            }
        });

        // Check if NPC is dead (radius too small) or timer expired
        if (npc.radius < 10 || npc.timeLeft <= 0) {
            // EXPLOSION!
            const bx = npc.x;
            const by = npc.y;
            const br = npc.blastRadius;
            const bd = npc.blastDamage;

            // Add visual explosion for clients
            explosions.push({
                x: bx,
                y: by,
                radius: br,
                damage: bd,
                tier: npc.tier,
                timer: 30 // frames to show (0.5 sec)
            });

            // Damage all players in blast radius
            Object.values(players).forEach(p => {
                const d = Math.hypot(p.x - bx, p.y - by);
                if (d < br) {
                    // Damage scales: more damage if closer
                    const dmgScale = 1 - (d / br);
                    const actualDmg = Math.floor(bd * dmgScale);
                    p.radius -= actualDmg;

                    // Knockback
                    const kbDist = (br - d) * 0.3;
                    const kbX = (p.x - bx) / d;
                    const kbY = (p.y - by) / d;
                    p.x += kbX * kbDist;
                    p.y += kbY * kbDist;
                    p.x = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.x));
                    p.y = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.y));

                    // Check death from explosion
                    if (p.radius < MIN_RADIUS) {
                        saveScore(p.name, Math.floor(p.score));
                        io.to(p.id).emit('died', { killedBy: `a ${npc.tier} NPC explosion!` });
                        players[p.id] = spawnPlayer(p.id, p.name, p.team);
                    }
                }
            });

            // If killed by players (not timeout), give bonus to last hitter
            if (npc.radius < 10) {
                // Bonus score already given per bullet hit above
            }

            npc.dead = true;
        }
    });

    // Remove dead NPCs
    npcs = npcs.filter(n => !n.dead);

    // Update explosion timers
    explosions.forEach(e => e.timer--);
    explosions = explosions.filter(e => e.timer > 0);

    // Clean up dead bullets
    bullets = bullets.filter(b => !b.dead);

    io.emit('update', { players, food, bullets, zones, highScores, npcs, explosions });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
