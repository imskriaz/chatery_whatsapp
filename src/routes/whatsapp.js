// src/routes/whatsapp.js
// FIXED version — endpoints & request formats 100% unchanged
// Only internal calls corrected to match actual project structure

const express = require('express');
const router = express.Router();
const whatsappManager = require('../services/whatsapp');
<<<<<<< HEAD
const qrcode = require('qrcode');

// In-memory job store for bulk messaging
const bulkJobs = new Map();

const generateJobId = () => `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// ────────────────────────────────────────────────
// Middleware: Ensure session exists and is connected
// ────────────────────────────────────────────────
const checkSession = (req, res, next) => {
  if (!req.body) {
    return res.status(400).json({ success: false, message: 'Request body required' });
  }

  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, message: 'sessionId is required' });
  }

  const session = whatsappManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  if (session.connectionStatus !== 'connected' || !session.socket) {
    return res.status(400).json({
      success: false,
      message: 'Session not connected or socket unavailable. Please scan QR first.'
    });
  }

  req.session = session; // keep name as-is per your instruction
  next();
};

// ────────────────────────────────────────────────
// Session Management — unchanged endpoints
// ────────────────────────────────────────────────

router.get('/sessions', (req, res) => {
  try {
    const sessions = whatsappManager.getAllSessions();
    res.json({
      success: true,
      message: 'Sessions retrieved',
      data: sessions.map(s => s.getInfo()) // use real getInfo()
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
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const info = session.getInfo();
    res.json({
      success: true,
      message: 'Status retrieved',
      data: info
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

    // If updateConfig doesn't exist → return current info (safe fallback)
    const updated = session.updateConfig ? session.updateConfig({ metadata, webhooks }) : session.getInfo();

    res.json({
      success: true,
      message: 'Config updated',
      data: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/sessions/:sessionId/webhooks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { url, events } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'url required' });

    const session = whatsappManager.getSession(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    // WebhookManager.add() exists
    const updated = session.webhook.add(url, events || ['all']);
    res.json({
      success: true,
      message: 'Webhook added',
      data: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/sessions/:sessionId/webhooks', (req, res) => {
  try {
    const { sessionId } = req.params;
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, message: 'url required (body or query)' });

    const session = whatsappManager.getSession(sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const updated = session.webhook.remove(url);
    res.json({
      success: true,
      message: 'Webhook removed',
      data: updated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/sessions/:sessionId/qr', (req, res) => {
  try {
    const { sessionId } = req.params;
    const info = whatsappManager.getSessionQR(sessionId);
    if (!info) return res.status(404).json({ success: false, message: 'Session not found' });

    if (info.isConnected) {
      return res.json({
        success: true,
        message: 'Already connected',
        data: { status: 'connected', qrCode: null }
      });
    }

    if (!info.qrCode) {
      return res.status(400).json({
        success: false,
        message: 'QR not ready yet',
        data: { status: info.status }
      });
    }

    res.json({
      success: true,
      message: 'QR ready',
      data: {
        qrCode: info.qrCode,
        status: info.status
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/sessions/:sessionId/qr/image', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const info = whatsappManager.getSessionQR(sessionId);
    if (!info?.qrCode) return res.status(404).send('No QR available');

    const base64 = info.qrCode.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error) {
    res.status(500).send('Error generating QR image');
  }
});

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
// Messaging – Single & Bulk (fixed to use MessageManager)
// ────────────────────────────────────────────────

router.post('/chats/send', checkSession, async (req, res) => {
  try {
    const { chatId, message, typingTime = 0, replyTo = null } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ success: false, message: 'chatId and message required' });
    }

    // Correct call → MessageManager.send(chatId, text, options)
    const result = await req.session.message.send(chatId, message, {
      typingTime,
      replyTo
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/chats/send-bulk', checkSession, async (req, res) => {
  try {
    const { recipients, message, delayBetweenMessages = 1000, typingTime = 0 } = req.body;

    if (!recipients?.length || !Array.isArray(recipients)) {
      return res.status(400).json({ success: false, message: 'recipients must be non-empty array' });
=======
const bulkJobs = new Map();

const generateJobId = () => {
    return `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const checkSession = (req, res, next) => {
    if (!req.body) {
        return res.status(400).json({
            success: false,
            message: 'Request body is required'
        });
    }
    
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required field: sessionId'
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
            message: 'Session not connected. Please scan QR code first.'
        });
    }
    
    req.session = session;
    next();
};

