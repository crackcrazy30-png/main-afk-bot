require('dotenv').config();
const mineflayer = require('mineflayer');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  ALLOWED_USER_IDS, // optional, comma separated
  MC_HOST,
  MC_PORT,
  MC_USERNAME,
  MC_AUTH, // "microsoft" or "offline"
  MC_VERSION, // optional, e.g. "1.20.4"
  AUTO_RECONNECT,
  PROFILES_DIR, // where the Microsoft login is cached (point at a Railway volume)
} = process.env;

const allowed = (ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

let bot = null;
let sneaking = false;
let manualStop = true; // true = user wants the bot offline
let reconnectTimer = null;

// ---------- Minecraft ----------

function startBot() {
  return new Promise((resolve, reject) => {
    if (bot) return reject(new Error('Bot is already online.'));

    manualStop = false;
    clearTimeout(reconnectTimer);

    const b = mineflayer.createBot({
      host: MC_HOST,
      port: Number(MC_PORT) || 25565,
      username: MC_USERNAME,
      auth: MC_AUTH || 'microsoft',
      version: MC_VERSION || undefined,
      profilesFolder: PROFILES_DIR || './auth-cache',
    });
    bot = b;

    let spawned = false;
    const timeout = setTimeout(() => {
      if (!spawned) {
        reject(new Error('Timed out connecting (30s).'));
        b.end();
      }
    }, 30000);

    b.once('spawn', () => {
      spawned = true;
      clearTimeout(timeout);
      console.log(`[MC] Logged in as ${b.username}`);
      if (sneaking) b.setControlState('sneak', true);
      resolve();
    });

    b.on('kicked', (reason) => console.log('[MC] Kicked:', reason));
    b.on('error', (err) => {
      console.log('[MC] Error:', err.message);
      if (!spawned) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    b.on('end', (reason) => {
      console.log('[MC] Disconnected:', reason);
      clearTimeout(timeout);
      if (bot === b) bot = null;
      if (!spawned) return;
      if (!manualStop && AUTO_RECONNECT === 'true') {
        console.log('[MC] Reconnecting in 15s...');
        reconnectTimer = setTimeout(() => startBot().catch((e) => console.log('[MC] Reconnect failed:', e.message)), 15000);
      }
    });
  });
}

function stopBot() {
  manualStop = true;
  clearTimeout(reconnectTimer);
  if (!bot) return false;
  bot.quit();
  bot = null;
  return true;
}

function setSneak(state) {
  sneaking = state;
  if (bot && bot.entity) bot.setControlState('sneak', state);
}

// ---------- Discord ----------

const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Log the bot into Minecraft'),
  new SlashCommandBuilder().setName('stop').setDescription('Log the bot out of Minecraft'),
  new SlashCommandBuilder()
    .setName('sneak')
    .setDescription('Toggle sneaking (or set it explicitly)')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Leave empty to toggle')),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID), { body: commands });
  console.log('[Discord] Slash commands registered.');
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (allowed.length && !allowed.includes(i.user.id)) {
    return i.reply({ content: "You're not allowed to use this bot.", ephemeral: true });
  }

  try {
    if (i.commandName === 'start') {
      await i.deferReply();
      if (bot) return i.editReply('Already logged in.');
      await startBot();
      return i.editReply(`✅ Logged in to \`${MC_HOST}\` as **${bot?.username ?? MC_USERNAME}**.`);
    }

    if (i.commandName === 'stop') {
      return i.reply(stopBot() ? '🛑 Logged out.' : 'Not logged in.');
    }

    if (i.commandName === 'sneak') {
      const opt = i.options.getBoolean('enabled');
      setSneak(opt === null ? !sneaking : opt);
      const note = bot ? '' : ' (bot is offline, it will apply on next login)';
      return i.reply(`🧎 Sneak is now **${sneaking ? 'ON' : 'OFF'}**${note}`);
    }
  } catch (err) {
    const msg = `❌ ${err.message}`;
    return i.deferred || i.replied ? i.editReply(msg) : i.reply(msg);
  }
});

client.login(DISCORD_TOKEN);
