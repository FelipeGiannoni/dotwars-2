const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const nicknameInput = document.getElementById('nickname');
const startBtn = document.getElementById('start-btn');
const loginScreen = document.getElementById('login-screen');
const gameUI = document.getElementById('game-ui');
const scoreEl = document.getElementById('score');
const leaderboardList = document.getElementById('leaderboard-list');

let myId = null;
let mapSize = 1200;
let players = {};
let food = [];
let bullets = [];
let zones = [];
let camera = { x: 0, y: 0 };

// Resize canvas
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

startBtn.addEventListener('click', () => {
    const name = nicknameInput.value.trim();
    socket.emit('join', name);
    loginScreen.classList.add('hidden');
    gameUI.classList.remove('hidden');
});

socket.on('init', (data) => {
    mapSize = data.mapSize;
    myId = data.id;
});

socket.on('update', (data) => {
    // Update target positions for interpolation instead of snapping
    Object.keys(data.players).forEach(id => {
        if (!players[id]) {
            players[id] = data.players[id]; // Initial load for new player
        } else {
            // Update target properties for lerping
            players[id].targetX = data.players[id].x;
            players[id].targetY = data.players[id].y;
            // Shield and bullet aim vector
            players[id].aimX = data.players[id].aimX;
            players[id].aimY = data.players[id].aimY;
            players[id].radius = data.players[id].radius; // Snap radius, or lerp it too
            players[id].score = data.players[id].score;
            players[id].name = data.players[id].name;
            players[id].team = data.players[id].team;
            players[id].shieldActive = data.players[id].shieldActive;
        }
    });

    // Remove disconnected players
    Object.keys(players).forEach(id => {
        if (!data.players[id]) {
            delete players[id];
        }
    });

    food = data.food;
    bullets = data.bullets || [];
    zones = data.zones || [];

    if (myId && players[myId]) {
        const me = players[myId];
        scoreEl.innerText = `Score: ${Math.floor(me.score)}`;
    }

    updateLeaderboard();
});

socket.on('died', (data) => {
    alert(`You were eaten by ${data.killedBy}!`);
    location.reload();
});

// Input handling
window.addEventListener('mousemove', (e) => {
    if (!myId || !players[myId]) return;

    // Vector from center of screen (player position logically) to mouse
    // This gives us the exact angle the player is aiming
    const dx = e.clientX - canvas.width / 2;
    const dy = e.clientY - canvas.height / 2;
    const angle = Math.atan2(dy, dx);

    // Send normalized direction for both movement and aiming
    socket.emit('move', {
        x: Math.cos(angle), // Movement vector X
        y: Math.sin(angle), // Movement vector Y
        aimX: Math.cos(angle), // Aim vector X
        aimY: Math.sin(angle)  // Aim vector Y
    });
});

window.addEventListener('mousedown', (e) => {
    if (!myId || !players[myId]) return;

    // Left click (0) = shoot, Right click (2) = shield
    if (e.button === 0) {
        socket.emit('action', { type: 'shoot' });
    } else if (e.button === 2) {
        socket.emit('action', { type: 'shield_on' });
    }
});

window.addEventListener('mouseup', (e) => {
    if (e.button === 2) {
        socket.emit('action', { type: 'shield_off' });
    }
});

// Prevent right click menu
window.addEventListener('contextmenu', e => e.preventDefault());

