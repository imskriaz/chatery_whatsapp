// src/services/whatsapp/WhatsAppSession.js

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

const Utilities = require('./Utilities'); // ← NEW: import Utilities
const wsManager = require('../websocket/WebSocketManager');
const DatabaseStore = require('../../stores/DatabaseStore');

const WebhookManager = require('./WebhookManager');
const GroupManager   = require('./GroupManager');
const MessageManager = require('./MessageManager');
const ChatManager    = require('./ChatManager');

class WhatsAppSession {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.socket = null;
    this.qrCode = null;
    this.connectionStatus = 'disconnected';

    this.authFolder = path.join(process.cwd(), 'sessions', sessionId);
    this.configFile = path.join(this.authFolder, 'config.json');
    this.mediaFolder = path.join(process.cwd(), 'public', 'media', sessionId);

    this.phoneNumber = null;
    this.name = null;

    this.metadata = options.metadata || {};
    this.webhooks  = options.webhooks  || [];
    this.username  = options.username  || null;

    // Reconnection control
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 8;
    this.reconnectDelayBase = 5000; // 5 seconds base

    console.log(`[${this.sessionId}] WhatsAppSession initialized for ${this.username || 'unknown'}`);

    this._loadConfig();
    this.db = new DatabaseStore(this.sessionId, this.username);

