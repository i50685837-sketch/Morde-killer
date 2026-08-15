'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

/*
|--------------------------------------------------------------------------
| Command Registry
|--------------------------------------------------------------------------
*/

const commands = new Map();
const aliases = new Map();
const cooldowns = new Map();

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const PREFIX =
  process.env.BOT_PREFIX || '.';

const DEFAULT_COOLDOWN =
  Number(process.env.COMMAND_COOLDOWN_MS) || 2000;

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function normalizeName(name) {
  return String(name)
    .trim()
    .toLowerCase();
}

function normalizeJid(jid) {
  if (!jid) return '';

  return String(jid)
    .trim()
    .toLowerCase();
}

function isGroupJid(jid) {
  return String(jid).endsWith('@g.us');
}

function getCommand(name) {
  const normalized =
    normalizeName(name);

  return (
    commands.get(normalized) ||
    commands.get(
      aliases.get(normalized)
    )
  );
}

function getCooldownKey(
  commandName,
  sender
) {
  return `${commandName}:${normalizeJid(sender)}`;
}

function isOnCooldown(
  commandName,
  sender
) {
  const key =
    getCooldownKey(
      commandName,
      sender
    );

  const expires =
    cooldowns.get(key);

  if (!expires) {
    return {
      active: false,
      remaining: 0
    };
  }

  const remaining =
    expires - Date.now();

  if (remaining <= 0) {
    cooldowns.delete(key);

    return {
      active: false,
      remaining: 0
    };
  }

  return {
    active: true,
    remaining
  };
}

function setCooldown(
  commandName,
  sender,
  duration
) {
  if (!duration || duration <= 0) {
    return;
  }

  const key =
    getCooldownKey(
      commandName,
      sender
    );

  cooldowns.set(
    key,
    Date.now() + duration
  );
}

/*
|--------------------------------------------------------------------------
| Permission System
|--------------------------------------------------------------------------
*/

function isOwner(sender) {
  const owners =
    String(
      process.env.BOT_OWNER || ''
    )
      .split(',')
      .map(normalizeJid)
      .filter(Boolean);

  return owners.includes(
    normalizeJid(sender)
  );
}

function hasPermission(
  command,
  context
) {
  const permission =
    command.permission || 'public';

  if (permission === 'public') {
    return true;
  }

  if (permission === 'owner') {
    return isOwner(
      context.sender
    );
  }

  if (permission === 'group') {
    return context.isGroup === true;
  }

  if (permission === 'admin') {
    return (
      context.isGroup === true &&
      context.isAdmin === true
    );
  }

  return false;
}

/*
|--------------------------------------------------------------------------
| Register Command
|--------------------------------------------------------------------------
*/

function registerCommand(command) {
  if (!command || typeof command !== 'object') {
    throw new TypeError(
      'Command must be an object'
    );
  }

  if (
    typeof command.name !==
    'string'
  ) {
    throw new TypeError(
      'Command name is required'
    );
  }

  if (
    typeof command.execute !==
    'function'
  ) {
    throw new TypeError(
      `Command "${command.name}" needs an execute function`
    );
  }

  const name =
    normalizeName(command.name);

  if (!name) {
    throw new Error(
      'Command name cannot be empty'
    );
  }

  if (commands.has(name)) {
    throw new Error(
      `Command "${name}" is already registered`
    );
  }

  const normalized = {
    name,

    description:
      command.description ||
      'No description available.',

    usage:
      command.usage ||
      `${PREFIX}${name}`,

    aliases: Array.isArray(
      command.aliases
    )
      ? command.aliases.map(
          normalizeName
        )
      : [],

    permission:
      command.permission ||
      'public',

    cooldown:
      Number.isFinite(
        command.cooldown
      )
        ? command.cooldown
        : DEFAULT_COOLDOWN,

    execute:
      command.execute
  };

  commands.set(
    name,
    normalized
  );

  for (const alias of normalized.aliases) {
    if (!alias) continue;

    if (
      commands.has(alias) ||
      aliases.has(alias)
    ) {
      logger.warn(
        {
          alias,
          command: name
        },
        'Command alias already exists'
      );

      continue;
    }

    aliases.set(
      alias,
      name
    );
  }

  logger.info(
    {
      command: name
    },
    'Command registered'
  );

  return normalized;
}

/*
|--------------------------------------------------------------------------
| Unregister Command
|--------------------------------------------------------------------------
*/

function unregisterCommand(name) {
  const command =
    getCommand(name);

  if (!command) {
    return false;
  }

  commands.delete(
    command.name
  );

  for (const alias of command.aliases) {
    aliases.delete(alias);
  }

  return true;
}

/*
|--------------------------------------------------------------------------
| Parse Command
|--------------------------------------------------------------------------
*/

function parseCommand(text) {
  if (
    typeof text !==
    'string'
  ) {
    return null;
  }

  const trimmed =
    text.trim();

  if (
    !trimmed.startsWith(PREFIX)
  ) {
    return null;
  }

  const withoutPrefix =
    trimmed.slice(
      PREFIX.length
    ).trim();

  if (!withoutPrefix) {
    return null;
  }

  const parts =
    withoutPrefix.split(
      /\s+/
    );

  const name =
    normalizeName(parts.shift());

  return {
    name,
    args: parts,
    text: parts.join(' '),
    raw: trimmed
  };
}

