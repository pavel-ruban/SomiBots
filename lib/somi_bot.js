// lib/somi_bot.js

'use strict';

var util = require('util');
var path = require('path');
var fs = require('fs');
var SQLite = require('sqlite3');
var Bot = require('slackbots');

var SOMI_CRYSTAL_FAILED_OPS_QUEUE_NAME = 'somi_crystals_failed_ops';

var SOMI_API_HEADERS = {
  'X-Api-Authorization' : 'Bearer ',
  'Content-Type' : 'application/json',
  'Authorization' : 'Api-key CZdeJdasnj2n1msa3'
};

var semaphore = true;

var SOMI_API_BEARER = '';

var config = require('./somi_bot.conf.js');

var SOMI_API_DOMAIN = config.SOMI_API_DOMAIN;
var SOMI_DRUPAL_DOMAIN = config.SOMI_DRUPAL_DOMAIN;
var SOMI_API_SECRET_KEY = config.SOMI_API_SECRET_KEY;

var SomiBot = function Constructor(settings) {
  this.settings = settings;
  this.settings.name = this.settings.name || 'SomiBot';
  this.dbPath = settings.dbPath || path.resolve(process.cwd(), 'data', 'SomiBot.db');

  this._resetContext();
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

  //var i;
  //for (i in this.users) {
  //  if (this.users.hasOwnProperty(i)) {
  //    console.log('"name" => "' + this.users[i].name + '", "email" => "' + this.users[i].profile.email);
  //  }
  //}
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
    self._resetContext();

    var channel;
    channel = self._getChannelById(message.channel);
    if (!this._isFromSomiBot(message)) {
      var quantifier;

      // Check message for currencies within.
      this.currencies = getMatches(message.text, /(:gem:)/g, 1);

      switch(true) {
        // If message has crystals handle it.
        case Boolean(this.currencies.length):
          if (!semaphore) break;

          semaphore = false;

          // Get users to whom crystals should be given.
          this.recipients = getMatches(message.text, /<@\b([0-9A-Z]{9,12})\b>/g, 1);

          //if (!this.recipients.length) break;

          // How many crystals give each recipient.
          self._getCrystalAmount(message);

          // Get total quantity of crystals that user attempts to give to specified users.
          self._calculateTotalCrystalAmount();

          var action = 'grant';

          try {
            if (this.quantity.length > 5) {
              throw {code: 4, message: "Превышен лимит по операции. За вами выехали."}
            }
            else if (parseInt(this.quantity) < 0) {
              throw {code: 4, message: "Операции с отрицательной суммой запрещены."}
            }

            // Check Drupal API availability.
            this._drupalAPIAuth();
            // Validate crystal operation. Check all needed data.
            self._validateCrystalOperation(message);

            // Post crystals to users and credit it from initiator.
            self._submitCrystalOperation(message);
          } catch (error) {
            action = 'error';
            this.error = error;
          }

          // Send private messages.
          self._sendPrivateMessages(action, message);
          // Send channel messages.
          self._sendChannelMessages(action, message);

          semaphore = true;
          self._resetContext();

          // Check RabbitMQ queue. If some reminds are there, remind user about failed attempts that currently could be performed.
          if (!this.rabbitmq) {
            this.rabbitmq = true;

            var amqp = require('amqplib/callback_api');
            amqp.connect('amqp://localhost', function (err, conn) {
              if (conn) {
                conn.createChannel(function (err, ch) {
                  var q = SOMI_CRYSTAL_FAILED_OPS_QUEUE_NAME;

                  ch.assertQueue(q, {durable: true});
                  ch.consume(q, function (rabbit_msg) {
                    ch.prefetch(1);
                    if (semaphore) {
                      semaphore = false;

                      var item = rabbit_msg.content.toString();
                      item = JSON.parse(item);

                      if (item && item.data && item.data.slack_id) {
                        var owner = self._getUserById(item.data.slack_id);
                        if (owner) {
                          // Send private messages to remind initiator of crystal operation.
                          self._sendRemindToOwner(owner, 'remind', message, item);
                        }
                      }

                      semaphore = true;
                      ch.ack(rabbit_msg);
                    }
                  }, {noAck: false});
                });
              }
            });
          }
          break;

        default:
          break;

      }
    }
  }
};

function plural_str(a, str1, str2, str3) {
  if (a % 10 == 1 && a % 100 != 11) return str1;
  else if ((a % 10 >= 2) && (a % 10 <= 4) && (a % 100 < 10 || a % 100 >= 20)) return str2;
  else return str3;
}

