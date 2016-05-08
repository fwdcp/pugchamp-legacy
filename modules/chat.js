'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');
const RateLimiter = require('limiter').RateLimiter;
const twitter = require('twitter-text');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const CHAT_LOG_CHANNEL = config.has('server.slack.channels.chatLog') ? config.get('server.slack.channels.chatLog') : '#chat-log';
    const RATE_LIMIT = ms(config.get('app.chat.rateLimit'));
    const SHOW_CONNECTION_MESSAGES = config.get('app.chat.showConnectionMessages');

    var userChatLimiters = new Map();

    /**
     * @async
     */
    function updateOnlineUserList() {
        return co(function*() {
            let users = yield self.getCachedUsers(self.getOnlineUsers());
            let onlineList = _(users).filter(user => (user.setUp && (user.authorized || self.isUserAdmin(user)))).sortBy('alias').value();

            yield cache.setAsync('onlineUsers', JSON.stringify(onlineList));

            io.sockets.emit('onlineUserListUpdated', onlineList);
        });
    }

    /**
     * @async
     */
    function getOnlineUserList() {
        return co(function*() {
            if (!(yield cache.existsAsync('onlineUsers'))) {
                yield updateOnlineUserList();
            }

            return JSON.parse(yield cache.getAsync('onlineUsers'));
        });
    }

    /**
     * @async
     */
    self.processOnlineListUpdate = _.debounce(co.wrap(function* processOnlineListUpdate() {
        yield updateOnlineUserList();
    }));

    /**
     * @async
     */
    function postToMessageLog(message) {
        return co(function*() {
            let attachment;

            if (message.user) {
                attachment = {
                    fallback: `${message.user.alias}: ${message.body}`,
                    author_name: message.user.alias,
                    author_link: `${BASE_URL}/user/${helpers.getDocumentID(message.user)}`,
                    text: message.body
                };
            }
            else {
                attachment = {
                    fallback: message.body,
                    text: message.body
                };
            }

            yield self.postToSlack({
                channel: CHAT_LOG_CHANNEL,
                attachments: [attachment]
            });
        });
    }

    /**
     * @async
     */
    self.sendMessageToUser = co.wrap(function* sendMessageToUser(user, message) {
        if (message.user) {
            message.user = yield self.getCachedUser(message.user);
        }

        self.emitToUser(user, 'messageReceived', message);
    });

    /**
     * @async
     */
    self.sendMessage = co.wrap(function* sendMessage(message) {
        if (message.user) {
            message.user = yield self.getCachedUser(message.user);
        }

        if (message.body) {
            postToMessageLog(message);
        }

        io.sockets.emit('messageReceived', message);
    });

    self.on('userConnected', co.wrap(function*(userID) {
        if (SHOW_CONNECTION_MESSAGES) {
            let user = yield self.getCachedUser(userID);

            if (user.setUp && (user.authorized || self.isUserAdmin(user))) {
                self.sendMessage({
                    user: userID,
                    action: 'connected'
                });
            }
        }

        if (!userChatLimiters.has(userID)) {
            userChatLimiters.set(userID, new RateLimiter(1, RATE_LIMIT));
        }

        self.processOnlineListUpdate();
    }));

    self.on('userDisconnected', co.wrap(function*(userID) {
        if (SHOW_CONNECTION_MESSAGES) {
            let user = yield self.getCachedUser(userID);

            if (user.setUp && (user.authorized || self.isUserAdmin(user))) {
                self.sendMessage({
                    user: userID,
                    action: 'disconnected'
                });
            }
        }

        self.processOnlineListUpdate();
    }));

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('onlineUserListUpdated', yield getOnlineUserList());
    }));

    function onUserSendChatMessage(message) {
        let userID = this.decoded_token.user;

        co(function*() {
            let userChatLimiter = userChatLimiters.get(userID);

            if (!userChatLimiter.tryRemoveTokens(1) && !self.isUserAdmin(userID)) {
                return;
            }

            self.markUserActivity(userID);

            let userRestrictions = yield self.getUserRestrictions(userID);

            if (!_.includes(userRestrictions.aspects, 'chat')) {
                let trimmedMessage = _.chain(message).trim().truncate({
                    length: 140
                }).deburr().value();

                if (trimmedMessage.length > 0) {
                    let highlighted = false;

                    if (/@everyone@/i.test(message)) {
                        if (self.isUserAdmin(userID)) {
                            highlighted = true;
                        }
                    }

                    let mentionedAliases = _.uniqWith(twitter.extractMentions(trimmedMessage), (alias1, alias2) => (alias1.localeCompare(alias2, 'en', {
                        usage: 'search',
                        sensitivity: 'base'
                    }) === 0));

                    let mentions = yield _.map(mentionedAliases, alias => self.getUserByAlias(alias));
                    mentions = yield self.getCachedUsers(_(mentions).compact().uniqBy(user => helpers.getDocumentID(user)).value());

                    self.sendMessage({
                        user: userID,
                        body: trimmedMessage,
                        highlighted,
                        mentions
                    });
                }
            }
        });
    }

    function onUserPurgeUser(victim) {
        let userID = this.decoded_token.user;

        co(function*() {
            if (self.isUserAdmin(userID)) {
                let victimID = helpers.getDocumentID(victim);
                victim = yield self.getCachedUser(victim);

                self.postToAdminLog(userID, `purged the chat messages of \`<${BASE_URL}/player/${victim.steamID}|${victim.alias}>\``);

                io.sockets.emit('userPurged', victimID);
            }
        });
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('sendChatMessage');
        socket.on('sendChatMessage', onUserSendChatMessage);
        socket.on('purgeUser', onUserPurgeUser);
    });

    self.processOnlineListUpdate();
};
