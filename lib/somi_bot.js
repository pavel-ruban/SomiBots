// lib/somi_bot.js

'use strict';

var util = require('util');
var path = require('path');
var http = require('http');
var fs = require('fs');
var SQLite = require('sqlite3');
var Bot = require('slackbots');

var SOMI_TRANSACTION_FAILED_OPS_QUEUE_NAME = 'somi_transaction_failed_ops';

var SOMI_API_HEADERS = {
  'X-Api-Authorization' : 'Bearer ',
  'Content-Type' : 'application/json',
  'Authorization' : 'Api-key CZdeJdasnj2n1msa3'
};

var semaphore = true;
var boostrapDrupalConfigInit = false;
var httpServerStarted = false;

var SOMI_API_BEARER = '';
var SOMI_API_BEARER_EXPIRE = 0;
// 5 hours.
var SOMI_API_BEARER_EXPIRE_DELAY = 3600 * 5;
// Available smiles - currencies that can be configured on Drupal to associate it with account tid.
// Название смайла должно быть без двоеточий не ":gem:", а "gem".
var SOMI_CURRENCIES = [];
var SOMI_NOTIFICATIONS = [];
// Case в данном случае переводится как падеж, предложение может использовать разный падеж валюты, например наказан 1 жуком, подарил 1 жука.
var SOMI_CURRENCIES_TRANSLATIONS = {};
var SOMI_CURRENCIES_LAST_UPDATED = 0;

var config = require('./somi_bot.conf.js');

var SOMI_API_DOMAIN = config.SOMI_API_DOMAIN;
var SOMI_NODEJS_HTTP_SERVER_PORT = config.SOMI_NODEJS_HTTP_SERVER_PORT;
var SOMI_DRUPAL_DOMAIN = config.SOMI_DRUPAL_DOMAIN;
var SOMI_API_SECRET_KEY = config.SOMI_API_SECRET_KEY;
var pendingServerJobs = [];

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

SomiBot.prototype._processServerRequests = function (postData) {
  var self = this;
  self.color = postData.color;
  self.op_header = postData.header;
  self.image = postData.image;
  self.icon = postData.icon;
  self.message.text = postData.text;

  self._prepareMessageOptions('notification', 'channel', self.message, {});
  self.postMessageToChannel(postData.channel, '', self.options);
}

