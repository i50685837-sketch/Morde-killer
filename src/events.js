'use strict';

const pino = require('pino');
const {
  getContentType,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const {
  parseCommand,
  executeCommand
} = require('./commands');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const PREFIX =
  process.env.BOT_PREFIX || '.';

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function unwrapMessage(message) {
  if (!message) return null;

  let current = message;

  // Remove common Baileys wrappers.
  while (
    current?.ephemeralMessage ||
    current?.viewOnceMessage ||
    current?.viewOnceMessageV2 ||
    current?.viewOnceMessageV2Extension
  ) {
    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current;
  }

  return current;
}

function extractText(message) {
  const content = unwrapMessage(message);

  if (!content) return '';

  const type =
    getContentType(content);

  if (type === 'conversation') {
    return content.conversation || '';
  }

  if (type === 'extendedTextMessage') {
    return (
      content.extendedTextMessage?.text ||
      ''
    );
  }

  if (type === 'imageMessage') {
    return (
      content.imageMessage?.caption ||
      ''
    );
  }

  if (type === 'videoMessage') {
    return (
      content.videoMessage?.caption ||
      ''
    );
  }

  return '';
}

function getMessageText(message) {
  return extractText(message).trim();
}

function getSender(message, remoteJid) {
  const participant =
    message?.key?.participant;

  if (participant) {
    return jidNormalizedUser(
      participant
    );
  }

  return jidNormalizedUser(
    remoteJid || ''
  );
}

function isGroup(remoteJid) {
  return String(
    remoteJid || ''
  ).endsWith('@g.us');
}

function getMentionedJids(message) {
  const content =
    unwrapMessage(message);

  const type =
    getContentType(content);

  if (
    type === 'extendedTextMessage'
  ) {
    return (
      content.extendedTextMessage
        ?.contextInfo
        ?.mentionedJid || []
    );
  }

  return [];
}

/*
|--------------------------------------------------------------------------
| Admin Detection
|--------------------------------------------------------------------------
|
| This checks group metadata when available.
|--------------------------------------------------------------------------
*/

async function getGroupContext(
  sock,
  remoteJid,
  sender
) {
  if (!isGroup(remoteJid)) {
    return {
      isGroup: false,
      isAdmin: false,
      isBotAdmin: false,
      metadata: null
    };
  }

  try {
    const metadata =
      await sock.groupMetadata(
        remoteJid
      );

    const participants =
      metadata.participants || [];

    const senderParticipant =
      participants.find(
        participant =>
          jidNormalizedUser(
            participant.id
          ) === jidNormalizedUser(
            sender
          )
      );

    const botJid =
      jidNormalizedUser(
        sock.user?.id || ''
      );

    const botParticipant =
      participants.find(
        participant =>
          jidNormalizedUser(
            participant.id
          ) === botJid
      );

    const senderAdmin =
      senderParticipant?.admin;

    const botAdmin =
      botParticipant?.admin;

    return {
      isGroup: true,

      isAdmin:
        senderAdmin === 'admin' ||
        senderAdmin === 'superadmin',

      isBotAdmin:
        botAdmin === 'admin' ||
        botAdmin === 'superadmin',

      metadata
    };

  } catch (error) {
    logger.warn(
      {
        group: remoteJid,
        error: error.message
      },
      'Unable to obtain group metadata'
    );

    return {
      isGroup: true,
      isAdmin: false,
      isBotAdmin: false,
      metadata: null
    };
  }
}

/*
|--------------------------------------------------------------------------
| Safe Reply
|--------------------------------------------------------------------------
*/

async function reply(
  sock,
  remoteJid,
  text,
  quoted
) {
  if (!text) return null;

  return sock.sendMessage(
    remoteJid,
    {
      text: String(text)
    },
    quoted
      ? {
          quoted
        }
      : undefined
  );
}

/*
|--------------------------------------------------------------------------
| Command Response Handler
|--------------------------------------------------------------------------
*/

async function handleCommandResult(
  sock,
  remoteJid,
  result,
  quoted
) {
  if (!result) return;

  if (
    result.success === false &&
    result.reason === 'cooldown'
  ) {
    const seconds =
      Math.ceil(
        result.remaining / 1000
      );

    return reply(
      sock,
      remoteJid,
      `⏳ Please wait ${seconds}s before using that command again.`,
      quoted
    );
  }

  if (
    result.success === false &&
    result.reason ===
      'permission_denied'
  ) {
    return reply(
      sock,
      remoteJid,
      '⛔ You do not have permission to use this command.',
      quoted
    );
  }

  if (
    result.success === false &&
    result.reason ===
      'execution_error'
  ) {
    return reply(
      sock,
      remoteJid,
      '❌ Something went wrong while executing that command.',
      quoted
    );
  }

  /*
   * A command can return a string directly.
   */

  if (
    typeof result.result ===
    'string'
  ) {
    return reply(
      sock,
      remoteJid,
      result.result,
      quoted
    );
  }

  /*
   * A command can return:
   *
   * {
   *   text: "Hello"
   * }
   */

  if (
    result.result &&
    typeof result.result.text ===
      'string'
  ) {
    return reply(
      sock,
      remoteJid,
      result.result.text,
      quoted
    );
  }
}

/*
|--------------------------------------------------------------------------
| Message Handler
|--------------------------------------------------------------------------
*/

async function handleMessage(
  sock,
  message
) {
  try {
    if (!message?.message) {
      return;
    }

    const remoteJid =
      message.key?.remoteJid;

    if (!remoteJid) {
      return;
    }

    /*
     * Ignore status broadcasts.
     */

    if (
      remoteJid ===
      'status@broadcast'
    ) {
      return;
    }

    /*
     * Ignore messages sent by the bot itself
     * unless explicitly enabled.
     */

    if (
      message.key?.fromMe &&
      process.env.ALLOW_SELF_COMMANDS !==
        'true'
    ) {
      return;
    }

    const text =
      getMessageText(
        message.message
      );

    if (!text) {
      return;
    }

    /*
     * Only process prefixed commands.
     */

    if (
      !text.startsWith(PREFIX)
    ) {
      return;
    }

    const parsed =
      parseCommand(text);

    if (!parsed) {
      return;
    }

    const sender =
      getSender(
        message,
        remoteJid
      );

    const group =
      await getGroupContext(
        sock,
        remoteJid,
        sender
      );

    logger.info(
      {
        command:
          parsed.name,
        sender,
        remoteJid,
        isGroup:
          group.isGroup
      },
      'Command received'
    );

    /*
     * Context passed to commands.
     */

    const context = {
      sock,

      message,

      sender,

      remoteJid,

      isGroup:
        group.isGroup,

      isAdmin:
        group.isAdmin,

      isBotAdmin:
        group.isBotAdmin,

      groupMetadata:
        group.metadata,

      mentionedJids:
        getMentionedJids(
          message.message
        ),

      args:
        parsed.args,

      text:
        parsed.text,

      raw:
        parsed.raw,

      command:
        parsed.name,

      reply: async text =>
        reply(
          sock,
          remoteJid,
          text,
          message
        )
    };

    /*
     * Execute command.
     */

    const result =
      await executeCommand(
        parsed,
        context
      );

    /*
     * Unknown command.
     */

    if (
      !result.handled &&
      result.reason ===
        'unknown_command'
    ) {
      return;
    }

    await handleCommandResult(
      sock,
      remoteJid,
      result,
      message
    );

  } catch (error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack
      },
      'Message handler failed'
    );
  }
}

