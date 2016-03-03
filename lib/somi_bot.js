// lib/somi_bot.js

'use strict';

var util = require('util');
var path = require('path');
var fs = require('fs');
var SQLite = require('sqlite3').verbose();
var Bot = require('slackbots');

var SomiBot = function Constructor(settings) {
  this.settings = settings;
  this.settings.name = this.settings.name || 'SomiBot';
  this.dbPath = settings.dbPath || path.resolve(process.cwd(), 'data', 'SomiBot.db');

  this.user = null;
  this.db = null;
  this.quantity = null;
  this.currencies = null;
  this.recepients = null;
};

// inherits methods and properties from the Bot constructor
util.inherits(SomiBot, Bot);

module.exports = SomiBot;

SomiBot.prototype.run = function () {
  SomiBot.super_.call(this, this.settings);

  this.on('start', this._onStart);
  this.on('message', this._onMessage);
};

SomiBot.prototype._onStart = function () {
  this._loadBotUser();
  this._connectDb();
  this._firstRunCheck();
};

SomiBot.prototype._loadBotUser = function () {
  var self = this;
  this.user = this.users.filter(function (user) {
    return user.name === self.name;
  })[0];
};

SomiBot.prototype._connectDb = function () {
  if (!fs.existsSync(this.dbPath)) {
    console.error('Database path ' + '"' + this.dbPath + '" does not exists or it\'s not readable.');
    process.exit(1);
  }

  this.db = new SQLite.Database(this.dbPath);
};

SomiBot.prototype._firstRunCheck = function () {
  var self = this;
  self.db.get('SELECT val FROM info WHERE name = "lastrun" LIMIT 1', function (err, record) {
    if (err) {
      return console.error('DATABASE ERROR:', err);
    }

    var currentTime = (new Date()).toJSON();

    // this is a first run
    if (!record) {
      self._welcomeMessage();
      return self.db.run('INSERT INTO info(name, val) VALUES("lastrun", ?)', currentTime);
    }

    // updates with new last running time
    self.db.run('UPDATE info SET val = ? WHERE name = "lastrun"', currentTime);
  });
};

SomiBot.prototype._welcomeMessage = function () {
  this.postMessageToChannel(this.channels[0].name, 'Hi guys, roundhouse-kick anyone?' +
    '\n I can tell jokes, but very honest ones. Just say `Chuck Norris` or `' + this.name + '` to invoke me!',
    {as_user: true});
};

function getMatches(string, regex, index) {
  index || (index = 1); // default to the first capturing group
  var matches = [];
  var match;
  while (match = regex.exec(string)) {
    matches.push(match[index]);
  }
  return matches;
}

SomiBot.prototype._onMessage = function (message) {
  var self = this;

  if (message.type == 'message') {
    var channel;
    channel = self._getChannelById(message.channel);
    if (!this._isFromSomiBot(message)) {
      var quantifier;

      switch(true) {
        // If message has crystals handle it.
        case Boolean(this.currencies = getMatches(message.text, /(:gem:)/g, 1)):
          quantifier = message.text.match(/\b([0-9]+)\b[\s\t]*:gem:/, 1);

          // If quantity given use it.
          if (quantifier) {
            this.quantity = quantifier[1];
          }
          // Else use count of currencies.
          else {
            this.quantity = 0;
            for (var i in currencies) {
              if (currencies.hasOwnProperty(i)) {
                ++this.quantity;
              }
            }
          }

          this.recipients = getMatches(message.text, /<@\b([0-9A-Z]{9,12})\b>/g, 1);
          break;

        default:
          break;

      }

      var action = 'grant';

      // Send private messages.
      self._sendPrivateMessages(action, message);
      // Send channel messages.
      self._sendChannelMessages(action, message);
    }
  }

  //if (this._isChatMessage(message) &&
  //  this._isChannelConversation(message) &&
  //  !this._isFromSomiBot(message) &&
  //  this._isMentioningSomiBot(message)
  //) {
  //  this._replyWithRandomJoke(message);
  //}
};

function plural_str(a, str1, str2, str3) {
  if (a % 10 == 1 && a % 100 != 11) return str1;
  else if (a % 10 >= 2 && a % 10 <= 4 && (a % 100 != 10)) return str2;
  else return str3;
}

SomiBot.prototype._setDefaultMessageOptions = function () {}

