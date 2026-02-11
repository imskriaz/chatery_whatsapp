// src/middleware/userAuth.js
const DatabaseStore = require('./DatabaseStore');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const db = new DatabaseStore(); // "global" session

const SALT_ROUNDS = 12;

const userAuth = {
  /**
   * Authenticate user by username + password
   * Used mainly by /api/login
   */
  async authenticate({ username, password }) {
    if (!username?.trim() || !password?.trim()) {
      return { success: false, message: 'Username and password are required' };
    }

    const trimmedUsername = username.trim().toLowerCase();
    const trimmedPassword = password.trim();

    try {
      const rows = await db.mysqlQuery(
        "SELECT username, password, role, api_key FROM users WHERE username = ? LIMIT 1",
        [trimmedUsername]
      );

      if (rows.length === 0) {
        return { success: false, message: 'Invalid credentials' };
      }

      const user = rows[0];
      const passwordMatch = await bcrypt.compare(trimmedPassword, user.password);

      if (!passwordMatch) {
        return { success: false, message: 'Invalid credentials' };
      }

      return {
        success: true,
        user: {
          username: user.username,
          role: user.role,
          apiKey: user.api_key
        }
      };
    } catch (err) {
      console.error('Authentication error:', err);
      return { success: false, message: 'Server error during authentication' };
    }
  },

  /**
   * Validate API key (for protected WhatsApp routes)
   */
  async validate(req, res, next) {
    const apiKey = req.headers['x-api-key']?.trim();

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        message: 'Missing X-Api-Key header'
      });
    }

    // Allow hardcoded dashboard key bypass (for admin panel internal calls if needed)
    const dashboardApiKey = process.env.API_KEY;
    if (dashboardApiKey && dashboardApiKey === apiKey) {
      const username = process.env.DASHBOARD_USERNAME || 'dashboard';
      req.user = { username, apiKey, role: 'admin' };
      return next();
    }

    try {
      const rows = await db.mysqlQuery(
        "SELECT username, role, api_key FROM users WHERE api_key = ? LIMIT 1",
        [apiKey]
      );

      if (rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired API key'
        });
      }

      req.user = {
        username: rows[0].username,
        apiKey,
        role: rows[0].role
      };

      next();
    } catch (err) {
      console.error('API key validation error:', err);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during authentication'
      });
    }
  },

  /**
   * Create new user (admin only)
   * @param {Object} data - { username, password, role? }
   */
  async createUser({ username, password, role = 'user' }) {
    if (!username?.trim() || !password?.trim()) {
      return { success: false, message: 'Username and password required' };
    }

    const trimmedUsername = username.trim().toLowerCase();

    if (password.length < 8) {
      return { success: false, message: 'Password must be at least 8 characters' };
    }

    const validRoles = ['user', 'moderator', 'admin'];
    const finalRole = validRoles.includes(role) ? role : 'user';

    try {
      // Check if user exists
      const existing = await db.mysqlQuery(
        "SELECT username FROM users WHERE username = ? LIMIT 1",
        [trimmedUsername]
      );

      if (existing.length > 0) {
        return { success: false, message: 'Username already taken' };
      }

      const hashedPassword = await bcrypt.hash(password.trim(), SALT_ROUNDS);
      const apiKey = crypto.randomBytes(32).toString('hex');

      await db.mysqlQuery(
        "INSERT INTO users (username, password, role, api_key) VALUES (?, ?, ?, ?)",
        [trimmedUsername, hashedPassword, finalRole, apiKey]
      );

      return {
        success: true,
        message: 'User created',
        data: { username: trimmedUsername, role: finalRole, apiKey }
      };
    } catch (err) {
      console.error('Create user error:', err);
      return { success: false, message: 'Failed to create user' };
    }
  },

  /**
   * Update existing user (admin only)
   * Supports updating password, role
   */
  async updateUser(username, { password, role }) {
    const trimmedUsername = username.trim().toLowerCase();

    try {
      const updates = [];
      const params = [];

      if (password?.trim()) {
        if (password.trim().length < 8) {
          return { success: false, message: 'Password must be at least 8 characters' };
        }
        const hashed = await bcrypt.hash(password.trim(), SALT_ROUNDS);
        updates.push('password = ?');
        params.push(hashed);
      }

      if (role) {
        const validRoles = ['user', 'moderator', 'admin'];
        if (!validRoles.includes(role)) {
          return { success: false, message: 'Invalid role' };
        }
        updates.push('role = ?');
        params.push(role);
      }

      if (updates.length === 0) {
        return { success: false, message: 'No fields to update' };
      }

      params.push(trimmedUsername);

      const query = `UPDATE users SET ${updates.join(', ')} WHERE username = ?`;
      const result = await db.mysqlQuery(query, params);

      if (result.affectedRows === 0) {
        return { success: false, message: 'User not found' };
      }

      return { success: true, message: 'User updated' };
    } catch (err) {
      console.error('Update user error:', err);
      return { success: false, message: 'Failed to update user' };
    }
  },

  /**
   * List all users (admin only) - without passwords
   */
  async listUsers() {
    try {
      const rows = await db.mysqlQuery(
        "SELECT username, role, api_key, created_at FROM users ORDER BY username"
      );
      return rows;
    } catch (err) {
      console.error('List users error:', err);
      throw err;
    }
  },

  /**
   * Get single user by username
   */
  async getUser({ username }) {
    try {
      const rows = await db.mysqlQuery(
        "SELECT username, role, api_key, created_at FROM users WHERE username = ? LIMIT 1",
        [username.trim().toLowerCase()]
      );

      if (rows.length === 0) {
        return { success: false, message: 'User not found' };
      }

      return { success: true, data: rows[0] };
    } catch (err) {
      console.error('Get user error:', err);
      return { success: false, message: 'Server error' };
    }
  },

  isAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin access required' });
    next();
  },

  isModOrAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (!['admin', 'moderator'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Moderator or Admin access required' });
    }
    next();
  }
};

module.exports = userAuth;