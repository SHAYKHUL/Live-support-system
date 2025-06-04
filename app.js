require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3001;
const MAX_VISITORS_PER_AGENT = 3;
const VISITOR_IDLE_TIMEOUT = 60000; // 1 minute idle timeout for visitors
const AGENT_IDLE_TIMEOUT = 120000; // 2 minutes idle timeout for agents

// === SQLite Database Setup ===
const db = new sqlite3.Database('./chat-app.db', (err) => {
    if (err) {
        console.error("Error opening database:", err);
    } else {
        console.log("Connected to the SQLite database.");

        db.run(`CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            active BOOLEAN DEFAULT 1,
            current_load INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS visitor_assignments (
            visitor_id TEXT NOT NULL,
            agent_id INTEGER NOT NULL,
            PRIMARY KEY (visitor_id, agent_id)
        )`);
    }
});

// === Logging ===
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'chat-app.log' })
    ]
});

// === Middlewares ===
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'default-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// === Rate Limiter ===
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { success: false, message: 'Too many login attempts, try again later.' }
});

// === Dummy Login System ===
let agents = {}; // socketId => { username, visitors: [], available: true, currentLoad: 0 }
let visitors = {}; // socketId => socket
let visitorAssignments = {}; // visitorSocketId => agentSocketId
let visitorQueue = []; // List of waiting visitors

// === Views ===
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/html/login.html'));
});

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM agents WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err) {
            console.error("Error checking credentials:", err);
            return res.status(500).json({ success: false, message: 'Internal Server Error' });
        }
        if (row) {
            req.session.agent = username;
            return res.json({ success: true });
        }
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    });
});

app.get('/agent', (req, res) => {
    if (!req.session.agent) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public/html/agent.html'));
});

app.get('/visitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/html/visitor.html'));
});

// Serve the main website's index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/html/index.html'));
});

app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// === Socket.IO Auth ===
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === process.env.SOCKET_AUTH_TOKEN) {
        return next();
    }
    return next(new Error('Unauthorized'));
});

// === Helper: Update Queue to All Agents ===
function updateVisitorQueue() {
    io.emit('visitor_queue_update', { queue: [...visitorQueue] });
}

// === Helper: Assign Visitor to Agent ===
function assignVisitorToAgent(visitorId, agentId) {
    const agent = agents[agentId];
    const visitorSocketId = Object.keys(visitors).find(
        key => visitors[key].visitorId === visitorId
    );

    if (!agent || !visitorSocketId) {
        logger.warn(`Failed to assign visitor: agent=${agentId}, visitor=${visitorId}`);
        return;
    }

    // Assign visitor to agent and remove from queue
    agent.visitors.push(visitorId);
    agent.currentLoad++; // Increment agent's load
    visitorAssignments[visitorId] = agentId; // Map visitorId to agentId
    visitorQueue = visitorQueue.filter(id => id !== visitorId);

    io.to(visitorSocketId).emit('assigned', { agentId });
    io.to(agentId).emit('new_visitor', { visitorId });

    updateVisitorQueue();
    logger.info(`Visitor ${visitorId} assigned to agent ${agentId}.`);
}

// === Helper: Get Available Agents ===
function getAvailableAgents() {
    return Object.entries(agents)
        .filter(([_, agent]) => agent.active)
        .map(([socketId, agent]) => ({ socketId, username: agent.username }));
}

// === Helper: Update Available Agents ===
function updateAvailableAgents() {
    const availableAgents = getAvailableAgents();
    io.emit('available_agents_update', { agents: availableAgents });
}

