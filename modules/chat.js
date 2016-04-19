'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');
const RateLimiter = require('limiter').RateLimiter;
const twitter = require('twitter-text');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const CHAT_LOG_CHANNEL = config.has('slack.channels.chatLog') ? config.get('slack.channels.chatLog') : '#chat-log';
    const RATE_LIMIT = ms(config.get('app.chat.rateLimit'));
    const SHOW_CONNECTION_MESSAGES = config.get('app.chat.showConnectionMessages');
    const UPDATE_ONLINE_USER_LIST_DEBOUNCE_MAX_WAIT = 5000;
    const UPDATE_ONLINE_USER_LIST_DEBOUNCE_WAIT = 1000;

    var userChatLimiters = new Map();

    /**
     * @async
     */
    const updateOnlineUserList = _.debounce(co.wrap(function* updateOnlineUserList() {
        let users = yield _.map(self.getOnlineUsers(), user => self.getCachedUser(user));
        let onlineList = _(users).filter(user => (user.setUp && (user.authorized || self.isUserAdmin(user)))).sortBy('alias').value();

        yield cache.setAsync('onlineUsers', JSON.stringify(onlineList));

        io.sockets.emit('onlineUserListUpdated', onlineList);
    }), UPDATE_ONLINE_USER_LIST_DEBOUNCE_WAIT, {
        maxWait: UPDATE_ONLINE_USER_LIST_DEBOUNCE_MAX_WAIT
    });

    /**
     * @async
     */
    function getOnlineUserList() {
        return co(function*() {
            let cacheResponse = yield cache.getAsync('onlineUsers');

            if (!cacheResponse) {
                yield updateOnlineUserList();
                cacheResponse = yield cache.getAsync('onlineUsers');
            }

            return JSON.parse(cacheResponse);
        });
    }

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
                    author_link: `${BASE_URL}/user/${message.user.id}`,
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

        self.emitToUser(user, 'messageReceived', [message]);
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

        yield updateOnlineUserList();
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

        yield updateOnlineUserList();
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
                    mentions = yield _(mentions).compact().uniqBy(user => self.getDocumentID(user)).map(user => self.getCachedUser(user)).value();

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
                let victimID = self.getDocumentID(victim);
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

    co(function*() {
        yield updateOnlineUserList();
    });
};