    // Managers
    this.webhook = new WebhookManager(this);
    this.group   = new GroupManager(this);
    this.message = new MessageManager(this);
    this.chat    = new ChatManager(this);
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        this.metadata = { ...this.metadata, ...cfg.metadata };
        this.webhooks = cfg.webhooks || this.webhooks;
        this.username = cfg.username  || this.username;
      }
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to load config: ${err.message}`);
    }
  }

  _saveConfig() {
    try {
      fs.mkdirSync(this.authFolder, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify({
        metadata: this.metadata,
        webhooks: this.webhooks,
        username: this.username
      }, null, 2));
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to save config: ${err.message}`);
    }
  }

  updateConfig(options = {}) {
    if (options.metadata) this.metadata = { ...this.metadata, ...options.metadata };
    if (options.webhooks !== undefined) this.webhooks = options.webhooks;
    if (options.username) this.username = options.username;
    this._saveConfig();
    return this.getInfo();
  }

  async connect() {
    if (this.connectionStatus === 'connected' && this.socket) {
      return { success: true, message: 'Already connected' };
    }

    if (this.connectionStatus === 'connecting') {
      return { success: false, message: 'Connection already in progress' };
    }

    try {
      this.connectionStatus = 'connecting';
      wsManager.emitConnectionStatus(this.sessionId, 'connecting');

      if (!fs.existsSync(this.authFolder)) {
        fs.mkdirSync(this.authFolder, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Chatery API', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        printQRInTerminal: false,
      });

      this.db.bind(this.socket.ev);

      this._setupEventListeners(saveCreds);

      // Reset reconnect counter on successful manual connect
      this.reconnectAttempts = 0;

      return { success: true, message: 'Connection initializing...' };
    } catch (err) {
      console.error(`[${this.sessionId}] connect failed:`, err.message);
      this.connectionStatus = 'error';
      return { success: false, message: err.message };
    }
  }

  _setupEventListeners(saveCreds) {
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          this.qrCode = await qrcode.toDataURL(qr);
          this.connectionStatus = 'qr_ready';
          wsManager.emitQRCode(this.sessionId, this.qrCode);
          this.webhook.send('qr', { qrCode: this.qrCode });
        } catch (qrErr) {
          console.error(`[${this.sessionId}] QR generation failed:`, qrErr.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.connectionStatus = 'disconnected';
        this.qrCode = null;

        wsManager.emitConnectionStatus(this.sessionId, 'disconnected', {
          reason: lastDisconnect?.error?.message || 'Connection closed',
          shouldReconnect,
          attempt: this.reconnectAttempts + 1
        });

        this.webhook.send('connection.update', {
          status: 'disconnected',
          reason: lastDisconnect?.error?.message || 'Connection closed',
          shouldReconnect
        });

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelayBase * Math.pow(1.6, this.reconnectAttempts - 1);
          console.log(`[${this.sessionId}] Reconnecting in ${Math.round(delay/1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

          setTimeout(() => this.connect(), delay);
        } else if (!shouldReconnect) {
          console.log(`[${this.sessionId}] Logged out permanently — no reconnect`);
          wsManager.emitLoggedOut(this.sessionId);
          this.deleteAuthFolder();
        } else {
          console.warn(`[${this.sessionId}] Max reconnect attempts reached (${this.maxReconnectAttempts})`);
        }
      }
      else if (connection === 'open') {
        this.connectionStatus = 'connected';
        this.qrCode = null;
        this.reconnectAttempts = 0;

        if (this.socket.user) {
          this.phoneNumber = this.socket.user.id.split(':')[0];
          this.name = this.socket.user.name || null;
        }

        wsManager.emitConnectionStatus(this.sessionId, 'connected', {
          phoneNumber: this.phoneNumber,
          name: this.name
        });

        this.webhook.send('connection.update', {
          status: 'connected',
          phoneNumber: this.phoneNumber,
          name: this.name
        });

        console.log(`[${this.sessionId}] Connected successfully as ${this.name || 'unknown'} (${this.phoneNumber || 'unknown'})`);
      }
      else if (connection === 'connecting') {
        this.connectionStatus = 'connecting';
        wsManager.emitConnectionStatus(this.sessionId, 'connecting');
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

    // Messages
    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      messages.forEach(msg => {
        if (msg.message) {
          this.message._autoSaveMedia(msg).catch(e => console.error('Media save failed:', e));
          const formatted = this.message.formatMessage(msg);
          if (formatted) {
            wsManager.emitMessage(this.sessionId, formatted);
            this.webhook.send('message', formatted);
          }
        }
      });
    });

    this.socket.ev.on('messages.update', updates => {
      wsManager.emitMessageStatus(this.sessionId, updates);
      this.webhook.send('message.update', updates);
    });

    // Chats / Groups / Contacts
    this.socket.ev.on('chats.upsert',   chats => wsManager.emitChatsUpsert(this.sessionId, chats));
    this.socket.ev.on('chats.update',   chats => wsManager.emitChatUpdate(this.sessionId, chats));
    this.socket.ev.on('chats.delete',   ids   => wsManager.emitChatDelete(this.sessionId, ids));

    this.socket.ev.on('group-participants.update', update => {
      wsManager.emitGroupParticipants(this.sessionId, update);
      this.webhook.send('group.participants', update);
    });

    this.socket.ev.on('groups.update', updates => {
      wsManager.emitGroupUpdate(this.sessionId, updates);
      this.webhook.send('group.update', updates);
    });

    // Other
    this.socket.ev.on('presence.update', p => wsManager.emitPresence(this.sessionId, p));
    this.socket.ev.on('call', calls => wsManager.emitCall(this.sessionId, calls));
  }

  getInfo() {
    return {
      sessionId: this.sessionId,
      status: this.connectionStatus,
      isConnected: this.connectionStatus === 'connected',
      phoneNumber: this.phoneNumber,
      name: this.name,
      qrCode: this.qrCode,
      metadata: this.metadata,
      webhooks: this.webhooks,
      username: this.username,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts
    };
  }

  async logout() {
    try {
      // Prevent further reconnect attempts
      this.reconnectAttempts = this.maxReconnectAttempts + 1;

      if (this.socket) {
        await this.socket.logout().catch(e => console.warn('Logout socket error:', e));
        this.socket = null;
      }

      this.deleteMediaFolder();
      this.deleteAuthFolder();

      try {
        if (this.db?.deleteSession) {
          await this.db.deleteSession(this.sessionId);
        }
      } catch (dbErr) {
        console.warn(`[${this.sessionId}] DB cleanup failed:`, dbErr.message);
      }

      this.connectionStatus = 'disconnected';
      this.qrCode = null;
      this.phoneNumber = null;
      this.name = null;

      wsManager.emitLoggedOut(this.sessionId);
      this.webhook.send('logged.out', { message: 'Session logged out' });

      return { success: true, message: 'Logged out successfully' };
    } catch (err) {
      console.error(`[${this.sessionId}] logout failed:`, err.message);
      return { success: false, message: err.message || 'Logout failed' };
    }
  }

  deleteAuthFolder() {
    try {
      if (fs.existsSync(this.authFolder)) {
        fs.rmSync(this.authFolder, { recursive: true, force: true });
        console.log(`[${this.sessionId}] Auth folder deleted`);
      }
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to delete auth folder:`, err.message);
    }
  }

  deleteMediaFolder() {
    try {
      if (fs.existsSync(this.mediaFolder)) {
        fs.rmSync(this.mediaFolder, { recursive: true, force: true });
        console.log(`[${this.sessionId}] Media folder deleted`);
      }
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to delete media folder:`, err.message);
    }
  }

  formatPhoneNumber(phone) {
    const norm = Utilities.normalizePhoneNumber(phone);
    return norm.valid ? norm.normalized + '@s.whatsapp.net' : null;
  }

  formatJid(id, preferGroup = false) {
    return Utilities.toJid(id, preferGroup);
  }

  formatChatId(chatId) {
    return Utilities.toJid(chatId);
  }

  isGroupId(jid) {
    return Utilities.isGroupJid(jid);
  }
}

module.exports = WhatsAppSession;