/*
|--------------------------------------------------------------------------
| Register Baileys Events
|--------------------------------------------------------------------------
*/

function register(
  sock,
  options = {}
) {
  if (!sock) {
    throw new Error(
      'Baileys socket is required'
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Incoming Messages
  |--------------------------------------------------------------------------
  */

  sock.ev.on(
    'messages.upsert',
    async event => {
      if (
        !event?.messages ||
        !Array.isArray(
          event.messages
        )
      ) {
        return;
      }

      /*
       * Process messages sequentially.
       * This avoids several commands racing
       * against each other.
       */

      for (const message of event.messages) {
        await handleMessage(
          sock,
          message
        );
      }
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Message Updates
  |--------------------------------------------------------------------------
  */

  sock.ev.on(
    'messages.update',
    updates => {
      if (!Array.isArray(updates)) {
        return;
      }

      logger.debug(
        {
          count:
            updates.length
        },
        'Message updates received'
      );
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Presence Updates
  |--------------------------------------------------------------------------
  */

  sock.ev.on(
    'presence.update',
    update => {
      logger.debug(
        {
          jid: update.id
        },
        'Presence update'
      );
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Group Participant Updates
  |--------------------------------------------------------------------------
  */

  sock.ev.on(
    'group-participants.update',
    update => {
      logger.info(
        {
          group:
            update.id,
          action:
            update.action,
          participants:
            update.participants
        },
        'Group participant update'
      );
    }
  );

  logger.info(
    'WhatsApp event handlers registered'
  );

  return {
    handleMessage
  };
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  register,
  handleMessage,
  extractText,
  getMessageText,
  getSender,
  getGroupContext
};