/*
|--------------------------------------------------------------------------
| Execute Command
|--------------------------------------------------------------------------
*/

async function executeCommand(
  parsed,
  context = {}
) {
  if (!parsed) {
    return {
      handled: false,
      reason: 'not_command'
    };
  }

  const command =
    getCommand(parsed.name);

  if (!command) {
    return {
      handled: false,
      reason: 'unknown_command'
    };
  }

  const sender =
    context.sender || '';

  /*
  |--------------------------------------------------------------------------
  | Permission
  |--------------------------------------------------------------------------
  */

  if (
    !hasPermission(
      command,
      context
    )
  ) {
    return {
      handled: true,
      success: false,
      reason: 'permission_denied',
      message:
        'You do not have permission to use this command.'
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Cooldown
  |--------------------------------------------------------------------------
  */

  const cooldown =
    isOnCooldown(
      command.name,
      sender
    );

  if (cooldown.active) {
    return {
      handled: true,
      success: false,
      reason: 'cooldown',
      remaining:
        cooldown.remaining
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Execute
  |--------------------------------------------------------------------------
  */

  try {
    setCooldown(
      command.name,
      sender,
      command.cooldown
    );

    const result =
      await command.execute({
        ...context,

        command,
        args: parsed.args,
        text: parsed.text,
        raw: parsed.raw
      });

    return {
      handled: true,
      success: true,
      result
    };

  } catch (error) {
    logger.error(
      {
        command:
          command.name,
        error:
          error.message,
        stack:
          error.stack
      },
      'Command execution failed'
    );

    return {
      handled: true,
      success: false,
      reason: 'execution_error',
      message:
        'An error occurred while executing the command.'
    };
  }
}

/*
|--------------------------------------------------------------------------
| Built-in Help Command
|--------------------------------------------------------------------------
*/

registerCommand({
  name: 'help',

  aliases: [
    'menu',
    'commands'
  ],

  description:
    'Show available commands.',

  usage:
    `${PREFIX}help`,

  cooldown: 3000,

  async execute({
    reply
  }) {
    const list =
      [...commands.values()]
        .map(
          (command) =>
            `${command.usage} — ${command.description}`
        )
        .join('\n');

    const message =
      `╭━━━〔 MORDEKILLER 〕━━━╮\n` +
      `┃\n` +
      `┃ Available Commands\n` +
      `┃\n` +
      `${list
        .split('\n')
        .map(
          line => `┃ ${line}`
        )
        .join('\n')}\n` +
      `┃\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯`;

    if (typeof reply === 'function') {
      return reply(message);
    }

    return message;
  }
});

/*
|--------------------------------------------------------------------------
| Ping Command
|--------------------------------------------------------------------------
*/

registerCommand({
  name: 'ping',

  description:
    'Check whether Mordekiller is responding.',

  usage:
    `${PREFIX}ping`,

  cooldown: 1000,

  async execute({
    reply
  }) {
    const start =
      Date.now();

    const latency =
      Date.now() - start;

    const message =
      `🏓 Pong!\n` +
      `⚡ Response: ${latency}ms\n` +
      `🤖 Mordekiller: Online`;

    if (typeof reply === 'function') {
      return reply(message);
    }

    return message;
  }
});

/*
|--------------------------------------------------------------------------
| Bot Information
|--------------------------------------------------------------------------
*/

registerCommand({
  name: 'botinfo',

  aliases: [
    'info'
  ],

  description:
    'Show Mordekiller information.',

  usage:
    `${PREFIX}botinfo`,

  cooldown: 3000,

  async execute({
    reply
  }) {
    const message =
      `🤖 *Mordekiller*\n\n` +
      `⚡ Node.js WhatsApp Bot\n` +
      `🔌 Baileys Engine\n` +
      `🌐 WebSocket Dashboard\n` +
      `📦 Modular Command System`;

    if (typeof reply === 'function') {
      return reply(message);
    }

    return message;
  }
});

/*
|--------------------------------------------------------------------------
| Register API
|--------------------------------------------------------------------------
*/

function register() {
  /*
   * Commands are registered automatically when
   * registerCommand() is called.
   *
   * This function exists so bot.js can initialize
   * the command system cleanly.
   */

  logger.info(
    {
      commands:
        commands.size
    },
    'Command system initialized'
  );

  return {
    count:
      commands.size
  };
}

/*
|--------------------------------------------------------------------------
| List Commands
|--------------------------------------------------------------------------
*/

function listCommands() {
  return [...commands.values()].map(
    command => ({
      name: command.name,
      aliases: command.aliases,
      description:
        command.description,
      usage:
        command.usage,
      permission:
        command.permission
    })
  );
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
  register,
  registerCommand,
  unregisterCommand,
  parseCommand,
  executeCommand,
  getCommand,
  listCommands,
  isOwner
};