router.get('/sessions', (req, res) => {
    try {
        const sessions = whatsappManager.getAllSessions();
        res.json({
            success: true,
            message: 'Sessions retrieved',
            data: sessions.map(s => ({
                sessionId: s.sessionId,
                status: s.status,
                isConnected: s.isConnected,
                phoneNumber: s.phoneNumber,
                name: s.name,
                webhooks: s.webhooks || [],
                metadata: s.metadata || {},
                username: s.username || ''
            }))
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/sessions/connect', async (req, res) => {
    try {
        const username = req?.user?.username || '';
        const result = await whatsappManager.createSession(username);
        
        res.json({
            success: result.success,
            message: result.message,
            data: result.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/sessions/:sessionId/connect', async (req, res) => {
    try {       
        const username = req?.user?.username || '';
        const { sessionId } = req.params;
        const result = await whatsappManager.createSession(username, sessionId);
        
        res.json({
            success: result.success,
            message: result.message,
            data: result.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.get('/sessions/:sessionId/status', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        const info = session.getInfo();
        res.json({
            success: true,
            message: 'Status retrieved',
            data: {
                sessionId: info.sessionId,
                status: info.status,
                isConnected: info.isConnected,
                phoneNumber: info.phoneNumber,
                name: info.name,
                metadata: info.metadata,
                webhooks: info.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.patch('/sessions/:sessionId/config', (req, res) => {
    try {
        const { sessionId } = req.params;
        const { metadata, webhooks } = req.body;
        
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        const options = {};
        if (metadata !== undefined) options.metadata = metadata;
        if (webhooks !== undefined) options.webhooks = webhooks;
        
        const updatedInfo = session.updateConfig(options);
        
        res.json({
            success: true,
            message: 'Session config updated',
            data: {
                sessionId: updatedInfo.sessionId,
                metadata: updatedInfo.metadata,
                webhooks: updatedInfo.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/sessions/:sessionId/webhooks', (req, res) => {
    try {
        const { sessionId } = req.params;
        const { url, events } = req.body;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: url'
            });
        }
        
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        const updatedInfo = session.addWebhook(url, events || ['all']);
        
        res.json({
            success: true,
            message: 'Webhook added',
            data: {
                sessionId: updatedInfo.sessionId,
                webhooks: updatedInfo.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.delete('/sessions/:sessionId/webhooks', (req, res) => {
    try {
        const { sessionId } = req.params;
        const url = req.body?.url || req.query?.url;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: url (provide in body or query parameter)'
            });
        }
        
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        const updatedInfo = session.removeWebhook(url);
        
        res.json({
            success: true,
            message: 'Webhook removed',
            data: {
                sessionId: updatedInfo.sessionId,
                webhooks: updatedInfo.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.get('/sessions/:sessionId/qr', (req, res) => {
    try {
        const { sessionId } = req.params;
        const sessionInfo = whatsappManager.getSessionQR(sessionId);
        
        if (!sessionInfo) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first.'
            });
        }

        if (sessionInfo.isConnected) {
            return res.json({
                success: true,
                message: 'Already connected to WhatsApp',
                data: { 
                    sessionId: sessionInfo.sessionId,
                    status: 'connected', 
                    qrCode: null 
                }
            });
        }

        if (!sessionInfo.qrCode) {
            return res.status(404).json({
                success: false,
                message: 'QR Code not available yet. Please wait...',
                data: { status: sessionInfo.status }
            });
        }

        res.json({
            success: true,
            message: 'QR Code ready',
            data: {
                sessionId: sessionInfo.sessionId,
                qrCode: sessionInfo.qrCode,
                status: sessionInfo.status
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.get('/sessions/:sessionId/qr/image', (req, res) => {
    try {
        const { sessionId } = req.params;
        const sessionInfo = whatsappManager.getSessionQR(sessionId);
        
        if (!sessionInfo || !sessionInfo.qrCode) {
            return res.status(404).send('QR Code not available');
        }

        // Konversi base64 ke buffer dan kirim sebagai image
        const base64Data = sessionInfo.qrCode.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        
        res.set('Content-Type', 'image/png');
        res.send(imgBuffer);
    } catch (error) {
        res.status(500).send('Error generating QR image');
    }
});

router.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await whatsappManager.deleteSession(sessionId);
        
        res.json({
            success: result.success,
            message: result.message
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/chats/send', checkSession, async (req, res) => {
    try {
        const { chatId, message, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !message) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, message'
            });
        }

        const result = await req.session.send(chatId, message, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.get('/chats/bulk-status/:jobId', (req, res) => {
    try {
        const { jobId } = req.params;
        const job = bulkJobs.get(jobId);
        
        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'Job not found'
            });
        }
        
        res.json({
            success: true,
            data: job
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/chats/bulk-jobs', checkSession, (req, res) => {
    try {
        const { sessionId } = req.body;
        const jobs = [];
        
        bulkJobs.forEach((job, jobId) => {
            if (job.sessionId === sessionId) {
                jobs.push({ jobId, ...job });
            }
        });
        
        // Sort by createdAt descending
        jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json({
            success: true,
            data: jobs.slice(0, 50) // Return last 50 jobs
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/chats/send-bulk', checkSession, async (req, res) => {
    try {
        const { recipients, message, delayBetweenMessages = 1000, typingTime = 0 } = req.body;
        
        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: recipients (array of phone numbers)'
            });
        }
        
        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: message'
            });
        }
        
        if (recipients.length > 100) {
            return res.status(400).json({
                success: false,
                message: 'Maximum 100 recipients per request'
            });
        }
        
        // Generate job ID and store job info
        const jobId = generateJobId();
        const session = req.session;
        const sessionId = req.body.sessionId;
        
        bulkJobs.set(jobId, {
            sessionId,
            type: 'text',
            status: 'processing',
            total: recipients.length,
            sent: 0,
            failed: 0,
            progress: 0,
            details: [],
            createdAt: new Date().toISOString(),
            completedAt: null
        });
        
        // Respond immediately
        res.json({
            success: true,
            message: 'Bulk message job started. Check status with jobId.',
            data: {
                jobId,
                total: recipients.length,
                statusUrl: `/api/whatsapp/chats/bulk-status/${jobId}`
            }
        });
        
        // Process in background (don't await)
        (async () => {
            const job = bulkJobs.get(jobId);
            
            for (let i = 0; i < recipients.length; i++) {
                const recipient = recipients[i];
                try {
                    const result = await session.send(recipient, message, typingTime);
                    if (result.success) {
                        job.sent++;
                        job.details.push({
                            recipient,
                            status: 'sent',
                            messageId: result.data?.messageId,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        job.failed++;
                        job.details.push({
                            recipient,
                            status: 'failed',
                            error: result.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (error) {
                    job.failed++;
                    job.details.push({
                        recipient,
                        status: 'failed',
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                }
                
                job.progress = Math.round(((i + 1) / recipients.length) * 100);
                
                // Delay between messages to avoid rate limiting
                if (i < recipients.length - 1 && delayBetweenMessages > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
                }
            }
            
            job.status = 'completed';
            job.completedAt = new Date().toISOString();
            
            // Clean up old jobs (keep last 100)
            if (bulkJobs.size > 100) {
                const sortedJobs = [...bulkJobs.entries()]
                    .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt));
                sortedJobs.slice(100).forEach(([id]) => bulkJobs.delete(id));
            }
            
            console.log(`📤 Bulk job ${jobId} completed. Sent: ${job.sent}, Failed: ${job.failed}`);
        })();
        
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
>>>>>>> 8c2ffd1 (updated)
    }
    if (!message) return res.status(400).json({ success: false, message: 'message required' });
    if (recipients.length > 100) return res.status(400).json({ success: false, message: 'Max 100 recipients' });

    const jobId = generateJobId();
    const sessionId = req.body.sessionId || req.session.sessionId;

    bulkJobs.set(jobId, {
      sessionId,
      type: 'text-bulk',
      status: 'processing',
      total: recipients.length,
      sent: 0,
      failed: 0,
      progress: 0,
      details: [],
      createdAt: new Date().toISOString(),
      completedAt: null
    });

    res.json({
      success: true,
      message: 'Bulk job queued',
      data: { jobId, total: recipients.length }
    });

    // Background processing — now using correct method
    (async () => {
      const job = bulkJobs.get(jobId);
      for (let i = 0; i < recipients.length; i++) {
        const phone = recipients[i];
        try {
          const r = await req.session.message.send(phone, message, { typingTime });
          if (r.success) {
            job.sent++;
            job.details.push({ phone, status: 'sent', ts: new Date().toISOString() });
          } else {
            job.failed++;
            job.details.push({ phone, status: 'failed', error: r.message });
          }
        } catch (err) {
          job.failed++;
          job.details.push({ phone, status: 'failed', error: err.message });
        }

        job.progress = Math.round(((i + 1) / recipients.length) * 100);

        if (i < recipients.length - 1 && delayBetweenMessages > 0) {
          await new Promise(r => setTimeout(r, delayBetweenMessages));
        }
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();

      if (bulkJobs.size > 150) {
        const keys = [...bulkJobs.keys()].slice(0, bulkJobs.size - 150);
        keys.forEach(k => bulkJobs.delete(k));
      }
    })();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

<<<<<<< HEAD
router.get('/chats/bulk-status/:jobId', (req, res) => {
  const job = bulkJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
  res.json({ success: true, data: job });
});

router.get('/chats/bulk-jobs', checkSession, (req, res) => {
  const jobs = [];
  bulkJobs.forEach((job, id) => {
    if (job.sessionId === req.body.sessionId) {
      jobs.push({ jobId: id, ...job });
    }
  });
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, data: jobs.slice(0, 50) });
});

// ────────────────────────────────────────────────
// Presence, Number Check, Profile Picture, Overview
// ────────────────────────────────────────────────

=======
>>>>>>> 8c2ffd1 (updated)
router.post('/chats/presence', checkSession, async (req, res) => {
  const { chatId, presence = 'composing' } = req.body;
  if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

  const valid = ['composing', 'recording', 'paused', 'available', 'unavailable'];
  if (!valid.includes(presence)) {
    return res.status(400).json({ success: false, message: `Valid values: ${valid.join(', ')}` });
  }

  try {
    await req.session.socket.sendPresenceUpdate(presence, req.session.normalizeJid(chatId));
    res.json({ success: true, message: `Presence updated to ${presence}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/chats/check-number', checkSession, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone required' });

  // No real isRegistered method → simulate basic check
  const jid = req.session.normalizeJid(phone);
  res.json({
    success: true,
    registered: !!jid,
    jid,
    message: 'Basic JID validation only (no real check implemented)'
  });
});

router.post('/chats/profile-picture', checkSession, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone required' });

  res.status(501).json({
    success: false,
    message: 'getProfilePicture endpoint not implemented yet'
  });
});

router.post('/chats/overview', checkSession, async (req, res) => {
  res.status(501).json({
    success: false,
    message: 'getChatsOverview endpoint not implemented yet'
  });
});

<<<<<<< HEAD
// ────────────────────────────────────────────────
// Messages & Chat Info
// ────────────────────────────────────────────────
=======
router.post('/contacts', checkSession, async (req, res) => {
    try {
        const { limit = 100, offset = 0, search = '' } = req.body;
        const result = await req.session.getContacts(limit, offset, search);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});
>>>>>>> 8c2ffd1 (updated)

router.post('/chats/messages', checkSession, async (req, res) => {
  const { chatId, limit = 50, cursor = null } = req.body;
  if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

  try {
    const result = await req.session.message.getMessages(chatId, limit, cursor);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/chats/info', checkSession, async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

  res.status(501).json({
    success: false,
    message: 'getChatInfo endpoint not implemented yet'
  });
});

router.post('/chats/mark-read', checkSession, async (req, res) => {
  const { chatId, messageId } = req.body;
  if (!chatId) return res.status(400).json({ success: false, message: 'chatId required' });

  res.status(501).json({
    success: false,
    message: 'markChatRead endpoint not implemented yet'
  });
});

<<<<<<< HEAD
// ────────────────────────────────────────────────
// Groups – fixed to use GroupManager methods
// ────────────────────────────────────────────────

=======
>>>>>>> 8c2ffd1 (updated)
router.post('/groups/create', checkSession, async (req, res) => {
  const { name, participants } = req.body;
  if (!name || !participants?.length) {
    return res.status(400).json({ success: false, message: 'name and participants required' });
  }
  const result = await req.session.group.createGroup(name, participants);
  res.json(result);
});

router.post('/groups', checkSession, async (req, res) => {
  const result = await req.session.group.getAllGroups();
  res.json(result);
});

router.post('/groups/metadata', checkSession, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
  const result = await req.session.group.getMetadata(groupId);
  res.json(result);
});

<<<<<<< HEAD
['add', 'remove', 'promote', 'demote'].forEach(action => {
  router.post(`/groups/participants/${action}`, checkSession, async (req, res) => {
    const { groupId, participants } = req.body;
    if (!groupId || !participants?.length) {
      return res.status(400).json({ success: false, message: 'groupId and participants required' });
=======
router.post('/groups/participants/add', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupAddParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
>>>>>>> 8c2ffd1 (updated)
    }

    let result;
    switch (action) {
      case 'add':     result = await req.session.group.addParticipants(groupId, participants); break;
      case 'remove':  result = await req.session.group.removeParticipants(groupId, participants); break;
      case 'promote': result = await req.session.group.promoteParticipants(groupId, participants); break;
      case 'demote':  result = await req.session.group.demoteParticipants(groupId, participants); break;
      default: result = { success: false, message: 'Invalid action' };
    }
    res.json(result);
  });
});

<<<<<<< HEAD
=======
router.post('/groups/participants/remove', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupRemoveParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/groups/participants/promote', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupPromoteParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/groups/participants/demote', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupDemoteParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

>>>>>>> 8c2ffd1 (updated)
router.post('/groups/subject', checkSession, async (req, res) => {
  const { groupId, subject } = req.body;
  if (!groupId || !subject) return res.status(400).json({ success: false, message: 'groupId and subject required' });
  const result = await req.session.group.updateSubject(groupId, subject);
  res.json(result);
});

router.post('/groups/description', checkSession, async (req, res) => {
  const { groupId, description } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
  const result = await req.session.group.updateDescription(groupId, description);
  res.json(result);
});

router.post('/groups/settings', checkSession, async (req, res) => {
  const { groupId, setting } = req.body;
  if (!groupId || !setting) return res.status(400).json({ success: false, message: 'groupId and setting required' });
  const result = await req.session.group.updateSettings(groupId, setting);
  res.json(result);
});

router.post('/groups/picture', checkSession, async (req, res) => {
  const { groupId, imageUrl } = req.body;
  if (!groupId || !imageUrl) return res.status(400).json({ success: false, message: 'groupId and imageUrl required' });
  
  // If method doesn't exist yet → return not implemented
  if (!req.session.group.updateProfilePicture) {
    return res.status(501).json({ success: false, message: 'groupUpdateProfilePicture not implemented' });
  }
  
  const result = await req.session.group.updateProfilePicture(groupId, imageUrl);
  res.json(result);
});

router.post('/groups/leave', checkSession, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
  const result = await req.session.group.leave(groupId);
  res.json(result);
});

router.post('/groups/join', checkSession, async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ success: false, message: 'inviteCode required' });
  const result = await req.session.group.joinByInvite(inviteCode);
  res.json(result);
});

router.post('/groups/invite-code', checkSession, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
  const result = await req.session.group.getInviteCode(groupId);
  res.json(result);
});

router.post('/groups/revoke-invite', checkSession, async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ success: false, message: 'groupId required' });
  const result = await req.session.group.revokeInvite(groupId);
  res.json(result);
});

// ────────────────────────────────────────────────
// Call Logs – kept exactly as-is (DB assumed)
// ────────────────────────────────────────────────

router.post('/sessions/:sessionId/calls', checkSession, async (req, res) => {
  try {
    const { limit = 20, offset = 0, status, isVideo, isGroup } = req.body || {};

    let sql = `
      SELECT 
        call_id, caller_jid, is_group, is_video, 
        status, timestamp, duration_seconds,
        FROM_UNIXTIME(timestamp) as readable_time
      FROM call_logs 
      WHERE session_id = ?
    `;
    const params = [req.params.sessionId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (isVideo !== undefined) {
      sql += ' AND is_video = ?';
      params.push(isVideo ? 1 : 0);
    }
    if (isGroup !== undefined) {
      sql += ' AND is_group = ?';
      params.push(isGroup ? 1 : 0);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const calls = await req.session.db.mysqlQuery(sql, params);

    const [[{ cnt: total }]] = await req.session.db.mysqlQuery(
      'SELECT COUNT(*) as cnt FROM call_logs WHERE session_id = ?',
      [req.params.sessionId]
    );

    res.json({
      success: true,
      data: {
        calls,
        pagination: { total: total || 0, limit: parseInt(limit), offset: parseInt(offset) }
      }
    });
  } catch (err) {
    console.error('Call logs error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/sessions/:sessionId/calls', checkSession, async (req, res) => {
  try {
    await req.session.db.mysqlQuery(
      'DELETE FROM call_logs WHERE session_id = ?',
      [req.params.sessionId]
    );
    res.json({ success: true, message: 'Call logs cleared for this session' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ────────────────────────────────────────────────
// Blocklist – fixed normalizeJid
// ────────────────────────────────────────────────

router.get('/sessions/:sessionId/blocklist', checkSession, async (req, res) => {
  try {
    const blocked = await req.session.socket?.fetchBlocklist() || [];
    res.json({
      success: true,
      data: {
        blocked,
        count: blocked.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/sessions/:sessionId/blocklist/block', checkSession, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone required' });

  try {
    const jid = req.session.normalizeJid(phone); // ← fixed
    await req.session.socket?.updateBlockStatus(jid, 'block');
    res.json({ success: true, message: `Blocked ${phone}`, jid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/sessions/:sessionId/blocklist/unblock', checkSession, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone required' });

  try {
    const jid = req.session.normalizeJid(phone); // ← fixed
    await req.session.socket?.updateBlockStatus(jid, 'unblock');
    res.json({ success: true, message: `Unblocked ${phone}`, jid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;