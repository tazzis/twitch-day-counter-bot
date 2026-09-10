/**
 * Twitch chat bot (Railway-ready version).
 *
 * At a random interval between 10 and 15 minutes, it posts ONE of
 * three randomly chosen message types:
 *
 *   1) "Через 1 день понедельник"   (a counter that ticks up every
 *      time the bot fires, never resets — shows the weekday that
 *      will fall N ticks from today)
 *   2) "Я заказал новый телефон, но пришли мясо и угли, значит
 *      сегодня будет шашлык."       (random item from a list)
 *   3) "А твоя прическа знает что сегодня среда?"   (today's weekday)
 *
 * ---------------------------------------------------------------
 * SETUP
 * ---------------------------------------------------------------
 * 1. Install dependency:
 *      npm install tmi.js
 *
 * 2. Get an OAuth token for the bot account:
 *      https://twitchapps.com/tmi/
 *    (log in as the account that will post the messages, copy the
 *    "oauth:xxxxxxxx" token it gives you)
 *
 * 3. Set the environment variables before running (or edit the
 *    CONFIG block below directly):
 *      TWITCH_BOT_USERNAME   - the bot/account username
 *      TWITCH_OAUTH_TOKEN    - the oauth:... token from step 2
 *      TWITCH_CHANNEL        - channel to post in (without #)
 *      PORT                  - injected automatically by Railway
 *
 * 4. Run:
 *      node day-counter-bot.js
 * ---------------------------------------------------------------
 *
 * CHANGES IN THIS VERSION (vs the one that "just stops"):
 *   + HTTP keep-alive server bound to $PORT — answers healthchecks
 *   + manual retry-with-backoff if the INITIAL connect fails
 *     (before: connect error was caught once, process had nothing
 *     left to do and Node exited cleanly with code 0 -> Railway
 *     stops the container instead of restarting it)
 *   + SIGTERM / unhandledRejection / uncaughtException logging so
 *     logs clearly distinguish "platform stopped the container"
 *     from "the bot crashed"
 *   + explicit infinite tmi.js reconnect settings
 *   + FIX: readyState is a method in tmi.js (calling it as a property
 *     made the tick guard always skip — bot would post nothing)
 */

const tmi = require('tmi.js');
const http = require('http');

// ---------------- CONFIG ----------------
const CONFIG = {
  username: process.env.TWITCH_BOT_USERNAME || 'your_bot_username',
  password: process.env.TWITCH_OAUTH_TOKEN || 'oauth:your_token_here',
  channel: process.env.TWITCH_CHANNEL || 'target_channel',
  minIntervalMs: 10 * 60 * 1000, // 10 minutes
  maxIntervalMs: 15 * 60 * 1000, // 15 minutes
};
// -----------------------------------------

const WEEKDAYS_RU = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];

// Items for the "Я заказал ..." message. Add/remove as you like.
const RANDOM_ITEMS = [
  'новый телефон',
  'кроссовки',
  'ноутбук',
  'диван',
  'велосипед',
  'наушники',
  'микроволновку',
  'офисное кресло',
  'книжную полку',
  'клавиатуру',
];

/** Correct Russian pluralization: 1 день, 2-4 дня, 5-20 дней, 21 день, 22 дня, ... */
function pluralizeDays(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

function weekdayInNDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return WEEKDAYS_RU[d.getDay()];
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInterval() {
  return Math.floor(
    Math.random() * (CONFIG.maxIntervalMs - CONFIG.minIntervalMs + 1) + CONFIG.minIntervalMs
  );
}

function now() {
  return new Date().toTimeString().slice(0, 5);
}

// ---------------- Message builders ----------------
function messageDayCounter(dayCount) {
  const word = pluralizeDays(dayCount);
  const weekday = weekdayInNDays(dayCount);
  return `Через ${dayCount} ${word} ${weekday}`;
}

function messageShashlik() {
  const item = randomItem(RANDOM_ITEMS);
  return `Я заказал ${item}, но пришли мясо и угли, значит сегодня будет шашлык.`;
}

function messageHaircut() {
  const weekday = weekdayInNDays(0); // today
  return `А твоя прическа знает что сегодня ${weekday}?`;
}

// ---------------- Keep-alive HTTP server ----------------
// Railway injects PORT. Binding it (a) lets you configure a healthcheck
// on "/" in the service settings, and (b) guarantees the process always
// has an active handle, so Node can never exit cleanly by accident.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => {
  console.log(`Keep-alive server listening on port ${PORT}`);
});

