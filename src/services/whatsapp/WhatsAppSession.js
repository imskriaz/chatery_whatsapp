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

const wsManager = require('../websocket/WebSocketManager');
const DatabaseStore = require('../../stores/DatabaseStore');

const WebhookManager = require('./WebhookManager');
const GroupManager = require('./GroupManager');
const MessageManager = require('./MessageManager');

class WhatsAppSession {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.socket = null;
    this.qrCode = null;
    this.connectionStatus = 'disconnected';
    this.authFolder = path.join(process.cwd(), 'sessions', sessionId);
    this.mediaFolder = path.join(process.cwd(), 'public', 'media', sessionId);

    this.phoneNumber = null;
    this.name = null;
    this.metadata = options.metadata || {};
    this.username = options.username || null;

    this._initialSyncDone = false;
    this._groupCache = null;
    this._groupCacheTTL = 5 * 60 * 1000; // 5 minutes

    console.log(`[${this.sessionId}] WhatsAppSession initialized for ${this.username || 'unknown'}`);

    this._loadConfig();
    this.db = new DatabaseStore(this.sessionId, this.username);

    // Sub-managers (each handles its domain)
    this.webhook = new WebhookManager(this);
    this.group = new GroupManager(this);
    this.message = new MessageManager(this);
  }

  _loadConfig() {
    try {
      const file = path.join(this.authFolder, 'config.json');
      if (fs.existsSync(file)) {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.assign(this.metadata, cfg.metadata || {});
        this.username = cfg.username || this.username;
      }
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to load config: ${err.message}`);
    }
  }

  normalizeJid(input, preferGroup = false) {
    if (!input || typeof input !== 'string') return null;
    let jid = input.trim().replace(/\s+/g, '');
    if (/@(s\.whatsapp\.net|g\.us|c\.us)$/.test(jid)) return jid;
    const digits = jid.replace(/\D/g, '');
    if (digits.length < 9) return null;
    let cc = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
    return cc + (preferGroup ? '@g.us' : '@s.whatsapp.net');
  }

  async connect() {
    if (this.connectionStatus === 'connected' && this.socket) {
      return { success: true, message: 'Already connected' };
    }

    try {
      fs.mkdirSync(this.authFolder, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Chatery API', 'Chrome', '1.0.0'],
        syncFullHistory: false
      });

      this.db.bind(this.socket.ev);
      this._setupCoreListeners(saveCreds);

      return { success: true, message: 'Connection initializing...' };
    } catch (err) {
      console.error(`[${this.sessionId}] connect failed: ${err.message}`);
      this.connectionStatus = 'error';
      return { success: false, message: err.message };
    }
  }

  _setupCoreListeners(saveCreds) {
    this.socket.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

      if (qr) {
        try {
          this.qrCode = await qrcode.toDataURL(qr);
          this.connectionStatus = 'qr_ready';
          wsManager.emitQRCode(this.sessionId, this.qrCode);
          this.webhook.send('qr', { qrDataUrl: this.qrCode });
        } catch (err) {
          console.error(`[${this.sessionId}] QR generation failed: ${err.message}`);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        this.connectionStatus = 'disconnected';
        this.qrCode = null;
        this._initialSyncDone = false;

        wsManager.emitConnectionStatus(this.sessionId, 'disconnected', { shouldReconnect });
        this.webhook.send('connection.update', { status: 'disconnected', shouldReconnect });

        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5000);
        } else {
          await this.logout();
        }
      }

      if (connection === 'open' || receivedPendingNotifications) {
        this.connectionStatus = 'connected';
        this.qrCode = null;

        if (this.socket?.user) {
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

        if (this.socket?.groupFetchAllParticipating) {
          await this._performInitialSync();
        } else {
          console.log(`[${this.sessionId}] Socket not fully ready — deferring sync`);
          setTimeout(() => {
            if (this.socket?.groupFetchAllParticipating) {
              this._performInitialSync();
            }
          }, 1500);
        }
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

    // Forward real-time events to WebSocket manager
    this.socket.ev.on('messages.upsert', ev => {
      wsManager.emitMessage(this.sessionId, ev);
      // Auto-save media is handled in MessageManager
      ev.messages?.forEach(msg => this.message._autoSaveMedia(msg).catch(() => { }));
    });

    this.socket.ev.on('messages.update', ev => wsManager.emitMessageStatus(this.sessionId, ev));
    this.socket.ev.on('chats.upsert', ev => wsManager.emitChatsUpsert(this.sessionId, ev));
    this.socket.ev.on('chats.update', ev => wsManager.emitChatUpdate(this.sessionId, ev));
    this.socket.ev.on('chats.delete', ev => wsManager.emitChatDelete(this.sessionId, ev));
    this.socket.ev.on('contacts.upsert', ev => wsManager.emitContactUpdate(this.sessionId, ev));
    this.socket.ev.on('contacts.update', ev => wsManager.emitContactUpdate(this.sessionId, ev));
    this.socket.ev.on('presence.update', ev => wsManager.emitPresence(this.sessionId, ev));
    this.socket.ev.on('group-participants.update', ev => wsManager.emitGroupParticipants(this.sessionId, ev));
    this.socket.ev.on('groups.update', ev => wsManager.emitGroupUpdate(this.sessionId, ev));
    this.socket.ev.on('call', ev => wsManager.emitCall(this.sessionId, ev));
  }

async _performInitialSync() {
  if (this._initialSyncDone) return;
  this._initialSyncDone = true;

  console.log(`[${this.sessionId}] Starting initial sync`);

  // Wait for socket methods to be available
  for (let i = 0; i < 5; i++) {
    if (this.socket && typeof this.socket.groupFetchAllParticipating === 'function') break;
    await new Promise(r => setTimeout(r, 300));
  }

  if (!this.socket || typeof this.socket.groupFetchAllParticipating !== 'function') {
    console.error(`[${this.sessionId}] Socket still not ready after wait — skipping group sync`);
    return;
  }

  await Promise.allSettled([
    this.group._syncGroupRelatedData(),
    this._syncBlocklist()
  ]);

  wsManager.emitToSession(this.sessionId, 'initial_sync.complete', {
    timestamp: new Date().toISOString()
  });
}

  async _syncBlocklist() {
    try {
      const blocklist = await this.socket.fetchBlocklist();

      await this.db.mysqlTransaction(async (conn) => {
        // Clear old entries for this session
        await conn.execute('DELETE FROM device_blocklist WHERE session_id = ?', [this.sessionId]);

        if (blocklist.length > 0) {
          const values = blocklist.map(jid => [this.sessionId, this.username, jid]);

          // Explicit column names — adjust if your table has different columns
          await conn.query(
            'INSERT IGNORE INTO device_blocklist (session_id, username, jid) VALUES ?',
            [values]
          );
        }
      });

      // Optional Redis sync
      if (this.db.useRedis && this.db.redisReady) {
        const key = `blocklist:${this.sessionId}`;
        await this.db.redis.del(key);
        if (blocklist.length) await this.db.redis.sAdd(key, blocklist);
      }

      console.log(`[${this.sessionId}] Blocklist synced — ${blocklist.length} entries`);
    } catch (err) {
      console.error(`[${this.sessionId}] blocklist sync failed: ${err.message}`, err.sql || '');
    }
  }

  async logout() {
    try {
      if (this.db?.deleteSession) await this.db.deleteSession(this.sessionId);
      if (this.socket) await this.socket.logout();
      this.deleteMediaFolder();
      this.deleteAuthFolder();

      this.connectionStatus = 'disconnected';
      this.qrCode = null;
      this.phoneNumber = null;
      this.name = null;
      this._initialSyncDone = false;
      this._groupCache = null;

      return { success: true, message: 'Logged out successfully' };
    } catch (err) {
      console.error(`[${this.sessionId}] logout failed: ${err.message}`, err.stack);
      return { success: false, message: err.message };
    }
  }

  deleteAuthFolder() {
    try {
      if (fs.existsSync(this.authFolder)) fs.rmSync(this.authFolder, { recursive: true, force: true });
    } catch { }
  }

  deleteMediaFolder() {
    try {
      if (fs.existsSync(this.mediaFolder)) fs.rmSync(this.mediaFolder, { recursive: true, force: true });
    } catch { }
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
      username: this.username
    };
  }
}

module.exports = WhatsAppSession;