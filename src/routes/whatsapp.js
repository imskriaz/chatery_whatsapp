// src/routes/whatsapp.js

const express = require('express');
const router = express.Router();
const whatsappManager = require('../services/whatsapp');
const Utilities = require('../services/whatsapp/Utilities');

const bulkJobs = new Map();

// ────────────────────────────────────────────────
// Middleware: Check session existence & connection
// ────────────────────────────────────────────────
const checkSession = (req, res, next) => {
  const body = req.body || {};
  const { sessionId } = body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      message: 'Missing required field: sessionId (in body)'
    });
  }

  const session = whatsappManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found'
    });
  }

  if (session.connectionStatus !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'Session not connected. Please scan QR first.'
    });
  }

  req.sessionObj = session; // renamed to avoid express-session conflict
  next();
};

// ────────────────────────────────────────────────
// Session Management
// ────────────────────────────────────────────────

router.get('/sessions', (req, res) => {
  try {
    const sessions = whatsappManager.getAllSessions();
    res.json({
      success: true,
      message: 'Sessions retrieved',
      data: sessions.map(s => s.getInfo())
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/sessions/connect', async (req, res) => {
  try {
    const username = req?.user?.username || '';
    const result = await whatsappManager.createSession(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/sessions/:sessionId/connect', async (req, res) => {
  try {
    const username = req?.user?.username || '';
    const { sessionId } = req.params;
    const result = await whatsappManager.createSession(username, sessionId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/sessions/:sessionId/status', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = whatsappManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    res.json({
      success: true,
      message: 'Status retrieved',
      data: session.getInfo()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/sessions/:sessionId/config', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { metadata, webhooks } = req.body;

    const session = whatsappManager.getSession(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const updated = session.updateConfig({ metadata, webhooks });

    res.json({
      success: true,
      message: 'Session config updated',
      data: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ────────────────────────────────────────────────
// Webhooks
// ────────────────────────────────────────────────

router.post('/sessions/:sessionId/webhooks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { url, events = ['all'] } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Missing required field: url' });
    }

    if (!Utilities.isValidHttpUrl(url)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook URL' });
    }

    const session = whatsappManager.getSession(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const updated = session.webhook.add(url, events);

    res.json({
      success: true,
      message: 'Webhook added/updated',
      data: { webhooks: updated.webhooks }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/sessions/:sessionId/webhooks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const url = req.body?.url || req.query?.url;

    if (!url) {
      return res.status(400).json({ success: false, message: 'Missing required field: url (body or query)' });
    }

    const session = whatsappManager.getSession(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const updated = session.webhook.remove(url);

    res.json({
      success: true,
      message: 'Webhook removed',
      data: { webhooks: updated.webhooks }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ────────────────────────────────────────────────
// QR Code Routes
// ────────────────────────────────────────────────

router.get('/sessions/:sessionId/qr', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = whatsappManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const info = session.getInfo();

    if (info.isConnected) {
      return res.json({
        success: true,
        message: 'Already connected to WhatsApp',
        data: { status: 'connected', qrCode: null }
      });
    }

    if (!info.qrCode) {
      return res.status(425).json({
        success: false,
        message: 'QR not ready yet. Try again in a few seconds.',
        data: { status: info.status }
      });
    }

    res.json({
      success: true,
      message: 'QR Code ready',
      data: { qrCode: info.qrCode, status: info.status }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/sessions/:sessionId/qr/image', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = whatsappManager.getSession(sessionId);

    if (!session || !session.qrCode) {
      return res.status(404).send('QR Code not available');
    }

    // Remove data URI prefix safely
    const base64Data = session.qrCode.replace(/^data:image\/[a-z]+;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');

    res.set('Content-Type', 'image/png');
    res.send(imgBuffer);
  } catch (error) {
    console.error(`QR image error [${req.params.sessionId}]:`, error.message);
    res.status(500).send('Error generating QR image');
  }
});

// ────────────────────────────────────────────────
// Session Delete
// ────────────────────────────────────────────────

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await whatsappManager.deleteSession(sessionId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────

router.post('/messages/send', checkSession, async (req, res) => {
  try {
    const { to, content, options = {} } = req.body;

    if (!to || !content || typeof content !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Required: to (phone/JID), content (object)'
      });
    }

    const result = await req.sessionObj.message.sendMessage(to, content, options);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/messages/bulk', checkSession, async (req, res) => {
  try {
    const { recipients, content, options = {}, delayMs = 1200 } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, message: 'recipients must be non-empty array' });
    }

    if (!content || typeof content !== 'object') {
      return res.status(400).json({ success: false, message: 'content must be object' });
    }

    if (recipients.length > 100) {
      return res.status(400).json({ success: false, message: 'Maximum 100 recipients per bulk request' });
    }

    const jobId = Utilities.generateJobId();
    const sessionId = req.body.sessionId || req.sessionObj.sessionId;

    bulkJobs.set(jobId, {
      sessionId,
      type: 'bulk_message',
      status: 'queued',
      total: recipients.length,
      sent: 0,
      failed: 0,
      progress: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      details: []
    });

    res.json({
      success: true,
      message: 'Bulk message job queued',
      data: {
        jobId,
        total: recipients.length,
        statusUrl: `/api/whatsapp/messages/bulk-status/${jobId}`
      }
    });

    // Background processing
    (async () => {
      const job = bulkJobs.get(jobId);
      job.status = 'processing';

      for (let i = 0; i < recipients.length; i++) {
        const to = recipients[i];
        try {
          const r = await req.sessionObj.message.sendMessage(to, content, options);
          if (r.success) {
            job.sent++;
            job.details.push({ to, status: 'sent', messageId: r.data?.messageId });
          } else {
            job.failed++;
            job.details.push({ to, status: 'failed', error: r.message });
          }
        } catch (err) {
          job.failed++;
          job.details.push({ to, status: 'failed', error: err.message });
        }

        job.progress = Math.round(((i + 1) / recipients.length) * 100);

        if (i < recipients.length - 1 && delayMs > 0) {
          await Utilities.sleep(delayMs);
        }
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();

      // Cleanup old jobs (keep last 150)
      if (bulkJobs.size > 150) {
        const oldKeys = [...bulkJobs.keys()].slice(0, bulkJobs.size - 150);
        oldKeys.forEach(k => bulkJobs.delete(k));
      }
    })();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/messages/bulk-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = bulkJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found' });
  }

  res.json({ success: true, data: job });
});

// ────────────────────────────────────────────────
// Chat Operations
// ────────────────────────────────────────────────

router.post('/chats/overview', checkSession, async (req, res) => {
  try {
    const { limit = 50, offset = 0, filter = 'all' } = req.body;
    const result = await req.sessionObj.chat.getChatsOverview(limit, offset, filter);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/chats/info', checkSession, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

    const result = await req.sessionObj.chat.getChatInfo(chatId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/chats/mark-read', checkSession, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

    const result = await req.sessionObj.chat.markChatRead(chatId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/chats/presence', checkSession, async (req, res) => {
  try {
    const { chatId, presence = 'composing' } = req.body;
    if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

    const validPresences = ['composing', 'recording', 'paused', 'available', 'unavailable'];
    if (!validPresences.includes(presence)) {
      return res.status(400).json({
        success: false,
        message: `Invalid presence. Allowed: ${validPresences.join(', ')}`
      });
    }

    const result = await req.sessionObj.sendPresenceUpdate(chatId, presence);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ────────────────────────────────────────────────
// Group Operations (dynamic proxy to GroupManager)
// ────────────────────────────────────────────────

const groupMethodMap = {
  'create': 'createGroup',
  'metadata': 'getGroupMetadata',
  'participants/add': 'addParticipants',
  'participants/remove': 'removeParticipants',
  'participants/promote': 'promoteParticipants',
  'participants/demote': 'demoteParticipants',
  'subject': 'updateSubject',
  'description': 'updateDescription',
  'settings': 'updateSettings',
  'picture': 'updateProfilePicture',
  'leave': 'leaveGroup',
  'join': 'joinByInvite',
  'invite-code': 'getInviteCode',
  'revoke-invite': 'revokeInvite'
};

Object.entries(groupMethodMap).forEach(([routePath, methodName]) => {
  router.post(`/groups/${routePath}`, checkSession, async (req, res) => {
    try {
      const handler = req.sessionObj.group[methodName];
      if (typeof handler !== 'function') {
        return res.status(501).json({
          success: false,
          message: `Group method '${methodName}' not implemented in GroupManager`
        });
      }

      const result = await handler.call(req.sessionObj.group, req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
});

module.exports = router;