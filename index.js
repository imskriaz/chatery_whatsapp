const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./src/config/swagger');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Import Routes
const whatsappRoutes = require('./src/routes');

// Import Middleware
const userAuth = require('./src/UserAuth');

// Import WebSocket Manager
const wsManager = require('./src/WebSocketManager');

// Initialize WebSocket
wsManager.initialize(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*'
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public folder (for media access)
app.use('/media', express.static(path.join(__dirname, 'public', 'media')));
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────
// Renamed paths (only UI & Admin)
// ────────────────────────────────────────────────

// Main UI (WhatsApp interface) → /ui
app.get('/ui', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ui.html'));
});

// Admin Dashboard → /admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));  // ← rename your dashboard.html to admin.html if needed
});

// WebSocket test page (keep as-is)
app.get('/ws-test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'websocket-test.html'));
});

// ────────────────────────────────────────────────
// Swagger Documentation (moved to /docs)
// ────────────────────────────────────────────────
const swaggerUiOptions = {
    customCss: `
        .swagger-ui .topbar { display: none }
        .swagger-ui .info { margin: 20px 0 }
        .swagger-ui .info .title { color: #25D366 }
    `,
    customSiteTitle: 'Chatery WhatsApp API - Documentation',
    customfavIcon: '/media/favicon.ico'
};

app.use('/docs', swaggerUi.serve);
app.get('/docs', swaggerUi.setup(swaggerSpec, swaggerUiOptions));

// Swagger JSON endpoint
app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

// ────────────────────────────────────────────────
// Health check & other root-level endpoints (unchanged)
// ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// ────────────────────────────────────────────────
// Admin / Dashboard Login (unchanged endpoint)
// ────────────────────────────────────────────────
app.post('/api/dashboard/login', (req, res) => {
    const { username, password } = req.body;
    
    const validUsername = process.env.DASHBOARD_USERNAME || 'admin';
    const validPassword = process.env.DASHBOARD_PASSWORD || 'admin123';
    
    if (username === validUsername && password === validPassword) {
        res.json({
            success: true,
            message: 'Login successful'
        });
    } else {
        res.status(401).json({
            success: false,
            message: 'Invalid username or password'
        });
    }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await userAuth.authenticate({ username, password });

  if (!result.success) {
    return res.status(401).json(result);
  }

  res.json({
    success: true,
    key: result.user.apiKey,
    username: result.user.username,
    role: result.user.role
  });
});

app.post('/api/admin/users', userAuth.validate, userAuth.isAdmin, async (req, res) => {
  const result = await userAuth.createUser(req.body);
  res.status(result.success ? 201 : 400).json(result);
});

app.patch('/api/admin/users/:username', userAuth.validate, userAuth.isAdmin, async (req, res) => {
  const result = await userAuth.updateUser(req.params.username, req.body);
  res.json(result);
});

app.get('/api/admin/users', userAuth.validate, userAuth.isAdmin, async (req, res) => {
  try {
    const usersList = await userAuth.listUsers();
    res.json({
      success: true,
      data: usersList
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to list users' });
  }
});

app.get('/api/admin/users/:username', userAuth.validate, userAuth.isAdmin, async (req, res) => {
  const result = await userAuth.getUser({ username: req.params.username });
  if (!result.success) {
    return res.status(404).json(result);
  }
  res.json(result);
});

app.get('/api/admin/users/me', userAuth.validate, (req, res) => {
  res.json({
    success: true,
    data: {
      username: req.user.username,
      role: req.user.role,
      apiKey: req.user.apiKey
    }
  });
});

app.use('/api/whatsapp', userAuth.validate, whatsappRoutes);

// ────────────────────────────────────────────────
// WebSocket Stats (unchanged)
// ────────────────────────────────────────────────
app.get('/api/websocket/stats', (req, res) => {
    res.json({
        success: true,
        data: wsManager.getStats()
    });
});

// ────────────────────────────────────────────────
// 404 Handler
// ────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: 'Internal Server Error'
    });
});

// ────────────────────────────────────────────────
// Start Server
// ────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`WhatsApp API running on http://localhost:${PORT}`);
    console.log(`Main UI (WhatsApp):      http://localhost:${PORT}/ui`);
    console.log(`Admin Dashboard:         http://localhost:${PORT}/admin`);
    console.log(`API Documentation:       http://localhost:${PORT}/docs`);
});