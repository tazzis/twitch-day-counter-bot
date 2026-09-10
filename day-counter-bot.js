/**
 * Twitch chat bot.
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
 *
 * 4. Run:
 *      node day-counter-bot.js
 * ---------------------------------------------------------------
 */

const tmi = require('tmi.js');

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

// ---------------- BOT ----------------
const client = new tmi.Client({
  identity: {
    username: CONFIG.username,
    password: CONFIG.password,
  },
  channels: [CONFIG.channel],
});

let dayCount = 0;

client.connect().catch(console.error);

client.on('connected', () => {
  console.log(`Connected. Posting to #${CONFIG.channel} every 10-15 minutes.`);
  scheduleNext(0); // send the first one immediately, then repeat
});

function scheduleNext(delay) {
  setTimeout(() => {
    tick();
    scheduleNext(randomInterval());
  }, delay);
}

function tick() {
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
    .catch((err) => console.error('Failed to send message:', err));
}
