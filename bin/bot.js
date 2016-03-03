// bin/bot.js

'use strict';

var SomiBot = require('../lib/somi_bot');

var token = process.env.BOT_API_KEY;
var dbPath = process.env.BOT_DB_PATH;
var name = process.env.BOT_NAME;

var somibot = new SomiBot({
  token: token,
  dbPath: dbPath,
  name: name
});

somibot.run();