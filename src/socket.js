'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const CLIENT_TIMEOUT =
  Number(process.env.WS_CLIENT_TIMEOUT_MS) || 30000;

const MAX_MESSAGE_SIZE =
  Number(process.env.WS_MAX_MESSAGE_SIZE) || 8192;

const clients = new Set();

let socketServer = null;
let getState = () => ({});

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) {
    return false;
  }

  try {
    ws.send(
      JSON.stringify({
        ...payload,
        timestamp: now()
      })
    );

    return true;
  } catch (error) {
    logger.warn(
      { error: error.message },
      'WebSocket send failed'
    );

    return false;
  }
}

function broadcast(payload) {
  let sent = 0;

  for (const client of clients) {
    if (safeSend(client.ws, payload)) {
      sent++;
    }
  }

  return sent;
}

/*
|--------------------------------------------------------------------------
| Client Cleanup
|--------------------------------------------------------------------------
*/

function removeClient(client) {
  if (!client) return;

  clients.delete(client);

  if (client.timer) {
    clearInterval(client.timer);
    client.timer = null;
  }

  logger.info(
    {
      clientId: client.id
    },
    'WebSocket client removed'
  );
}

/*
|--------------------------------------------------------------------------
| Incoming Message Validation
|--------------------------------------------------------------------------
*/

function parseMessage(raw) {
  const text =
    Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : String(raw);

  if (
    Buffer.byteLength(text, 'utf8') >
    MAX_MESSAGE_SIZE
  ) {
    throw new Error(
      'WebSocket message is too large'
    );
  }

  let message;

  try {
    message = JSON.parse(text);
  } catch {
    throw new Error(
      'Invalid JSON'
    );
  }

  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    throw new Error(
      'Message must be a JSON object'
    );
  }

  if (
    typeof message.type !== 'string'
  ) {
    throw new Error(
      'Message type is required'
    );
  }

  return message;
}

/*
|--------------------------------------------------------------------------
| Message Router
|--------------------------------------------------------------------------
*/

async function handleMessage(
  client,
  message,
  context
) {
  switch (message.type) {

    case 'ping':
      safeSend(client.ws, {
        type: 'pong'
      });
      break;

    case 'status':
      safeSend(client.ws, {
        type: 'status',
        data: getState()
      });
      break;

    case 'bot.status':
      safeSend(client.ws, {
        type: 'bot.status',
        data: getState().whatsapp || {}
      });
      break;

    case 'dashboard.connect':
      safeSend(client.ws, {
        type: 'dashboard.ready',
        data: {
          clientId: client.id,
          bot: 'Mordekiller',
          status: getState()
        }
      });
      break;

    default:
      /*
       * Unknown commands are deliberately rejected.
       * Add authenticated dashboard commands here later.
       */

      safeSend(client.ws, {
        type: 'error',
        code: 'UNKNOWN_EVENT',
        message:
          `Unknown event: ${message.type}`
      });

      logger.debug(
        {
          type: message.type,
          clientId: client.id
        },
        'Unknown WebSocket event'
      );
  }
}

/*
|--------------------------------------------------------------------------
| Client Setup
|--------------------------------------------------------------------------
*/