SomiBot.prototype._resetContext = function () {
  this.quantity = undefined;
  this.error = false;
  this.currencies = undefined;
  this.msg = undefined;
  this.recipients = undefined;
  this.api_initiator = this.post_api_initiator = undefined;
  this.api_recipients = this.post_api_recipients = undefined;
}

SomiBot.prototype._setDefaultMessageOptions = function () {}

SomiBot.prototype._getCrystalAmount = function (message) {
  var quantifier = message.text.match(/(-?\b[0-9]+)\b[\s\t]*:gem:/, 1);

  // If quantity given use it.
  if (quantifier) {
    this.quantity = quantifier[1];
  }
  // Else use count of currencies.
  else {
    this.quantity = 0;
    for (var i in this.currencies) {
      if (this.currencies.hasOwnProperty(i)) {
        ++this.quantity;
      }
    }
  }
}

SomiBot.prototype._calculateTotalCrystalAmount = function () {
  this.total_crystall_op_quantity = 0;
  this.recipientsCount = 0;

  for (var i in this.recipients) {
    if (this.recipients.hasOwnProperty(i)) {
      ++this.total_crystall_op_quantity;
      ++this.recipientsCount;
    }
  }

  this.total_crystall_op_quantity *= this.quantity;
}

SomiBot.prototype._drupalAPIAuth = function () {
  if (!SOMI_API_BEARER) {
    var request = require('sync-request');
    var res = request('POST', SOMI_API_DOMAIN + 'auth', {
      headers: SOMI_API_HEADERS,
      json: {
        "user": {
          "email": "",
          "secret_key": SOMI_API_SECRET_KEY,
          "password": ""
        }
      }
    });

    var res = JSON.parse(res.getBody('utf8'));

    if (res.authorization && res.authorization.access_token && res.authorization.access_token.token_type) {
      if (res.authorization.access_token.token_type == "Bearer") {
        if (res.authorization.access_token.value) {
          SOMI_API_BEARER = res.authorization.access_token.value;
          SOMI_API_HEADERS['X-Api-Authorization'] += SOMI_API_BEARER;
        }
      }
    }
  }
}

SomiBot.prototype._submitCrystalOperation = function (message) {
  var status = {code: 0, message: 'ok'};

  // Get user.
  var user = this._getUserById(message.user);
  if (!user.profile.email) {
    throw {code: 1, message: 'user email is not available'};
  }
  var recipients_post_data = [];

  var i;
  for (i in this.recipients) {
    if (this.recipients.hasOwnProperty(i)) {
      var recipient = this._getUserById(this.recipients[i]);

      this.msg = this.msg.replace(new RegExp('<@' + this.recipients[i] + '>'), '@' + recipient.name);

      if (recipient.profile.email) {
        recipients_post_data.push({email: recipient.profile.email, amount: this.quantity});
      }
    }
  }

  // User has enough crystals on it's Drupal account AND all recipients were correct found.
  var request = require('sync-request');
  var res = request('POST', SOMI_API_DOMAIN + 'user/account/balance/add', {
    headers: SOMI_API_HEADERS,
    json: {
      message: this.msg,
      user: {
        email: user.profile.email,
        crystals_amount: this.total_crystall_op_quantity,
      },
      recipients: recipients_post_data
    }
  });

  var response = JSON.parse(res.getBody('utf8'));

  this.post_api_initiator = response.initiator;
  this.post_api_recipients = response.recipients;

  if (response.error) throw {code: 1, message: response.error.message};
}

SomiBot.prototype._validateCrystalOperation = function (message) {
  var status = {code: 0, message: 'ok'};

  // If we aren't authorized on Drupal side throw error.
  if (!SOMI_API_BEARER) {
    // error occurred.
    throw {code: 1, message: 'User can not be authorized on Drupal API side.'};
  }

  // Get user.
  var user = this._getUserById(message.user);
  if (!user.profile.email) {
    throw {code: 1, message: 'user email is not available'};
  }
  var recipients_post_data = [];

  var i;
  for (i in this.recipients) {
    if (this.recipients.hasOwnProperty(i)) {
      var recipient = this._getUserById(this.recipients[i]);
      if (recipient.profile.email) {
        recipients_post_data.push(recipient.profile.email);
      }
    }
  }

  this.msg = message.text;

  // User has enough crystals on it's Drupal account AND all recipients were correct found.
  var request = require('sync-request');
  var res = request('POST', SOMI_API_DOMAIN + 'crystal/op/validate', {
    headers: SOMI_API_HEADERS,
    json: {
      user: {
        id: message.user,
        email: user.profile.email,
        crystals_amount: this.total_crystall_op_quantity,
        crystals_per_recipient: this.quantity,
      },
      recipients: recipients_post_data,
      message: this.msg
    }
  });

  var response = JSON.parse(res.getBody('utf8'));

  if (response.error) {
    // It's possible when error occurred but we still need context from drupal, in this case to avoid double query, use this info.
    if (response.initiator) {
      this.api_initiator = response.initiator;
    }
    if (response.recipients) {
      this.api_recipients = response.recipients;
    }

    throw {code: response.error.code == 33 ? 33 : 1, message: response.error.message};
  }

  this.api_initiator = response.initiator;
  this.api_recipients = response.recipients;
}