function updateLeaderboard() {
    const sorted = Object.values(players).sort((a, b) => b.score - a.score).slice(0, 5);
    leaderboardList.innerHTML = sorted.map((p, i) => {
        const teamClass = p.team === 'red' ? 'team-red' : 'team-blue';
        return `
            <li>
                <span class="lb-rank">#${i + 1}</span>
                <span class="lb-name ${teamClass}">${p.name}</span>
                <span class="lb-score">${Math.floor(p.score)}</span>
            </li>
        `;
    }).join('');
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Lerp Speed (0.1 means move 10% of the distance per frame)
    const LERP_FACTOR = 0.2;

    // Apply Lerp to all players
    Object.values(players).forEach(p => {
        if (p.targetX !== undefined && p.targetY !== undefined) {
            p.x += (p.targetX - p.x) * LERP_FACTOR;
            p.y += (p.targetY - p.y) * LERP_FACTOR;
        }
    });

    if (myId && players[myId]) {
        const me = players[myId];
        // Lerp camera
        camera.x += (me.x - camera.x) * LERP_FACTOR;
        camera.y += (me.y - camera.y) * LERP_FACTOR;
    }

    const offX = canvas.width / 2 - camera.x;
    const offY = canvas.height / 2 - camera.y;

    // Draw Zones
    zones.forEach(z => {
        // Base zone color
        if (z.owner === 'red') ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
        else if (z.owner === 'blue') ctx.fillStyle = 'rgba(0, 150, 255, 0.15)';
        else ctx.fillStyle = 'rgba(100, 100, 100, 0.1)';

        ctx.fillRect(z.x + offX, z.y + offY, z.size, z.size);

        // Draw capture progress if contested
        if (z.captureProgress > 0 && z.capturingTeam) {
            const h = z.size * (z.captureProgress / 100);
            ctx.fillStyle = z.capturingTeam === 'red' ? 'rgba(255, 0, 0, 0.3)' : 'rgba(0, 150, 255, 0.3)';
            // Draw from bottom up
            ctx.fillRect(z.x + offX, z.y + z.size - h + offY, z.size, h);
        }

        // Zone borders
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.strokeRect(z.x + offX, z.y + offY, z.size, z.size);
    });

    // Draw grid
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    const step = 50;
    for (let x = 0; x <= mapSize; x += step) {
        ctx.beginPath();
        ctx.moveTo(x + offX, offY);
        ctx.lineTo(x + offX, mapSize + offY);
        ctx.stroke();
    }
    for (let y = 0; y <= mapSize; y += step) {
        ctx.beginPath();
        ctx.moveTo(offX, y + offY);
        ctx.lineTo(mapSize + offX, y + offY);
        ctx.stroke();
    }

    // Draw food
    food.forEach(f => {
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(f.x + offX, f.y + offY, f.radius, 0, Math.PI * 2);
        ctx.fill();
    });

    // Draw bullets
    bullets.forEach(b => {
        // Red team bullet color check by hex/hsl isn't strictly necessary, but we can just use yellow/white so it pops
        ctx.fillStyle = b.amplified ? '#ffea00' : '#fff';
        ctx.beginPath();
        ctx.arc(b.x + offX, b.y + offY, b.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = b.team === 'red' ? '#ff4d4d' : '#4da6ff';
        ctx.lineWidth = 2;
        ctx.stroke();
    });

    // Draw players
    Object.values(players).forEach(p => {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        // Prevent drawing if coordinates are NaN (happens before first update)
        if (isNaN(p.x) || isNaN(p.y)) return;

        ctx.arc(p.x + offX, p.y + offY, p.radius, 0, Math.PI * 2);
        ctx.fill();

        // Outline corresponds to team
        ctx.strokeStyle = p.team === 'red' ? '#ff0000' : '#00aeff';
        ctx.lineWidth = 4;
        ctx.stroke();

        // Draw Shield (Straight Line)
        if (p.shieldActive && p.aimX !== undefined && p.aimY !== undefined) {
            ctx.strokeStyle = p.team === 'red' ? 'rgba(255, 100, 100, 0.8)' : 'rgba(100, 200, 255, 0.8)';
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            ctx.beginPath();

            // Perpendicular to the aim vector
            const perpX = -p.aimY;
            const perpY = p.aimX;

            // Shield center is slightly in front of player
            const shieldCX = p.x + offX + p.aimX * (p.radius + 15);
            const shieldCY = p.y + offY + p.aimY * (p.radius + 15);

            ctx.moveTo(shieldCX + perpX * p.radius, shieldCY + perpY * p.radius);
            ctx.lineTo(shieldCX - perpX * p.radius, shieldCY - perpY * p.radius);
            ctx.stroke();
            ctx.lineCap = 'butt'; // reset
        }

        // Mass / Size Number
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.font = `bold ${Math.max(14, p.radius * 0.5)}px Outfit`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(Math.floor(p.radius), p.x + offX, p.y + offY);

        // Name below player
        ctx.fillStyle = 'white';
        ctx.font = `${Math.max(12, p.radius / 2)}px Outfit`;
        ctx.textBaseline = 'top';
        ctx.fillText(p.name, p.x + offX, p.y + p.radius + offY + 5);
    });

    // Draw Minimap
    drawMinimap();

    requestAnimationFrame(draw);
}

function drawMinimap() {
    const mmSize = 150;
    const mmX = canvas.width - mmSize - 20;
    const mmY = canvas.height - mmSize - 20;
    const scale = mmSize / mapSize;

    // Minimap Background / Frame
    ctx.fillStyle = 'rgba(25, 25, 35, 0.8)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(mmX, mmY, mmSize, mmSize, 8);
    ctx.fill();
    ctx.stroke();

    // Draw Zones on minimap
    zones.forEach(z => {
        if (z.owner === 'red') ctx.fillStyle = 'rgba(255, 50, 50, 0.4)';
        else if (z.owner === 'blue') ctx.fillStyle = 'rgba(50, 150, 255, 0.4)';
        else ctx.fillStyle = 'rgba(100, 100, 100, 0.2)';

        ctx.fillRect(mmX + (z.x * scale), mmY + (z.y * scale), z.size * scale, z.size * scale);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.strokeRect(mmX + (z.x * scale), mmY + (z.y * scale), z.size * scale, z.size * scale);
    });

    // Draw Player dot
    if (myId && players[myId]) {
        const me = players[myId];
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        // Clamping dot to minimap bounds
        const dotX = Math.max(0, Math.min(mapSize, me.x));
        const dotY = Math.max(0, Math.min(mapSize, me.y));
        ctx.arc(mmX + (dotX * scale), mmY + (dotY * scale), 3, 0, Math.PI * 2);
        ctx.fill();

        // Pulse effect
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.beginPath();
        ctx.arc(mmX + (dotX * scale), mmY + (dotY * scale), 6, 0, Math.PI * 2);
        ctx.stroke();
    }
}

draw();