SomiBot.prototype._onStart = function () {
  var self = this;

  this._loadBotUser();
  this._connectDb();
  this._firstRunCheck();

  //var i;
  //for (i in this.users) {
  //  if (this.users.hasOwnProperty(i)) {
  //    console.log('"name" => "' + this.users[i].name + '", "email" => "' + this.users[i].profile.email);
  //  }
  //}

  // Integrate custom http server, it could be used to receive external connections to achieve dual side feedback effect.
  // E.g. if the webhook functional is not enough we can add flexible logic on Drupal or here and trigger this bot from
  // any external application.
  if (!httpServerStarted) {
    var http = require("http");
    var server = http.createServer(function (request, response) {
      request.on('data', function (data) {
        var postData = JSON.parse(data);

        if (postData.action && postData.action == 'notification' && postData.channel && postData.icon
          && postData.header && postData.text && postData.type && postData.image && postData.id && postData.color) {

          if (semaphore) {
            semaphore = false;

            self._processServerRequests(postData);

            semaphore = true;
          }
          else {
            pendingServerJobs.push(postData);
          }
        }
      });

      response.writeHead(200, {"Content-Type": "application/json"});
      var status = {
        'status': 'ok'
      };

      response.write(JSON.stringify(status));
      response.end();
    });

    server.listen(SOMI_NODEJS_HTTP_SERVER_PORT);
    httpServerStarted = true;
  }
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

      // Get Drupal Bot config. Only once.
      // Check Drupal API availability.
      this._drupalAPIAuth();

      if (SOMI_API_BEARER) {
        var request = require('sync-request');
        var extend = require('util')._extend;
        var config_req_headers = extend({}, SOMI_API_HEADERS);
        config_req_headers['Content-Type'] = 'text';

        var res = request('GET', SOMI_API_DOMAIN + 'somi/config?config_timestamp=' + SOMI_CURRENCIES_LAST_UPDATED, {
          headers: config_req_headers
        });

        config_req_headers = undefined;

        var res = JSON.parse(res.getBody('utf8'));

        // After config initiated first time we update config only during existing request.
        if (!res.error &&  !res.status && Object.keys(res).length && res.timestamp) {
          this._update_config(res);

          boostrapDrupalConfigInit = true;
        }
      }

      if (!boostrapDrupalConfigInit) {
        console.log('error: somi config was not loaded from Drupal during initialization phase');
        return;
      }

      var quantifier; var transactions = undefined; var processed = false;
      var currency, currency_regexp, currency_key, handled_msg = undefined, warning, warning_regexp;

      // Keep origin message as it's value would be affected.
      var origin_message = message.text;

      // Allow multiple currencies within one sequence.
      for (var c in SOMI_CURRENCIES) {
        if (SOMI_CURRENCIES.hasOwnProperty(c)) {
          // Avoid concurrency situation that could break context of performing action.
          if (!semaphore) break;
          semaphore = false;

          // Retrieve currency context.
          this.currency = currency = ':' + SOMI_CURRENCIES[c] + ':';
          this.currency_key = currency_key = SOMI_CURRENCIES[c];
          this.currency_regexp = currency_regexp = new RegExp('(' + this.currency + ')', 'g');

          // Check message for currencies within.
          this.currencies = getMatches(origin_message, this.currency_regexp, 1);
          if (this.currencies.length && !transactions) {
            transactions = origin_message.match(/(.+)(?:\n|$)/g);
          }

          switch (true) {
            // If message has currency mention handle it.
            case Boolean(this.currencies.length):
              for (var i in transactions) {
                if (transactions.hasOwnProperty(i)) {
                  var currencies = getMatches(transactions[i], this.currency_regexp, 1);

                  if (currencies.length) {
                    self._resetContext();
                    this.currencies = currencies;
                    this.currency = currency;
                    this.currency_key = currency_key;
                    this.currency_regexp = currency_regexp;
                    this.message = message;

                    message.text = transactions[i];

                    // Get users to whom crystals should be given.
                    this.recipients = getMatches(message.text, /<@\b([0-9A-Z]{9,12})\b>/g, 1);

                    if (!this.recipients.length) continue;

                    // How many crystals give each recipient.
                    self._getTransactionAmount(message);

                    // Get total quantity of crystals that user attempts to give to specified users.
                    self._calculateTotalTransactionAmount();

                    var action = 'grant';

                    try {
                      // Preform basic validations.
                      switch (true) {
                        case Boolean(this.quantity && (typeof this.quantity == 'string') && this.quantity.match(/\.[1-9]/)):
                          throw {code: 3, message: "Операции с дробными числами запрещены."}

                        case Boolean(this.quantity.length > 5):
                          throw {code: 4, message: "Превышен лимит по операции. За вами выехали."}

                        case Boolean(parseInt(this.quantity) < 0):
                          throw {code: 5, message: "Операции с отрицательной суммой запрещены."}

                        case Boolean(parseInt(this.quantity) == 0):
                          throw {code: 6, message: "Операции с нулевой суммой запрещены."}
                      }

                      // Check Drupal API availability.
                      this._drupalAPIAuth();

                      // Validate crystal operation. Check all needed data.
                      self._validateTransactionOperation(message);

                      // Post crystals to users and credit it from initiator.
                      self._submitTransactionOperation(message);

                      handled_msg = true;

                    } catch (error) {

                      action = 'error';
                      this.error = error;
                    }

                    // Send private messages.
                    self._sendPrivateMessages(action, message);
                    // Send channel messages.
                    self._sendChannelMessages(action, message);

                  }
                }
              }

              self._resetContext();
              break;
          }

          semaphore = true;

          // Check RabbitMQ queue. If some reminds are there, remind user about failed attempts that currently could be performed.
          if (handled_msg && !this.rabbitmq) {
            this.rabbitmq = true;
            handled_msg = undefined;

            var amqp = require('amqplib/callback_api');
            amqp.connect('amqp://localhost', function (err, conn) {
              if (conn) {
                conn.createChannel(function (err, ch) {
                  var q = SOMI_TRANSACTION_FAILED_OPS_QUEUE_NAME;

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
                          self.currency = item.data.currency;
                          self.raw_message = item.data.raw_message;
                          self.currency_key = item.data.currency.replace(/:/g, '');
                          // Send private messages to remind initiator of crystal operation.
                          self._sendRemindToOwner(owner, 'remind', message, item);
                          self.raw_message = undefined;
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

          handled_msg = undefined;
        }
      }
      for (var war in SOMI_NOTIFICATIONS) {
        // Retrieve warning context.
        // Send channel messages.
        processed = false;
        for (var key in SOMI_NOTIFICATIONS[war].react_on) {
          warning = SOMI_NOTIFICATIONS[war].react_on[key];
          warning_regexp = new RegExp('^(?:(?!:\/\/).)*' + warning + '.*$', 'i');
          // Check message for warnings within.
          if (warning_regexp.test(origin_message)) {
            if (!processed) {
              this.color = SOMI_NOTIFICATIONS[war].color;
              this.op_header = SOMI_NOTIFICATIONS[war].op_header;
              this.icon = SOMI_NOTIFICATIONS[war].icon;
              processed = true;

              this.message = message;

              self._sendChannelMessages('warning', message);

              request('POST', SOMI_API_DOMAIN + 'create/history', {
                headers: SOMI_API_HEADERS,
                json: {
                  options: this.options,
                  author_name: this.options.attachments["0"].author_name,
                  message: message.text,
                  tid: war,
                  webhooks: SOMI_NOTIFICATIONS[war].webhooks
                }
              });
            }
          }
        }
      }

      if (semaphore) {
        semaphore = false;
        if (pendingServerJobs && pendingServerJobs.length) {
          var i_to_splice = [];
          for (var i in pendingServerJobs) {
            if (pendingServerJobs.hasOwnProperty(i)) {
              self._processServerRequests(pendingServerJobs[i]);
              i_to_splice.push(i);
            }
          }

          i_to_splice.reverse();
          for (var i in i_to_splice) {
            if (i_to_splice.hasOwnProperty(i)) {
              pendingServerJobs.splice(i_to_splice[i], 1);
            }
          }
        }
        semaphore = true;
      }
    }
  }
};

function plural_str(a, str1, str2, str3) {
  // Avoid negative values;
  a = Math.abs(a);

  if (a == 0) return str3;
  else if (a % 10 == 1 && a % 100 != 11) return str1;
  else if ((a % 10 >= 2) && (a % 10 <= 4) && (a % 100 < 10 || a % 100 >= 20)) return str2;
  else return str3;
}

SomiBot.prototype._resetContext = function () {
  this.quantity = undefined;
  this.error = false;
  this.currencies = undefined;
  this.msg = undefined;
  this.message = {};
  this.transactions = undefined;
  this.currency = undefined;
  this.currency_key = undefined;
  this.currency_regexp = undefined;
  this.recipients = undefined;
  this.api_initiator = this.post_api_initiator = undefined;
  this.api_recipients = this.post_api_recipients = undefined;
}

SomiBot.prototype._setDefaultMessageOptions = function () {}

SomiBot.prototype._getTransactionAmount = function (message) {
  var quantifier = message.text.match(new RegExp('(-?\\b[0-9]+?(?:\\.[0-9]+)?)\\b[\\s\\t]*?' + this.currency), 1);

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

SomiBot.prototype._calculateTotalTransactionAmount = function () {
  this.total_transaction_op_quantity = 0;
  this.recipientsCount = 0;

  for (var i in this.recipients) {
    if (this.recipients.hasOwnProperty(i)) {
      ++this.total_transaction_op_quantity;
      ++this.recipientsCount;
    }
  }

  this.total_transaction_op_quantity *= this.quantity;
}

SomiBot.prototype._drupalAPIAuth = function () {
  var timestamp = Math.round(+new Date()/1000);
  if (!SOMI_API_BEARER || timestamp > SOMI_API_BEARER_EXPIRE) {
    SOMI_API_HEADERS['X-Api-Authorization'] = 'Bearer ';

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

    // Update expire time.
    SOMI_API_BEARER_EXPIRE = timestamp + SOMI_API_BEARER_EXPIRE_DELAY;
  }
}

SomiBot.prototype._submitTransactionOperation = function (message) {
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
        currency: this.currency,
        transaction_amount: this.total_transaction_op_quantity,
      },
      recipients: recipients_post_data
    }
  });

  var response = JSON.parse(res.getBody('utf8'));

  this.post_api_initiator = response.initiator;
  this.post_api_recipients = response.recipients;

  if (response.error) throw {code: 1, message: response.error.message};
}

SomiBot.prototype._update_config = function (updated_config) {
  SOMI_CURRENCIES = [];
  SOMI_NOTIFICATIONS = [];

  if (updated_config.config) {
    for (var i in updated_config.config) {
      if (updated_config.config.hasOwnProperty(i)) {
        SOMI_CURRENCIES.push(i);
      }
    }
  }

  if (updated_config.warnings) {
    for (var i in updated_config.warnings) {
      if (updated_config.warnings.hasOwnProperty(i)) {
        SOMI_NOTIFICATIONS[i] = updated_config.warnings[i];
      }
    }
  }

  SOMI_CURRENCIES_TRANSLATIONS = updated_config.config;
  SOMI_CURRENCIES_LAST_UPDATED = updated_config.timestamp;
}

SomiBot.prototype._validateTransactionOperation = function (message) {
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
  var res = request('POST', SOMI_API_DOMAIN + 'account/op/validate', {
    headers: SOMI_API_HEADERS,
    json: {
      user: {
        id: message.user,
        currency: this.currency,
        email: user.profile.email,
        transaction_amount: this.total_transaction_op_quantity,
        amount_per_recipient: this.quantity,
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
  var tr = SOMI_CURRENCIES_TRANSLATIONS;
  var tr_key = this.currency_key;
  var user;

  recipient = '';
  if (tr_key && tr) {
    header = tr[tr_key].op_header;
    color = tr[tr_key].op_color;
  }
  else {
    header = this.op_header;
    color = this.op_color;
  }

  event = 'undefined';
  block_header = 'undefined';
  thumb_url = '';
  author_icon = '';

  if (action == 'notification') {
    author_name = 'Группа компаний I20';
  }
  else {
    author_name = 'Drupal API';
  }

  author_link = '';
  text = '';

  short_format = true;

  if (action == 'remind') {
    color = 'warning';

    goods_granted = message.transaction_new_amount;

    if (message.slack_id) {

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
    if (action == 'error') {
      color = 'danger';

      if (this.error && this.error.code == 33 && this.api_initiator) {
        goods_needed = this.total_transaction_op_quantity - this.api_initiator.balance;
      }
    }

    if (message.user) {
      if (user = this._getUserById(message.user)) {
        author_name = user.name;
        author_link = SOMI_DRUPAL_DOMAIN + (this.api_initiator ? ('admin/user/' + this.api_initiator.uid + '/account') : '');
        author_icon = user.profile.image_32;
      }
    }

    thumb_url = this._getThumbUrl();

    switch(type) {
      case 'private':
        if (post_api_user && post_api_user.balance) {
          goods_granted = post_api_user.balance;
        }
        break;

      case 'owner_private':
        if (this.post_api_initiator) {
          goods_remain = this.post_api_initiator.balance;
        }
        break;

      case 'channel':
        if (action == 'grant') {
          for (var i = 0; i < this.quantity; ++i) {
            if (text) text += ' ';
            text += this.currency;
          }
        }
        break;
    }
  }

  event = this._event_msg(type, action);
  block_header = this._status_msg(type, action, message);
  recipient = this._recipient_msg(type, action, message);

  this.options = {
    icon_url: (this.currency == ':beetle'
      ? 'http://somibo.qajedi.ru/sites/default/files/styles/slack_thumb/public/93703-_017_0.png?itok=FuqWUOof'
      : 'http://somibo.qajedi.ru/sites/default/files/styles/slack_thumb/public/crystalls_0.png?itok=TVOkG55S'
    ),
    as_user: false,
    username: header,
    text: event,
    mrkdwn: true,
    attachments: [
      {
        color: color,
        fallback: 'Доп. информация скрыта, нажмите чтобы посмотреть',
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
          }
        ]
      }
    ]
  };

  if (action == 'warning' || action == 'notification') {
    this.options.icon_url = this.options.attachments["0"].thumb_url = this.icon;
    this.options.username = this.op_header;
    this.options.attachments["0"].color = this.color;
  }

  if (action == 'notification') {
    this.options.attachments["0"].thumb_url = this.image
  }

  if (action == 'grant' || action == 'remind') {
    this.options.attachments[0].fields.push(  {
      title: 'Кому',
      value: recipient,
      short: short_format
    })
  }

  if (goods_remain !== false) {
    this.options.attachments[0].fields.push({
      title: tr[tr_key].attach_balance_owner_title,
      value: goods_remain + ' ' + this.currency,
      short: short_format
    })
  }

  if (goods_granted !== false) {
    var title = action == 'remind'
      ? tr[tr_key].attach_balance_remind_title
      : tr[tr_key].attach_balance_private_title;
    this.options.attachments[0].fields.push({
      title: title,
      value: goods_granted + ' ' + this.currency,
      short: short_format
    })
  }

  if (goods_needed !== false) {
    this.options.attachments[0].fields.push({
      title: tr[tr_key].attach_balance_needed_title,
      value: goods_needed + ' ' + this.currency,
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
      value: ':arrows_counterclockwise: <slack-action://BCRYSTALBOT/repeat/crystal-op/' + message.item_id + '|' +
        tr[tr_key].op_remind + '>',
      short: short_format
    })
  }
}

// Получает склонения согласно падежу преводимого перевода.
function get_p(tr_key, translate) {
  var tr = SOMI_CURRENCIES_TRANSLATIONS;

  if (tr[tr_key][translate] && tr[tr_key][translate].case) {
    return tr[tr_key][tr[tr_key][translate].case];
  } else {
    return tr[tr_key].nominative;
  }
}

// Получает сообщение перевода.
SomiBot.prototype.get_m = function (tr_key, translate) {
  var tr = SOMI_CURRENCIES_TRANSLATIONS;

  // Handle alt case, it depends now only on participants count.
  if (tr[tr_key][translate].alt && this.recipients.length && this.recipients.length == 1) {
    return tr[tr_key][translate].alt;
  }

  if (tr[tr_key][translate] && tr[tr_key][translate].msg) {
    return tr[tr_key][translate].msg;
  } else {
    return tr[tr_key][translate];
  }
}

SomiBot.prototype._getThumbUrl = function() {
  var thumb_url = '';
  var action = '';
  var image_urls = [];

  if (!this.recipients) return thumb_url;

  var recipients = this.recipients;
  for (var key in recipients) {
    if (recipients.hasOwnProperty(key)) {
      var user = this._getUserById(recipients[key]);
      if (user) {
        image_urls.push(user.profile.image_72);
      }
    }
  }

  if (image_urls.length) {
    return image_urls[0];
  }

  return thumb_url;
}

SomiBot.prototype._recipient_msg = function(type, action, message) {
  var recipient = '';
  var recipients = '';
  var qty;

  // Select needed translation depends on type of message and performing action.
  switch (action) {
    case 'grant':
      qty = this.quantity;
      recipients = this.recipients;
      break;

    case 'remind':
      qty = message.transaction_recipient_quantity;
      recipients = getMatches(message.raw_message, /<@\b([0-9A-Z]{9,12})\b>/g, 1);
      break;

    default:
      return '';
  }

  for (var key in recipients) {
    if (recipients.hasOwnProperty(key)) {
      var user = this._getUserById(recipients[key]);

      if (recipient) recipient += '\n';
      var uid = 0;
      switch (action) {
        case 'grant':
          var api_recipient = this._getDrupalUserBySlackUser(user);
          uid = api_recipient.uid;
          recipient += '<@' + user.id + '> [<' + SOMI_DRUPAL_DOMAIN + 'admin/user/' + uid + '/account|account>]\t\t';
          break;

        case 'remind':
          recipient += '<@' + user.id + '>\t\t';
          break;
      }

      for (var i = 0; i < qty; ++i) {
        recipient += this.currency;
      }
    }
  }

  return recipient;
}

SomiBot.prototype._getDrupalUserBySlackUser = function(user) {
  for (var key in this.post_api_recipients) {
    if (this.post_api_recipients.hasOwnProperty(key)) {
      if (this.post_api_recipients[key].email == user.profile.email) {
        return this.post_api_recipients[key];
      }
    }
  }
}

SomiBot.prototype._event_msg = function(type, action) {
  var tr_str;

  // Select needed translation depends on type of message and performing action.
  switch (action) {
    case 'grant':
      switch (type) {
        case 'owner_private':
          tr_str = 'event_owner';
          break;

        case 'private':
          tr_str = 'event_private';
          break;

        case 'channel':
          tr_str = 'event_channel';
          break;
      }
      break;

    case 'remind':
      tr_str = 'event_remind';
      break;

    case 'error':
      tr_str = 'event_error';
      break;
  }

  // If translation not found return empty string.
  if (!tr_str) return '';

  return this._process_translation(tr_str, this.quantity);
}

SomiBot.prototype._status_msg = function(type, action, message) {
  var tr_str;
  var qty = this.total_transaction_op_quantity;
  // Select needed translation depends on type of message and performing action.
  switch (action) {
    case 'grant':
      switch(type) {
        case 'private':
          tr_str = 'op_status_private';
          qty = this.quantity;
          break;

        default:
          tr_str = 'op_status';
          break;
      }
      break;

    case 'remind':
      tr_str = 'op_status_remind';
      qty = message.attempt_transaction_amount;
      break;

    case 'error':
      tr_str = 'error_status';
      break;
  }

  // If translation not found return empty string.
  if (!tr_str) return '';

  return this._process_translation(tr_str, qty);
}

SomiBot.prototype._process_translation = function(tr_str, qty) {
  // Access to translations.
  var tr = SOMI_CURRENCIES_TRANSLATIONS;
  var tr_key = this.currency_key;

  // Получим участников операции.
  var participants = this.build_users();

  // Получим склонения для падежа перевода.
  var p = get_p(tr_key, tr_str);
  // Получим перевод в нужном склонении.
  var goods = plural_str(qty, p[1], p[2], p[3]).toLowerCase();

  var $this = this;

  // Получим конечный перевод и заменим все токены.
  var raw_translate = this.get_m(tr_key, tr_str).split('\\n');
  var translate = '';
  for (var i in raw_translate) {
    if (raw_translate.hasOwnProperty(i)) {
      translate += raw_translate[i];

      if ((raw_translate.length - 1) > i) {
        translate += '\n';
      }
    }
  }

  return translate.replace(/%qty%|%goods%|%users%|%usr%|%currencies%|%currency%/g, function ($0) {
    switch (true) {
      case Boolean($0 == '%qty%'):
        return qty;

      case Boolean($0 == '%goods%'):
        return goods;

      case Boolean($0 == '%users%'):
        return participants;

      case Boolean($0 == '%usr%'):
        var user;
        if (user = $this._getUserById($this.message.user)) {
          return '<@' + user.id + '>';
        }
        return '';

      case Boolean($0 == '%currencies%'):
        var currencies = '';

        for (var i = 0; i < qty; ++i) {
          if (currencies) currencies += ' ';
          currencies += $this.currency;
        }

        return currencies;

      case Boolean($0 == '%currency%'):
        return $this.currency;
    }
  });  
}

SomiBot.prototype.build_users = function() {
  var users = '';
  var recipients;

  if (this.raw_message) {
    recipients = getMatches(this.raw_message, /<@\b([0-9A-Z]{9,12})\b>/g, 1);
  } else {
    recipients = this.recipients;
  }

  for (var key in recipients) {
    if (recipients.hasOwnProperty(key)) {
      var user = this._getUserById(recipients[key]);

      if (users) users += ' и ';
      users += '<@' + user.id + '>';
    }
  }

  return users;
}

SomiBot.prototype._sendPrivateMessages = function (action, message) {
  // To initiator.
  var ims = this._getImsById(message.user);

  // Attempt to create direct channel if it's missed.
  //if (!ims) {
  //  this.openIm(user.id);
  //  ims = this._getImsById(user.id);
  //}

  var type = 'owner_private';

  if (ims) {
    this._prepareMessageOptions(action, type, message, {});
    this.postMessage(ims.id, '', this.options);
  }
  else if (message.user && message.user.name) {
    this._prepareMessageOptions(action, type, message, {});
    this.postMessage('@' + message.user.name, '', this.options);
  }

  // To recipients.
  for (var key in this.recipients) {
    if (this.recipients.hasOwnProperty(key)) {
      var user = this._getUserById(this.recipients[key]);
      var api_user = {};

      if (user) {
        for (var key in this.post_api_recipients) {
          if (this.post_api_recipients.hasOwnProperty(key)) {
            if (this.post_api_recipients[key].email == user.profile.email) {
              api_user = this.post_api_recipients[key];
              break;
            }
          }
        }

        if (user.id != message.user) {
          ims = this._getImsById(user.id);

          // Attempt to create direct channel if it's missed.
          //if (!ims) {
          //  this.openIm(user.id);
          //  ims = this._getImsById(user.id);
          //}

          type = 'private';

          if (ims) {
            this._prepareMessageOptions(action, type, message, api_user);
            this.postMessage(ims.id, '', this.options);
          }
          else if (user.name) {
            this._prepareMessageOptions(action, type, message, api_user);
            this.postMessage('@' + user.name, '', this.options);
          }
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
  var channel = this._getChannelById(message.channel);
  if (channel) {
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