// === Main Socket.IO Handling ===
io.on('connection', socket => {
    logger.info(`Socket connected: ${socket.id}`);

    // === Visitor Joins ===
    socket.on('visitor_join', ({ visitorId, visitorName, visitorEmail }) => {
        if (!visitorId || !visitorName || !visitorEmail) return;

        // Check if the visitor is already connected
        if (Object.values(visitors).some(visitorSocket => visitorSocket.visitorId === visitorId)) {
            logger.info(`Duplicate visitor detected: ${visitorId}`);
            return;
        }

        visitors[socket.id] = { socket, visitorId, visitorName, visitorEmail };

        if (!visitorAssignments[visitorId]) {
            if (!visitorQueue.includes(visitorId)) {
                visitorQueue.push(visitorId);
            }

            updateVisitorQueue();

            // Notify all available agents of waiting visitors (for real-time assignment)
            const availableAgents = Object.entries(agents).filter(([agentId, agent]) => {
                return agent.currentLoad < MAX_VISITORS_PER_AGENT && agent.active;
            });

            // Sort agents based on current load
            availableAgents.sort(([idA, agentA], [idB, agentB]) => agentA.currentLoad - agentB.currentLoad);

            availableAgents.forEach(([agentId]) => {
                io.to(agentId).emit('incoming_call', { visitorId, visitorName, visitorEmail });
            });
        }
    });

    // === Agent Joins ===
    socket.on('agent_join', (username) => {
        if (!username) return socket.disconnect();

        agents[socket.id] = {
            username,
            visitors: [],
            active: true,
            currentLoad: 0
        };

        logger.info(`Agent ${username} joined`);

        socket.emit('agent_ready');
        updateVisitorQueue();
        updateAvailableAgents(); // Update the list of available agents

        // Assign any waiting visitors to the agent if they have space
        if (agents[socket.id].active) {
            visitorQueue.forEach(visitorId => {
                if (agents[socket.id].currentLoad < MAX_VISITORS_PER_AGENT) {
                    assignVisitorToAgent(visitorId, socket.id);
                }
            });
        }
    });

    // === Manual Accept by Agent ===
    socket.on('accept_visitor', ({ visitorId }) => {
        const agent = agents[socket.id];

        // Find the visitor's socket ID using the visitorId
        const visitorSocketId = Object.keys(visitors).find(
            key => visitors[key].visitorId === visitorId
        );

        if (!agent || !visitorSocketId) {
            logger.warn(`Agent or visitor not found for accept_visitor: agent=${socket.id}, visitor=${visitorId}`);
            return;
        }

        const visitor = visitors[visitorSocketId];

        // Check if the visitor is already assigned
        if (visitorAssignments[visitorId]) {
            socket.emit('call_taken', { visitorId });
            logger.info(`Visitor ${visitorId} is already assigned to an agent.`);
            return;
        }

        // Check if the agent has reached their maximum capacity
        if (agent.visitors.length >= MAX_VISITORS_PER_AGENT) {
            socket.emit('max_capacity_reached', { message: 'Agent at full capacity' });
            logger.warn(`Agent ${socket.id} is at full capacity.`);
            return;
        }

        // Assign the visitor to the agent
        assignVisitorToAgent(visitorId, socket.id);
        logger.info(`Visitor ${visitorId} assigned to agent ${socket.id}.`);

        // Update the visitor queue
        updateVisitorQueue();
    });

    // === Agent Availability Toggle ===
    socket.on('toggle_availability', ({ available }) => {
        if (!agents[socket.id]) return;
        agents[socket.id].active = available;

        updateAvailableAgents(); // Update the list of available agents

        // Notify available agents and reassign visitors if necessary
        if (available) {
            visitorQueue.forEach(visitorId => {
                if (agents[socket.id].currentLoad < MAX_VISITORS_PER_AGENT) {
                    assignVisitorToAgent(visitorId, socket.id);
                }
            });
        }
    });

    // === End Chat (Agent ends the session) ===
    socket.on('end_chat', (visitorId) => {
        const agentId = visitorAssignments[visitorId];
        if (!agentId || agentId !== socket.id) {
            logger.warn(`Unauthorized end_chat attempt: agent=${socket.id}, visitor=${visitorId}`);
            return;
        }

        // Notify visitor and agent that the chat is ended
        io.to(visitorId).emit('chat_ended', { message: 'The chat session has ended.' });
        io.to(agentId).emit('chat_ended', { message: 'You have ended the chat session.' });

        // Free up the agent
        const agent = agents[agentId];
        if (agent) {
            agent.currentLoad--;
            agent.visitors = agent.visitors.filter(id => id !== visitorId);
        }

        // Remove the visitor from the active sessions
        delete visitorAssignments[visitorId];

        // Update the visitor queue
        updateVisitorQueue();
        logger.info(`Chat session ended: agent=${agentId}, visitor=${visitorId}`);
    });

    // === Visitor Sends a Message ===
    socket.on('visitor_message', ({ message, visitorId }) => {
        const agentId = visitorAssignments[visitorId];
        if (!agentId) {
            logger.warn(`No agent assigned to visitor ${visitorId}`);
            return;
        }

        const agentSocketId = Object.keys(agents).find(
            key => agents[key].username === agents[agentId].username
        );

        if (!agentSocketId) {
            logger.warn(`Agent socket not found for visitor ${visitorId}`);
            return;
        }

        // Relay the message to the assigned agent
        io.to(agentSocketId).emit('new_message', {
            from: visitorId,
            message,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // === Agent Sends a Message ===
    socket.on('agent_message', ({ toVisitorId, message }) => {
        const agent = agents[socket.id];
        if (!agent) {
            logger.warn(`Agent ${socket.id} not found`);
            return;
        }

        // Find the visitor's socket ID using the visitorId
        const visitorSocketId = Object.keys(visitors).find(
            key => visitors[key].visitorId === toVisitorId
        );

        if (!visitorSocketId) {
            logger.warn(`Visitor socket not found for visitor ${toVisitorId}`);
            return;
        }

        // Relay the message to the visitor
        io.to(visitorSocketId).emit('new_message', {
            from: agent.username,
            message,
            timestamp: new Date().toLocaleTimeString()
        });

        logger.info(`Message sent from agent ${agent.username} to visitor ${toVisitorId}`);
    });

    // === Disconnection Handling ===
    socket.on('disconnect', () => {
        logger.info(`Disconnected: ${socket.id}`);

        // Agent Disconnection Handling
        if (agents[socket.id]) {
            const agent = agents[socket.id];

            // Reassign visitors to other available agents
            agent.visitors.forEach(visitorId => {
                delete visitorAssignments[visitorId];
                if (visitors[visitorId]) {
                    // Assign the visitor to a new available agent
                    let reassigned = false;
                    for (const [newAgentId, newAgent] of Object.entries(agents)) {
                        if (newAgent.active && newAgent.currentLoad < MAX_VISITORS_PER_AGENT) {
                            assignVisitorToAgent(visitorId, newAgentId);
                            reassigned = true;
                            break;
                        }
                    }
                    if (!reassigned) {
                        visitorQueue.push(visitorId); // Re-add to the queue
                    }
                }
            });

            delete agents[socket.id];
            updateVisitorQueue();
            updateAvailableAgents();
        }

        // Visitor Disconnection Handling
        if (visitors[socket.id]) {
            const visitorId = socket.id;
            delete visitors[socket.id];
            delete visitorAssignments[visitorId];

            // Update visitor queue
            visitorQueue = visitorQueue.filter(id => id !== visitorId);
            updateVisitorQueue();
        }
    });
});

// === Start Server ===
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
