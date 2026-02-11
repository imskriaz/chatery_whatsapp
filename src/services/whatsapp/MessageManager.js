// src/services/whatsapp/MessageManager.js

const {
  downloadMediaMessage,
  getContentType
} = require('@whiskeysockets/baileys');

const Utilities = require('./Utilities');

class MessageManager {
  constructor(session) {
    this.session = session;
    this.socket = session.socket;
    this.sessionId = session.sessionId;
    this.db = session.db;
    this.mediaFolder = session.mediaFolder;
  }

  /**
   * Send message using Baileys-native argument style
   *
   * @param {string} to - Phone number, group ID or full JID
   * @param {import('@whiskeysockets/baileys').AnyMessageContent} content - Baileys message content object
   * @param {import('@whiskeysockets/baileys').MiscMessageParams & {
   *   typingTime?: number,
   *   autoSaveMedia?: boolean
   * }} [options={}] - Baileys options + custom flags
   * @returns {Promise<{ success: boolean, message: string, data?: any, error?: string }>}
   */
  async sendMessage(to, content, options = {}) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session is not connected' };
      }

      if (!to) {
        return { success: false, message: 'Destination (to) is required' };
      }

      if (!content || Object.keys(content).length === 0) {
        return { success: false, message: 'Content object cannot be empty' };
      }

      // ─── Destination validation & normalization ───
      let jid;
      const jidCheck = Utilities.validateJid(to);
      if (jidCheck.valid) {
        jid = to;
      } else {
        const phoneCheck = Utilities.normalizePhoneNumber(to);
        if (!phoneCheck.valid) {
          return { success: false, message: phoneCheck.error };
        }
        jid = phoneCheck.normalized + '@s.whatsapp.net';
      }

      // ─── Media URL validation (if present) ───
      const mediaFields = ['image', 'video', 'audio', 'document', 'sticker'];
      for (const field of mediaFields) {
        if (content[field]?.url && !Utilities.isValidHttpUrl(content[field].url)) {
          return { success: false, message: `Invalid URL in ${field} field` };
        }
      }

      // ─── Typing simulation (with reasonable limit) ───
      const { typingTime = 0, autoSaveMedia = true, ...baileysOptions } = options;

      if (typingTime > 0 && typingTime <= 8000) { // prevent abuse
        const isVoice = !!content.audio?.ptt;
        const presence = isVoice ? 'recording' : 'composing';

        await this.socket.sendPresenceUpdate(presence, jid).catch(console.warn);
        await Utilities.sleep(typingTime);
        await this.socket.sendPresenceUpdate('paused', jid).catch(console.warn);
      }

      // ─── Send the message ───
      const sent = await this.socket.sendMessage(jid, content, baileysOptions);

      const messageId = sent?.key?.id;
      const sentAt = new Date().toISOString();

      const result = {
        success: true,
        message: 'Message sent successfully',
        data: {
          messageId,
          chatId: jid,
          timestamp: sentAt,
          fromMe: true,
          preview: this.formatLastMessagePreview(sent)
        }
      };

      // ─── Emit real-time events ───
      this.session.wsManager?.emitMessageSent(this.sessionId, result.data);
      this.session.webhook?._sendWebhook('message.sent', result.data);

      return result;
    } catch (err) {
      console.error(`[${this.sessionId}] sendMessage failed:`, err.stack || err.message);
      return {
        success: false,
        message: 'Failed to send message',
        error: err.message || 'Unknown error'
      };
    }
  }

  /**
   * Automatically download and save media from incoming messages
   * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} message
   * @returns {Promise<string|null>} public media path or null
   * @private
   */
  async _autoSaveMedia(message) {
    try {
      if (!message?.message) return null;

      const contentType = getContentType(message.message);
      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

      if (!contentType || !mediaTypes.includes(contentType)) return null;

      const media = message.message[contentType];
      if (!media) return null;

      const buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: console,
          reuploadRequest: this.socket?.updateMediaMessage
        }
      );

      const chatIdClean = message.key.remoteJid.replace(/[@s.whatsapp.net|g.us]/g, '');
      const mime = media.mimetype || Utilities.guessMimeType(contentType);
      const ext = Utilities.guessExtension(mime);
      const fname = media.fileName || `${message.key.id}.${ext}`;

      const publicPath = Utilities.saveMediaToDisk(
        buffer,
        this.sessionId,
        chatIdClean,
        fname,
        this.mediaFolder
      );

      // Save to database (if method exists)
      if (this.db?._upsertMediaFile) {
        await this.db._upsertMediaFile({
          messageId: message.key.id,
          chatId: message.key.remoteJid,
          filePath: publicPath,
          mimetype: mime,
          fileLength: media.fileLength,
          timestamp: Utilities.formatTimestamp(message.messageTimestamp)
        });
      }

      // Attach to message object for convenience
      message._mediaPath = publicPath;

      return publicPath;
    } catch (err) {
      console.error(`[${this.sessionId}] _autoSaveMedia failed:`, err.message);
      return null;
    }
  }

  /**
   * Format full message for API responses / frontend
   * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
   * @returns {object|null}
   */
  formatMessage(msg) {
    if (!msg || !msg.message) return null;

    const m = msg.message;
    let type = 'unknown';
    let content = null;
    let caption, mimetype, filename;

    if (m.conversation) {
      type = 'text';
      content = m.conversation;
    } else if (m.extendedTextMessage) {
      type = 'text';
      content = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
      type = 'image';
      caption = m.imageMessage.caption;
      mimetype = m.imageMessage.mimetype;
    } else if (m.videoMessage) {
      type = 'video';
      caption = m.videoMessage.caption;
      mimetype = m.videoMessage.mimetype;
    } else if (m.audioMessage) {
      type = m.audioMessage.ptt ? 'ptt' : 'audio';
      mimetype = m.audioMessage.mimetype;
    } else if (m.documentMessage) {
      type = 'document';
      filename = m.documentMessage.fileName;
      mimetype = m.documentMessage.mimetype;
    } else if (m.stickerMessage) {
      type = 'sticker';
      mimetype = m.stickerMessage.mimetype;
    } else if (m.locationMessage) {
      type = 'location';
      content = {
        latitude: m.locationMessage.degreesLatitude,
        longitude: m.locationMessage.degreesLongitude,
        name: m.locationMessage.name,
        address: m.locationMessage.address
      };
    } else if (m.contactMessage) {
      type = 'contact';
      content = {
        displayName: m.contactMessage.displayName,
        vcard: m.contactMessage.vcard
      };
    } else if (m.contactsArrayMessage) {
      type = 'contacts';
      content = m.contactsArrayMessage.contacts?.map(c => ({
        displayName: c.displayName,
        vcard: c.vcard
      }));
    } else if (m.reactionMessage) {
      type = 'reaction';
      content = {
        emoji: m.reactionMessage.text,
        targetMessageId: m.reactionMessage.key?.id
      };
    }

    return {
      id: msg.key.id,
      chatId: msg.key.remoteJid,
      fromMe: msg.key.fromMe || false,
      sender: msg.key.participant || msg.key.remoteJid,
      senderPhone: (msg.key.participant || msg.key.remoteJid)?.split('@')[0],
      senderName: msg.pushName || null,
      timestamp: Utilities.formatTimestamp(msg.messageTimestamp),
      type,
      content,
      caption,
      mimetype,
      filename,
      mediaUrl: msg._mediaPath || null,
      isGroup: Utilities.isGroupJid(msg.key.remoteJid),
      quotedMessage: m.extendedTextMessage?.contextInfo?.quotedMessage
        ? {
            id: m.extendedTextMessage.contextInfo.stanzaId,
            sender: m.extendedTextMessage.contextInfo.participant
          }
        : null
    };
  }

  /**
   * Format short preview for chat list (last message)
   * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg
   * @returns {object|null}
   */
  formatLastMessagePreview(msg) {
    if (!msg || !msg.message) return null;

    const m = msg.message;
    let type = 'unknown';
    let text = null;

    if (m.conversation) {
      type = 'text'; text = m.conversation;
    } else if (m.extendedTextMessage?.text) {
      type = 'text'; text = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
      type = 'image'; text = m.imageMessage.caption || '🖼️ Photo';
    } else if (m.videoMessage) {
      type = 'video'; text = m.videoMessage.caption || '🎥 Video';
    } else if (m.audioMessage) {
      type = m.audioMessage.ptt ? 'voice' : 'audio';
      text = m.audioMessage.ptt ? '🎤 Voice' : '🎵 Audio';
    } else if (m.documentMessage) {
      type = 'document'; text = `📄 ${m.documentMessage.fileName || 'File'}`;
    } else if (m.stickerMessage) {
      type = 'sticker'; text = 'Sticker';
    } else if (m.locationMessage) {
      type = 'location'; text = '📍 Location';
    } else if (m.contactMessage) {
      type = 'contact'; text = `👤 ${m.contactMessage.displayName || 'Contact'}`;
    } else if (m.reactionMessage) {
      type = 'reaction'; text = m.reactionMessage.text || 'Reaction';
    }

    return {
      type,
      text: text ? (text.length > 120 ? text.slice(0, 117) + '...' : text) : null,
      fromMe: msg.key?.fromMe || false,
      timestamp: Utilities.formatTimestamp(msg.messageTimestamp)
    };
  }

  /**
   * Retrieve messages from database (paginated)
   * @param {string} chatId
   * @param {number} [limit=50]
   * @param {string|null} [cursor=null]
   * @returns {Promise<{ success: boolean, data?: any, message?: string }>}
   */
  async getMessages(chatId, limit = 50, cursor = null) {
    try {
      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      const isGroup = Utilities.isGroupJid(jid);

      const rows = await this.db.getMessages?.(jid, limit, cursor) || [];

      const formatted = rows
        .filter(m => m && m.key)
        .map(m => this.formatMessage(m))
        .filter(Boolean);

      return {
        success: true,
        data: {
          chatId: jid,
          isGroup,
          total: formatted.length,
          limit,
          cursor: formatted.length > 0 ? formatted.at(-1)?.id : null,
          hasMore: formatted.length === limit,
          messages: formatted
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] getMessages failed:`, err);
      return { success: false, message: err.message || 'Failed to retrieve messages' };
    }
  }

  // Alias for convenience
  fetchMessages(chatId, limit = 50, cursor = null) {
    return this.getMessages(chatId, limit, cursor);
  }
}

module.exports = MessageManager;