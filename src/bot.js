'use strict';

const fs = require('fs');
const path = require('path');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const AUTH_DIR = path.join(
  __dirname,
  '..',
  'auth',
  'session'
);

let sock = null;
let updateStatus = () => {};
let broadcast = () => {};

let starting = false;
let stopping = false;
let reconnectTimer = null;

/*
|--------------------------------------------------------------------------
| Ensure Authentication Directory
|--------------------------------------------------------------------------
*/

function ensureAuthDirectory() {
  fs.mkdirSync(AUTH_DIR, {
    recursive: true
  });
}

/*
|--------------------------------------------------------------------------
| Status Helper
|--------------------------------------------------------------------------
*/

function setStatus(data) {
  try {
    updateStatus(data);

    broadcast({
      type: 'whatsapp.status',
      data
    });
  } catch (error) {
    logger.warn(
      {
        error: error.message
      },
      'Unable to broadcast status'
    );
  }
}

/*
|--------------------------------------------------------------------------
| Connection State
|--------------------------------------------------------------------------
*/

function connectionStatus(state, extra = {}) {
  setStatus({
    state,
    connected: state === 'connected',
    ...extra
  });
}

/*
|--------------------------------------------------------------------------
| Start Bot
|--------------------------------------------------------------------------
*/

async function start(options = {}) {
  if (starting || stopping) {
    return;
  }

  starting = true;
  stopping = false;

  updateStatus =
    typeof options.updateStatus === 'function'
      ? options.updateStatus
      : () => {};

  broadcast =
    typeof options.broadcast === 'function'
      ? options.broadcast
      : () => {};

  ensureAuthDirectory();

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;

      logger.info(
        {
          version: version.join('.')
        },
        'Using Baileys WhatsApp version'
      );
    } catch (error) {
      logger.warn(
        {
          error: error.message
        },
        'Unable to fetch latest WhatsApp version'
      );
    }

    sock = makeWASocket({
      auth: state,

      ...(version ? { version } : {}),

      logger: pino({
        level: process.env.BAILEYS_LOG_LEVEL || 'silent'
      }),

      printQRInTerminal: false,

      browser: [
        'Mordekiller',
        'Chrome',
        '1.0.0'
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false
    });

    /*
    |--------------------------------------------------------------------------
    | Save Authentication Credentials
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    /*
    |--------------------------------------------------------------------------
    | Connection Updates
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      'connection.update',
      async (update) => {
        const {
          connection,
          lastDisconnect
        } = update;

        if (connection === 'connecting') {
          logger.info(
            'Mordekiller connecting to WhatsApp...'
          );

          connectionStatus('connecting');
        }

        if (connection === 'open') {
          logger.info(
            'Mordekiller connected to WhatsApp'
          );

          connectionStatus('connected');

          starting = false;

          return;
        }

        if (connection === 'close') {
          starting = false;

          const error =
            lastDisconnect?.error;

          const statusCode =
            error?.output?.statusCode;

          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut &&
            !stopping;

          connectionStatus(
            'disconnected',
            {
              reason: statusCode || 'unknown'
            }
          );

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            logger.warn(
              'WhatsApp session logged out'
            );

            connectionStatus(
              'logged_out'
            );

            return;
          }

          if (shouldReconnect) {
            scheduleReconnect();
          }
        }
      }
    );

    /*
    |--------------------------------------------------------------------------
    | Message/Event Hooks
    |--------------------------------------------------------------------------
    |
    | events.js will be attached here later.
    |
    */

    try {
      const events = require('./events');

      if (
        typeof events.register ===
        'function'
      ) {
        events.register(sock, {
          broadcast
        });
      }
    } catch (error) {
      logger.warn(
        {
          error: error.message
        },
        'Events module unavailable'
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Command System
    |--------------------------------------------------------------------------
    */

    try {
      const commands =
        require('./commands');

      if (
        typeof commands.register ===
        'function'
      ) {
        commands.register(sock);
      }
    } catch (error) {
      logger.warn(
        {
          error: error.message
        },
        'Commands module unavailable'
      );
    }

    logger.info(
      'Mordekiller bot initialized'
    );

  } catch (error) {
    starting = false;

    logger.error(
      {
        error: error.message,
        stack: error.stack
      },
      'Failed to initialize Mordekiller'
    );

    connectionStatus(
      'error',
      {
        error: error.message
      }
    );

    scheduleReconnect();
  }
}

/*
|--------------------------------------------------------------------------
| Automatic Reconnection
|--------------------------------------------------------------------------
*/

function scheduleReconnect() {
  if (stopping) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  logger.info(
    'Mordekiller will reconnect in 5 seconds'
  );

  reconnectTimer = setTimeout(
    async () => {
      reconnectTimer = null;

      try {
        await start();
      } catch (error) {
        logger.error(
          {
            error: error.message
          },
          'Reconnect failed'
        );
      }
    },
    5000
  );
}

/*
|--------------------------------------------------------------------------
| Pairing Code
|--------------------------------------------------------------------------
|
| Call this from a protected API route.
|
| Example:
| await getPairingCode('+254700000000');
|
*/

async function getPairingCode(phoneNumber) {
  if (!sock) {
    throw new Error(
      'WhatsApp socket is not initialized'
    );
  }

  if (
    typeof sock.requestPairingCode !==
    'function'
  ) {
    throw new Error(
      'Pairing-code support is unavailable'
    );
  }

  if (!phoneNumber) {
    throw new Error(
      'Phone number is required'
    );
  }

  const number = String(
    phoneNumber
  ).replace(/\D/g, '');

  if (number.length < 8) {
    throw new Error(
      'Invalid phone number'
    );
  }

  if (
    sock.authState?.creds?.registered
  ) {
    throw new Error(
      'This session is already registered'
    );
  }

  const code =
    await sock.requestPairingCode(
      number
    );

  logger.info(
    'WhatsApp pairing code generated'
  );

  return code;
}

/*
|--------------------------------------------------------------------------
| Get Socket
|--------------------------------------------------------------------------
*/

function getSocket() {
  return sock;
}

/*
|--------------------------------------------------------------------------
| Bot Information
|--------------------------------------------------------------------------
*/

function getStatus() {
  return {
    initialized: Boolean(sock),

    connected:
      Boolean(
        sock?.user
      ),

    user:
      sock?.user
        ? {
            id: sock.user.id,
            name:
              sock.user.name || null
          }
        : null
  };
}

/*
|--------------------------------------------------------------------------
| Stop Bot
|--------------------------------------------------------------------------
*/

async function stop() {
  stopping = true;
  starting = false;

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  if (!sock) {
    return;
  }

  try {
    sock.ev.removeAllListeners();

    if (
      typeof sock.end ===
      'function'
    ) {
      sock.end(
        new Error(
          'Mordekiller shutting down'
        )
      );
    }

  } catch (error) {
    logger.warn(
      {
        error: error.message
      },
      'Bot shutdown warning'
    );
  }

  sock = null;

  connectionStatus(
    'stopped'
  );

  logger.info(
    'Mordekiller bot stopped'
  );
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  start,
  stop,
  getSocket,
  getStatus,
  getPairingCode
};
