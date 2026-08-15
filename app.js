'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const pino = require('pino');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

/*
|--------------------------------------------------------------------------
| Application State
|--------------------------------------------------------------------------
*/

const state = {
  startedAt: new Date(),
  status: 'starting',
  whatsapp: {
    connected: false,
    state: 'disconnected',
    phone: null,
    lastUpdate: null
  }
};

/*
|--------------------------------------------------------------------------
| Security
|--------------------------------------------------------------------------
*/

app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/*
|--------------------------------------------------------------------------
| Logging
|--------------------------------------------------------------------------
*/

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

/*
|--------------------------------------------------------------------------
| Rate Limiting
|--------------------------------------------------------------------------
*/

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.'
  }
});

app.use('/api', apiLimiter);

/*
|--------------------------------------------------------------------------
| Static Frontend
|--------------------------------------------------------------------------
*/

const publicDir = path.join(__dirname, 'public');

app.use(
  express.static(publicDir, {
    extensions: ['html']
  })
);

/*
|--------------------------------------------------------------------------
| WebSocket
|--------------------------------------------------------------------------
*/

const wss = new WebSocketServer({
  server,
  path: '/ws'
});

function sendSocket(client, payload) {
  if (client.readyState !== 1) return;

  client.send(
    JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString()
    })
  );
}

function broadcast(payload) {
  for (const client of wss.clients) {
    sendSocket(client, payload);
  }
}

wss.on('connection', (socket, request) => {
  logger.info(
    {
      ip: request.socket.remoteAddress
    },
    'WebSocket client connected'
  );

  sendSocket(socket, {
    type: 'status',
    data: state
  });

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      logger.info(
        {
          type: message.type
        },
        'WebSocket message received'
      );

      /*
       * Commands from the web panel can be handled here later.
       *
       * Example:
       * {
       *   "type": "bot.status"
       * }
       */

      if (message.type === 'bot.status') {
        sendSocket(socket, {
          type: 'status',
          data: state
        });
      }

    } catch (error) {
      logger.warn(
        {
          error: error.message
        },
        'Invalid WebSocket message'
      );

      sendSocket(socket, {
        type: 'error',
        message: 'Invalid WebSocket message'
      });
    }
  });

  socket.on('close', () => {
    logger.info('WebSocket client disconnected');
  });

  socket.on('error', (error) => {
    logger.warn(
      {
        error: error.message
      },
      'WebSocket error'
    );
  });
});

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get('/health', (req, res) => {
  const uptime = process.uptime();

  res.status(200).json({
    success: true,
    name: 'Mordekiller',
    status: state.status,
    uptime: Math.floor(uptime),
    timestamp: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| API Status
|--------------------------------------------------------------------------
*/

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    bot: {
      name: 'Mordekiller',
      status: state.status
    },
    whatsapp: state.whatsapp,
    server: {
      uptime: Math.floor(process.uptime()),
      node: process.version,
      platform: process.platform
    },
    startedAt: state.startedAt
  });
});

/*
|--------------------------------------------------------------------------
| Bot Status Update API
|--------------------------------------------------------------------------
*/

app.post('/api/status', (req, res) => {
  const { status, whatsapp } = req.body;

  if (typeof status === 'string') {
    state.status = status;
  }

  if (whatsapp && typeof whatsapp === 'object') {
    state.whatsapp = {
      ...state.whatsapp,
      ...whatsapp,
      lastUpdate: new Date().toISOString()
    };
  }

  broadcast({
    type: 'status',
    data: state
  });

  res.json({
    success: true,
    data: state
  });
});

/*
|--------------------------------------------------------------------------
| 404 Handler
|--------------------------------------------------------------------------
*/

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'API route not found'
  });
});

app.use((req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  logger.error(
    {
      error: error.message,
      stack: error.stack
    },
    'Express error'
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : error.message
  });
});

/*
|--------------------------------------------------------------------------
| Baileys Integration
|--------------------------------------------------------------------------
|
| We intentionally load the bot module here rather than putting all
| WhatsApp logic inside app.js.
|
*/

async function startBot() {
  try {
    const bot = require('./src/bot');

    if (typeof bot.start === 'function') {
      await bot.start({
        updateStatus: (update) => {
          state.whatsapp = {
            ...state.whatsapp,
            ...update,
            lastUpdate: new Date().toISOString()
          };

          broadcast({
            type: 'whatsapp.status',
            data: state.whatsapp
          });
        },

        broadcast
      });
    }

    logger.info('Mordekiller bot module started');

  } catch (error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack
      },
      'Failed to start bot module'
    );

    state.status = 'bot_error';
  }
}

/*
|--------------------------------------------------------------------------
| Server Startup
|--------------------------------------------------------------------------
*/

async function startServer() {
  try {
    server.listen(PORT, HOST, async () => {
      state.status = 'online';

      logger.info(
        {
          host: HOST,
          port: PORT
        },
        'Mordekiller server started'
      );

      await startBot();
    });

  } catch (error) {
    logger.fatal(
      {
        error: error.message
      },
      'Failed to start server'
    );

    process.exit(1);
  }
}

/*
|--------------------------------------------------------------------------
| Graceful Shutdown
|--------------------------------------------------------------------------
*/

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  state.status = 'shutting_down';

  logger.info({ signal }, 'Mordekiller shutting down');

  broadcast({
    type: 'server.shutdown',
    message: 'Server shutting down'
  });

  try {
    const bot = require('./src/bot');

    if (typeof bot.stop === 'function') {
      await bot.stop();
    }
  } catch (error) {
    logger.warn(
      {
        error: error.message
      },
      'Bot shutdown warning'
    );
  }

  for (const client of wss.clients) {
    try {
      client.close();
    } catch {}
  }

  wss.close();

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Forced shutdown');

    process.exit(1);
  }, 10000).unref();
}

/*
|--------------------------------------------------------------------------
| Process Safety
|--------------------------------------------------------------------------
*/

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.fatal(
    {
      error: error.message,
      stack: error.stack
    },
    'Uncaught exception'
  );

  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    {
      reason
    },
    'Unhandled promise rejection'
  );
});

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

startServer();

module.exports = {
  app,
  server,
  wss,
  state,
  broadcast
};