// ---------------- Diagnostics ----------------
// These make it obvious in Railway logs WHY the process ended, next time.
process.on('SIGTERM', () => {
  console.log('Received SIGTERM — the platform is stopping the container (deploy, manual stop, or platform decision). Not a bot crash.');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('Received SIGINT — shutting down.');
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${now()}] Unhandled rejection (kept alive):`, reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${now()}] Uncaught exception (kept alive):`, err);
});

// ---------------- BOT ----------------
let client = null;
let dayCount = 0;
let schedulerStarted = false; // guard against a second timer loop
let reconnectDelayMs = 5000;  // initial-connect backoff: 5s -> 10s -> ... -> 60s max

function createClient() {
  client = new tmi.Client({
    connection: {
      reconnect: true,       // auto-reconnect if the connection to Twitch drops
      secure: true,
      reconnectInterval: 2000,
      maxReconnectInterval: 30000,
      reconnectDecay: 1.5,
      maxReconnectAttempts: Infinity, // never give up reconnecting to Twitch
      timeout: 180000,
    },
    identity: {
      username: CONFIG.username,
      password: CONFIG.password,
    },
    channels: [CONFIG.channel],
  });

  client.on('connecting', () => console.log(`[${now()}] Connecting...`));
  client.on('logon', () => console.log(`[${now()}] Logged in as ${CONFIG.username}.`));
  client.on('connected', (addr, port) => {
    reconnectDelayMs = 5000; // reset backoff after a successful connect
    console.log(`Connected to ${addr}:${port}. Posting to #${CONFIG.channel} every 10-15 minutes.`);
    if (!schedulerStarted) {
      schedulerStarted = true;
      scheduleNext(0); // send the first one immediately, then repeat
    }
  });
  client.on('join', (channel, username, self) => {
    if (self) console.log(`[${now()}] Joined ${channel}.`);
  });
  client.on('reconnect', () => console.log(`[${now()}] Connection lost, tmi.js is reconnecting...`));
  client.on('disconnected', (reason) => {
    console.log(`[${now()}] Disconnected: ${reason}. tmi.js will reconnect automatically.`);
  });
  client.on('notice', (channel, msgid, message) => {
    console.log(`[${now()}] [notice ${msgid}] ${message}`);
  });
}

function connect() {
  createClient();
  client.connect()
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[${now()}] Initial connect failed: ${msg}`);
      console.log(`[${now()}] Retrying in ${Math.round(reconnectDelayMs / 1000)}s...`);
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
    });
}

connect();

function scheduleNext(delay) {
  setTimeout(() => {
    tick();
    scheduleNext(randomInterval());
  }, delay);
}

function tick() {
  if (!client || typeof client.readyState !== 'function' || client.readyState() !== 'OPEN') {
    console.log(`[${now()}] Skipped a tick — connection not open yet.`);
    return;
  }

  dayCount += 1; // keeps advancing regardless of which message type gets sent

  const messageType = Math.floor(Math.random() * 3);
  let message;
  if (messageType === 0) {
    message = messageDayCounter(dayCount);
  } else if (messageType === 1) {
    message = messageShashlik();
  } else {
    message = messageHaircut();
  }

  client.say(CONFIG.channel, message)
    .then(() => console.log(`Sent: ${message}`))
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[${now()}] Failed to send (message may or may not have arrived): ${msg}`);
    });
}