function setupClient(ws, request) {
  const client = {
    id: createId(),
    ws,
    connectedAt: now(),
    ip:
      request.socket.remoteAddress ||
      null,
    authenticated: false,
    timer: null
  };

  clients.add(client);

  /*
  |--------------------------------------------------------------------------
  | Initial Connection
  |--------------------------------------------------------------------------
  */

  safeSend(ws, {
    type: 'connection',
    data: {
      clientId: client.id,
      connected: true,
      bot: 'Mordekiller'
    }
  });

  safeSend(ws, {
    type: 'status',
    data: getState()
  });

  /*
  |--------------------------------------------------------------------------
  | Heartbeat
  |--------------------------------------------------------------------------
  */

  client.timer = setInterval(() => {
    if (ws.readyState !== 1) {
      removeClient(client);
      return;
    }

    safeSend(ws, {
      type: 'heartbeat'
    });
  }, CLIENT_TIMEOUT);

  /*
  |--------------------------------------------------------------------------
  | Incoming Data
  |--------------------------------------------------------------------------
  */

  ws.on('message', async raw => {
    try {
      const message =
        parseMessage(raw);

      await handleMessage(
        client,
        message,
        {
          client,
          request
        }
      );

    } catch (error) {
      logger.warn(
        {
          clientId: client.id,
          error: error.message
        },
        'Invalid WebSocket request'
      );

      safeSend(ws, {
        type: 'error',
        code: 'INVALID_REQUEST',
        message: error.message
      });
    }
  });

  /*
  |--------------------------------------------------------------------------
  | Close
  |--------------------------------------------------------------------------
  */

  ws.on('close', (code, reason) => {
    logger.info(
      {
        clientId: client.id,
        code,
        reason:
          reason?.toString() || ''
      },
      'WebSocket connection closed'
    );

    removeClient(client);
  });

  /*
  |--------------------------------------------------------------------------
  | Errors
  |--------------------------------------------------------------------------
  */

  ws.on('error', error => {
    logger.warn(
      {
        clientId: client.id,
        error: error.message
      },
      'WebSocket client error'
    );

    removeClient(client);
  });

  return client;
}

/*
|--------------------------------------------------------------------------
| Create WebSocket Server
|--------------------------------------------------------------------------
*/

function createSocketServer(
  server,
  options = {}
) {
  if (!server) {
    throw new Error(
      'HTTP server is required'
    );
  }

  if (socketServer) {
    return socketServer;
  }

  if (
    typeof options.getState ===
    'function'
  ) {
    getState =
      options.getState;
  }

  socketServer =
    new WebSocketServer({
      server,
      path:
        options.path || '/ws',

      maxPayload:
        MAX_MESSAGE_SIZE,

      clientTracking: false
    });

  socketServer.on(
    'connection',
    (ws, request) => {
      logger.info(
        {
          ip:
            request.socket
              .remoteAddress
        },
        'WebSocket client connected'
      );

      setupClient(
        ws,
        request
      );
    }
  );

  socketServer.on(
    'error',
    error => {
      logger.error(
        {
          error: error.message
        },
        'WebSocket server error'
      );
    }
  );

  logger.info(
    {
      path:
        options.path || '/ws'
    },
    'Mordekiller WebSocket server initialized'
  );

  return socketServer;
}

/*
|--------------------------------------------------------------------------
| Broadcast Helpers
|--------------------------------------------------------------------------
*/

function broadcastStatus(state) {
  return broadcast({
    type: 'status',
    data: state
  });
}

function broadcastWhatsAppStatus(
  status
) {
  return broadcast({
    type: 'whatsapp.status',
    data: status
  });
}

function broadcastLog(
  level,
  message,
  meta = {}
) {
  return broadcast({
    type: 'log',
    data: {
      level,
      message,
      meta
    }
  });
}

/*
|--------------------------------------------------------------------------
| Statistics
|--------------------------------------------------------------------------
*/

function getClientCount() {
  return clients.size;
}

function getClients() {
  return [...clients].map(
    client => ({
      id: client.id,
      ip: client.ip,
      connectedAt:
        client.connectedAt,
      authenticated:
        client.authenticated
    })
  );
}

/*
|--------------------------------------------------------------------------
| Shutdown
|--------------------------------------------------------------------------
*/

function close() {
  for (const client of clients) {
    try {
      client.ws.close();
    } catch {}
  }

  clients.clear();

  if (socketServer) {
    socketServer.close();
    socketServer = null;
  }

  logger.info(
    'Mordekiller WebSocket server closed'
  );
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  createSocketServer,
  broadcast,
  broadcastStatus,
  broadcastWhatsAppStatus,
  broadcastLog,
  getClientCount,
  getClients,
  close
};
