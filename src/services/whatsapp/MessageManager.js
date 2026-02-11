// src/services/whatsapp/MessageManager.js

const { downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const MessageFormatter = require('./MessageFormatter');

class MessageManager {
  constructor(session) {
    this.session = session;
    this.socket = session.socket;
    this.sessionId = session.sessionId;
    this.db = session.db;
    this.username = session.username;
  }

  // ────────────────────────────────────────────────
  // Send Message (text, media, location, etc.)
  // ────────────────────────────────────────────────
  async send(chatId, text = '', options = {}) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = this.session.normalizeJid(chatId);
      if (!jid) return { success: false, message: 'Invalid chatId' };

      const {
        attachment = null,
        latitude,
        longitude,
        typingTime = 0,
        replyTo = null,
        ptt = false,
        mimetype,
        filename,
        ...extraOptions
      } = options;

      // Simulate typing/recording if requested
      if (typingTime > 0) {
        let presence = 'composing';
        if (attachment && ptt && /\.(ogg|opus)$/i.test(attachment)) {
          presence = 'recording';
        }
        await this.socket.sendPresenceUpdate(presence, jid);
        await new Promise(r => setTimeout(r, typingTime));
        await this.socket.sendPresenceUpdate('paused', jid);
      }

      // Quoted message support
      let quoted;
      if (replyTo) {
        quoted = {
          key: { remoteJid: jid, id: replyTo, fromMe: false },
          message: { conversation: '' }
        };
      }
      const messageOptions = quoted ? { quoted } : {};

      let content = {};
      let type = 'text';

      if (attachment && typeof attachment === 'string') {
        const url = attachment.toLowerCase();
        const ext = (url.split('.').pop() || '').split('?')[0].toLowerCase();

        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
          type = 'image';
          content = { image: { url: attachment }, caption: text || undefined };
        } else if (['mp4', '3gp'].includes(ext)) {
          type = 'video';
          content = { video: { url: attachment }, caption: text || undefined };
        } else if (['ogg', 'opus'].includes(ext)) {
          type = 'audio';
          content = {
            audio: { url: attachment },
            ptt,
            mimetype: mimetype || 'audio/ogg; codecs=opus'
          };
        } else if (ext === 'vcf' || ext === 'vcard') {
          type = 'contact';
          content = {
            contacts: {
              displayName: text || 'Contact',
              contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${text || 'Contact'}\nTEL;waid=${text}:${text}\nEND:VCARD` }]
            }
          };
        } else {
          type = 'document';
          content = {
            document: { url: attachment },
            fileName: filename || `file.${ext || 'bin'}`,
            mimetype: mimetype || 'application/octet-stream',
            caption: text || undefined
          };
        }
      } else if (latitude && longitude) {
        type = 'location';
        content = {
          location: {
            degreesLatitude: Number(latitude),
            degreesLongitude: Number(longitude),
            name: text || ''
          }
        };
      } else if (text) {
        content = { text };
      } else {
        return { success: false, message: 'Provide text, attachment, location or other content' };
      }

      const result = await this.socket.sendMessage(jid, content, { ...messageOptions, ...extraOptions });

      const sent = {
        messageId: result?.key?.id,
        chatId: jid,
        timestamp: new Date().toISOString(),
        fromMe: true,
        type,
        text: text || undefined,
        attachment: attachment || undefined
      };

      wsManager.emitMessageSent(this.sessionId, sent);
      await this.session.webhook.send('message.sent', sent);

      return {
        success: true,
        message: `${type.charAt(0).toUpperCase() + type.slice(1)} sent`,
        data: sent
      };
    } catch (error) {
      console.error(`[${this.sessionId}] send failed: ${error.message}`);
      return { success: false, message: error.message || 'Failed to send message' };
    }
  }

  // ────────────────────────────────────────────────
  // Mark Chat as Read
  // ────────────────────────────────────────────────
  async markChatRead(chatId, messageId = null, updateDbOnly = false) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = this.session.normalizeJid(chatId);
      if (!jid) return { success: false, message: 'Invalid chatId' };

      const isGroup = jid.endsWith('@g.us');

      let query = `
        SELECT message_id, key_participant
        FROM messages
        WHERE session_id = ?
          AND chat_id = ?
          AND fromMe = 0
          AND status != 'read'
      `;
      const params = [this.sessionId, jid];

      if (messageId) {
        query += ` AND message_id <= ?`;
        params.push(messageId);
      }

      query += ` ORDER BY timestamp ASC LIMIT 500`;

      const unreadRows = await this.db.mysqlQuery(query, params);

      if (unreadRows.length === 0) {
        await this._forceUpdateUnreadCount(jid);
        return {
          success: true,
          message: 'No unread messages found',
          data: { chatId: jid, markedCount: 0 }
        };
      }

      let markedCount = 0;

      if (!updateDbOnly) {
        const keys = unreadRows.map(row => {
          const key = { remoteJid: jid, id: row.message_id };
          if (isGroup && row.key_participant) key.participant = row.key_participant;
          return key;
        });

        if (keys.length > 0) {
          await this.socket.readMessages(keys);
          markedCount = keys.length;
        }
      }

      let updateQuery = `
        UPDATE messages
        SET status = 'read',
            status_timestamp = NOW()
        WHERE session_id = ?
          AND chat_id = ?
          AND fromMe = 0
          AND status != 'read'
      `;
      const updateParams = [this.sessionId, jid];

      if (messageId) {
        updateQuery += ` AND message_id <= ?`;
        updateParams.push(messageId);
      }

      const [result] = await this.db.mysqlQuery(updateQuery, updateParams);
      const updatedRows = result?.affectedRows || 0;

      await this._forceUpdateUnreadCount(jid);

      return {
        success: true,
        message: 'Chat marked as read',
        data: {
          chatId: jid,
          isGroup,
          requestedUpTo: messageId || 'all',
          markedCount,
          dbUpdatedCount: updatedRows
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] markChatRead failed: ${err.message}`);
      return { success: false, message: err.message || 'Failed to mark as read' };
    }
  }

  async _forceUpdateUnreadCount(jid) {
    try {
      const [rows] = await this.db.mysqlQuery(`
        SELECT COUNT(*) as unread
        FROM messages
        WHERE session_id = ?
          AND chat_id = ?
          AND fromMe = 0
          AND status != 'read'
      `, [this.sessionId, jid]);

      const unreadCount = rows[0]?.unread || 0;

      await this.db.mysqlQuery(`
        UPDATE chats_overview
        SET unread_count = ?
        WHERE session_id = ? AND chat_id = ?
      `, [unreadCount, this.sessionId, jid]);
    } catch (err) {
      console.warn(`[${this.sessionId}] Failed to force update unread_count: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────
  // Media Auto-Save (called from messages.upsert)
  // ────────────────────────────────────────────────
  async _autoSaveMedia(message) {
    try {
      if (!message.message) return null;

      const contentType = getContentType(message.message);
      const mediaTypes = ['imageMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'videoMessage'];

      if (!contentType || !mediaTypes.includes(contentType)) return null;

      const mediaContent = message.message[contentType];
      if (!mediaContent) return null;

      const buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        { logger: console, reuploadRequest: this.socket?.updateMediaMessage }
      );

      const chatId = message.key.remoteJid.replace(/[@s.whatsapp.net|g.us]/g, '');
      const mediaDir = path.join(this.session.mediaFolder, chatId);

      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const mimetype = mediaContent.mimetype || this._getMimetype(contentType);
      const ext = this._getExtFromMimetype(mimetype);
      const filename = mediaContent.fileName || `${message.key.id}.${ext}`;
      const filePath = path.join(mediaDir, filename);

      fs.writeFileSync(filePath, buffer);

      const relativePath = `/media/${this.sessionId}/${chatId}/${filename}`;

      if (this.db?._upsertMediaFile) {
        await this.db._upsertMediaFile({
          messageId: message.key.id,
          chatId: message.key.remoteJid,
          filePath: relativePath,
          mimetype,
          fileLength: mediaContent.fileLength,
          timestamp: message.messageTimestamp
        });
      }

      return relativePath;
    } catch (error) {
      console.error(`[${this.sessionId}] _autoSaveMedia failed: ${error.message}`);
      return null;
    }
  }

  _getMimetype(contentType) {
    const map = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/ogg; codecs=opus',
      documentMessage: 'application/octet-stream',
      stickerMessage: 'image/webp'
    };
    return map[contentType] || 'application/octet-stream';
  }

  _getExtFromMimetype(mimetype) {
    const map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/3gpp': '3gp',
      'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
      'application/pdf': 'pdf'
    };
    return map[mimetype] || mimetype.split('/')[1]?.split(';')[0] || 'bin';
  }

  // ────────────────────────────────────────────────
  // Retrieve Messages
  // ────────────────────────────────────────────────
  async getMessages(chatId, limit = 50, cursor = null) {
    try {
      const jid = this.session.normalizeJid(chatId);
      if (!jid) return { success: false, message: 'Invalid chatId' };

      const isGroup = jid.endsWith('@g.us');

      const messages = await this.db.getMessages?.(jid, limit, cursor) || [];

      const formatted = messages
        .filter(msg => msg && msg.key)
        .map(msg => MessageFormatter.formatMessage(msg))
        .filter(Boolean);

      return {
        success: true,
        data: {
          chatId: jid,
          isGroup,
          total: formatted.length,
          limit,
          cursor: formatted.length > 0 ? formatted[formatted.length - 1].id : null,
          hasMore: formatted.length === limit,
          messages: formatted
        }
      };
    } catch (error) {
      console.error(`[${this.sessionId}] getMessages failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // Alias for backward compatibility / convenience
  async fetchMessages(chatId, limit = 50, cursor = null) {
    return this.getMessages(chatId, limit, cursor);
  }
}

module.exports = MessageManager;