SomiBot.prototype._prepareMessageOptions = function (action, type, message, post_api_user) {

  // Message variables.
  var header, event, block_header, participant, msg, author_name, text;
  var short_format, recipient, color, thumb_url, author_icon, author_link;
  var goods_remain = false, goods_granted = false, goods_needed = false;

  recipient = '';
  header = 'Награждение кристаллами';
  event = 'undefined';
  block_header = 'undefined';
  color = 'good';
  thumb_url = '';
  author_icon = '';
  author_name = 'Drupal API';
  author_link = '';
  text = '';

  short_format = true;
  var goods = '';

  if (action == 'remind') {
    color = 'warning';
    event = '_Уведомление_';
    block_header = ':bell: *Вы хотели подарить %qty%* :gem:';
    block_header = block_header.replace(/%qty%/g, message.attempt_crystals_amount);

    var recipients = getMatches(message.raw_message, /<@\b([0-9A-Z]{9,12})\b>/g, 1);
    for (var key in recipients) {
      if (recipients.hasOwnProperty(key)) {
        var user = this._getUserById(recipients[key]);

        if (recipient) recipient += '\n';
        recipient += '<@' + user.id + '>\t\t';

        for (var i = 0; i < message.crystals_recipient_quantity; ++i) {
          recipient += ':gem:';
        }
      }
    }

    goods_granted = message.crystals_new_amount;

    if (message.slack_id) {
      var user;

      if (user = this._getUserById(message.slack_id)) {
        author_name = user.name;
        author_link = SOMI_DRUPAL_DOMAIN + (message.uid ? ('admin/user/' + message.uid + '/account') : '');
        author_icon = user.profile.image_32;
        thumb_url = user.profile.image_72;
      }
      else {
        author_link = SOMI_DRUPAL_DOMAIN + (message && message.uid ? ('admin/user/' + message.uid + '/account') : '');
      }
    }
  }
  else {
    goods = plural_str(this.quantity, 'кристалл', 'кристалла', 'кристаллов');

    if (action == 'error') {
      block_header = '*Сделка на %qty% ' + goods + ' не удалась!* :no_entry_sign:';
      block_header = block_header.replace(/%qty%/g, this.total_crystall_op_quantity);
      block_header += '\n\n*Отправитель*';

      event = '_Произошла ошибка при награждении_';
      color = 'danger';

      if (this.error && this.error.code == 33 && this.api_initiator) {
        goods_needed = this.total_crystall_op_quantity - this.api_initiator.balance;
      }
    }

    if (message.user) {
      var user;

      if (user = this._getUserById(message.user)) {
        author_name = user.name;
        author_link = SOMI_DRUPAL_DOMAIN + (this.api_initiator ? ('admin/user/' + this.api_initiator.uid + '/account') : '');
        author_icon = user.profile.image_32;
        thumb_url = user.profile.image_72;
      }
    }

    if (action == 'grant') {
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
    }

    switch(type) {
      case 'private':
        if (action == 'grant') {
          block_header = '*Вы получили %qty% ' + goods + '!*';
          for (var i = 0; i < this.quantity; ++i) {
            block_header += ' :gem:';
          }
          block_header += '\n\n*От кого*';

          block_header = block_header.replace(/%qty%/g, this.quantity);

          event = '_Вам подарили %qty% ' + goods +  ' от %usr%_';
          event = event.replace(/%qty%/g, this.quantity);

          if (user = this._getUserById(message.user)) {
            event = event.replace(/%usr%/g, '<@' + user.id + '>');
          }
        }

        if (post_api_user && post_api_user.balance) {
          goods_granted = post_api_user.balance;
        }
        break;

      case 'owner_private':
        if (action == 'grant') {
          event = '_Вы подарили %qty% ' + goods + ' %users%_';
          event = event.replace(/%qty%/g, this.total_crystall_op_quantity);
          event = event.replace(/%users%/g, this.build_users());

          block_header = '*Сделка на %qty% ' + goods + ' прошла успешно!* :white_check_mark:\n\n*От кого*';
          block_header = block_header.replace(/%qty%/g, this.total_crystall_op_quantity);
        }

        if (this.post_api_initiator) {
          goods_remain = this.post_api_initiator.balance;
        }
        break;

      case 'channel':
        if (action == 'grant') {
          event = plural_str(this.recipientsCount, '_Был(а) награжден(а) %users%_', '_Были награждены %users%_', '_Были награждены %users%_');
          event = event.replace(/%users%/g, this.build_users());

          block_header = '*Сделка на %qty% ' + plural_str(this.total_crystall_op_quantity, 'кристалл', 'кристалла', 'кристаллов') + ' прошла успешно!* :white_check_mark:\n\n*От кого*';
          block_header = block_header.replace(/%qty%/g, this.total_crystall_op_quantity);

          for (var i = 0; i < this.quantity; ++i) {
            if (text) text += ' ';
            text += ':gem:';
          }
        }
        break;
    }
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
            value: action == 'remind' ? message.raw_message : message.text,
            short: short_format
          },
        ]
      }
    ]
  };

  if (action == 'grant' || action == 'remind') {
    this.options.attachments[0].fields.push(  {
      title: 'Кому',
      value: recipient,
      short: short_format
    })
  }

  if (goods_remain !== false) {
    this.options.attachments[0].fields.push({
      title: 'Кристаллов осталось',
      value: goods_remain + ' :gem:',
      short: short_format
    })
  }

  if (goods_granted !== false) {
    var title = action == 'remind' ? 'Кристаллов в наличии' : 'Кристаллов на вашем счете';
    this.options.attachments[0].fields.push({
      title: title,
      value: goods_granted + ' :gem:',
      short: short_format
    })
  }

  if (goods_needed !== false) {
    this.options.attachments[0].fields.push({
      title: 'Не хватает кристаллов',
      value: goods_needed + ' :gem:',
      short: short_format
    })
  }

  if (this.error && this.error.message) {
    this.options.attachments[0].fields.push({
      title: 'Ошибка',
      value: this.error.message,
      short: short_format
    })
  }

  if (action == 'remind') {
    this.options.attachments[0].fields.push(  {
      title: 'Повторить',
      value: ':arrows_counterclockwise: <slack-action://BCRYSTALBOT/repeat/crystal-op/' + message.item_id + '|Подарить>',
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
    this._prepareMessageOptions(action, type, message, {});
    this.postMessage(ims.id, '', this.options);
  }

  // To recipients.
  for (var key in this.recipients) {
    if (this.recipients.hasOwnProperty(key)) {
      var user = this._getUserById(this.recipients[key]);
      var api_user;

      for (var key in this.post_api_recipients) {
        if (this.post_api_recipients.hasOwnProperty(key)) {
          if (this.post_api_recipients[key].email == user.profile.email) {
            api_user = this.post_api_recipients[key];
            break;
          }
        }
      }

      if (user.id != message.user) {
        var ims = this._getImsById(user.id);
        if (ims) {
          var type = 'private';
          this._prepareMessageOptions(action, type, message, api_user);
          this.postMessage(ims.id, '', this.options);
        }
      }
    }
  }
};

SomiBot.prototype._sendRemindToOwner = function (owner, action, message, item) {
  // To initiator.
  var ims = this._getImsById(item.data.slack_id);
  if (ims) {
    var type = 'owner_private';
    item.data.item_id = item.item_id;

    this._prepareMessageOptions(action, type, item.data, {});
    this.postMessage(ims.id, '', this.options);
  }
};

SomiBot.prototype._sendChannelMessages = function (action, message) {
  var type = 'channel';
  this._prepareMessageOptions(action, type, message, {});
  this.postMessageToChannel('bot_tests', '', this.options);
  var channel = this._getChannelById(message.channel);
  if (channel && channel.name != 'bot_tests') {
    this.postMessage(channel.id, '', this.options);
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
  var channel = this.channels.filter(function (item) {
    return item.id === channelId;
  })[0];

  // If channel missed in public chats, attempt to find it in private groups.
  if (!channel) {
    return this.groups.filter(function (item) {
      return item.id === channelId;
    })[0];
  }

  return channel;
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