SomiBot.prototype._prepareMessageOptions = function (action, type, message) {

  // Message variables.
  var header, event, block_header, participant, msg, author_name, text;
  var short_format, recipient, color, thumb_url, author_icon, author_link;
  var goods_remain = false;

  recipient = '';
  header = 'Награждение кристаллами';
  event = 'undefined';
  block_header = 'undefined';
  color = 'good';
  thumb_url = '';
  author_icon = '';
  author_name = 'undefined';
  author_link = '';
  text = '';

  short_format = true;

  if (message.user) {
    var user;

    if (user = this._getUserById(message.user)) {
      author_name = user.name;
      author_link = 'http://pavelruban.org';
      author_icon = user.profile.image_32;
      thumb_url = user.profile.image_72;
    }
  }


  for (var key in this.recipients) {
    if (this.recipients.hasOwnProperty(key)) {
      var user = this._getUserById(this.recipients[key]);

      if (recipient) recipient += '\n';
      recipient += '<@' + user.id + '>\t\t';
      for (var i = 0; i < this.quantity; ++i) {
        recipient += ':gem:';
      }
    }
  }

  var goods = plural_str(this.quantity, 'кристалл', 'кристалла', 'кристаллов');
  switch(type) {
    case 'private':
      block_header = '*Вы получили %qty% ' + goods +  '!* :gem: :gem:\n\n*От кого*';
      block_header = block_header.replace(/%qty%/g, this.quantity);

      event = '_Вам подарили %qty% ' + goods +  ' от %usr%_';
      event = event.replace(/%qty%/g, this.quantity);
      if (user = this._getUserById(message.user)) {
        event = event.replace(/%usr%/g, '<@' + user.id + '>');
      }
      break;

    case 'owner_private':
      event = '_Вы подарили %qty% ' + goods +  ' %users%_';
      event = event.replace(/%qty%/g, this.quantity);
      event = event.replace(/%users%/g, this.build_users());

      block_header = '*Сделка на %qty% ' + goods +  ' прошла успешно!* :white_check_mark:\n\n*От кого*';
      block_header = block_header.replace(/%qty%/g, this.quantity);

      goods_remain = 5;
      break;

    case 'channel':
      event = '_Были награждены %users%_';
      event = event.replace(/%users%/g, this.build_users());

      block_header = '*Сделка на %qty% ' + plural_str(this.quantity, 'кристалл', 'кристалла', 'кристаллов') +  '!* :white_check_mark:\n\n*От кого*';
      block_header = block_header.replace(/%qty%/g, this.quantity);

      for (var i = 0; i < this.quantity; ++i) {
        if (text) text += ' ';
        text += ':gem:';
      }

      break;
  }

  this.options = {
    icon_url: 'http://orig08.deviantart.net/62cb/f/2011/169/1/c/365_day_168_crystals_by_korikian-d3j8n69.png',
    as_user: false,
    username: header,
    text: event,
    mrkdwn: true,
    attachments: [
      {
        color: color,
        pretext: block_header,
        text: text,
        "mrkdwn_in": ['text', 'pretext', 'fields'],
        thumb_url: thumb_url,
        author_icon: author_icon,
        author_link: author_link,
        author_name: author_name,
        fields: [
          {
            title: 'Сообщение',
            value: message.text,
            short: short_format
          },
          {
            title: 'Кому',
            value: recipient,
            short: short_format
          },
          {
            title: 'Кристаллов на вашем счете',
            value: this.quantity,
            short: short_format
          }
        ]
      }
    ]
  };

  if (goods_remain !== false) {
    this.options.attachments[0].fields.push({
      title: 'Кристаллов осталось',
      value: goods_remain + ' :gem:',
      short: short_format
    })
  }
}

SomiBot.prototype.build_users = function() {
  var users = '';

  for (var key in this.recipients) {
    if (this.recipients.hasOwnProperty(key)) {
      var user = this._getUserById(this.recipients[key]);

      if (users) users += ' и ';
      users += '<@' + user.id + '>';
    }
  }

  return users;
}

SomiBot.prototype._sendPrivateMessages = function (action, message) {
  // To initiator.
  var ims = this._getImsById(message.user);
  if (ims) {
    var type = 'owner_private';
    this._prepareMessageOptions(action, type, message);
    this.postMessage(ims.id, '', this.options);
  }

  // To recipients.
  for (var key in this.recipients) {
    if (this.recipients.hasOwnProperty(key)) {
      var user = this._getUserById(this.recipients[key]);

      if (user.id != message.user) {
        var ims = this._getImsById(user.id);
        if (ims) {
          var type = 'private';
          this._prepareMessageOptions(action, type, message);
          this.postMessage(ims.id, '', this.options);
        }
      }
    }
  }
};

SomiBot.prototype._sendChannelMessages = function (action, message) {
  var type = 'channel';
  this._prepareMessageOptions(action, type, message);
  this.postMessageToChannel('bot_tests', '', this.options);
  if (channel && channel.name != 'bot_tests') {
    this._prepareMessageOptions(action, type, message);
    this.postMessageToChannel(channel.name, '', this.options);
  }
};

SomiBot.prototype._isChatMessage = function (message) {
  return message.type === 'message' && Boolean(message.text);
};

SomiBot.prototype._isChannelConversation = function (message) {
  return typeof message.channel === 'string' &&
    message.channel[0] === 'C';
};

SomiBot.prototype._isFromSomiBot = function (message) {
  return typeof message.user == 'undefined' || message.user === this.user.id;
};

SomiBot.prototype._isMentioningSomiBot = function (message) {
  return message.text.toLowerCase().indexOf('somi bot') > -1 ||
    message.text.toLowerCase().indexOf(this.name) > -1;
};

SomiBot.prototype._replyWithRandomJoke = function (originalMessage) {
  var self = this;
  self.db.get('SELECT id, joke FROM jokes ORDER BY used ASC, RANDOM() LIMIT 1', function (err, record) {
    if (err) {
      return console.error('DATABASE ERROR:', err);
    }

    var channel = self._getChannelById(originalMessage.channel);
    self.postMessageToChannel(channel.name, record.joke, {as_user: true});
    self.db.run('UPDATE jokes SET used = used + 1 WHERE id = ?', record.id);
  });
};

SomiBot.prototype._getChannelById = function (channelId) {
  return this.channels.filter(function (item) {
    return item.id === channelId;
  })[0];
};

SomiBot.prototype._getUserById = function (uid) {
  return this.users.filter(function (item) {
    return item.id === uid;
  })[0];
};

SomiBot.prototype._getImsById = function (uid) {
  return this.ims.filter(function (item) {
    return item.user === uid;
  })[0];
};
