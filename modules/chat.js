'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const twitter = require('twitter-text');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const SHOW_CONNECTION_MESSAGES = config.get('app.chat.showConnectionMessages');
    const UPDATE_ONLINE_USER_LIST_DEBOUNCE_MAX_WAIT = 5000;
    const UPDATE_ONLINE_USER_LIST_DEBOUNCE_WAIT = 1000;

    const updateOnlineUserList = _.debounce(co.wrap(function* updateOnlineUserList() {
        let users = yield _.map(self.getOnlineUsers(), user => self.getCachedUser(user));
        let onlineList = _(users).filter(user => (user.setUp && (user.authorized || self.isUserAdmin(user)))).sortBy('alias').value();

        yield cache.setAsync('onlineUsers', JSON.stringify(onlineList));

        io.sockets.emit('onlineUserListUpdated', yield getOnlineUserList());
    }), UPDATE_ONLINE_USER_LIST_DEBOUNCE_WAIT, {
        maxWait: UPDATE_ONLINE_USER_LIST_DEBOUNCE_MAX_WAIT
    });

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
                channel: '#chat-log',
                attachments: [attachment]
            });
        });
    }

    self.sendMessageToUser = co.wrap(function* sendMessageToUser(user, message) {
        if (message.user) {
            message.user = yield self.getCachedUser(message.user);
        }

        self.emitToUser(user, 'messageReceived', [message]);
    });

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

        updateOnlineUserList();
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

        updateOnlineUserList();
    }));

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('onlineUserListUpdated', yield getOnlineUserList());
    }));

    function onUserSendChatMessage(message) {
        let userID = this.decoded_token.user;

        return co(function*() {
            self.markUserActivity(userID);

            let userRestrictions = self.getUserRestrictions(userID);

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
                    let mentions = [];

                    for (let alias of mentionedAliases) {
                        let user = yield self.getUserByAlias(alias);

                        if (user) {
                            mentions.push(user);
                        }
                    }

                    mentions = yield _(mentions).uniqBy(user => self.getDocumentID(user)).map(user => self.getCachedUser(user)).value();

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

        return co(function*() {
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

    updateOnlineUserList();
};
