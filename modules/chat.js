'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const twitter = require('twitter-text');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const SHOW_CONNECTION_MESSAGES = config.get('app.chat.showConnectionMessages');

    var onlineUsers = new Set();

    self.getOnlineUserList = function() {
        return _([...onlineUsers]).map(userID => self.getCachedUser(userID)).filter(user => (user.setUp && (user.authorized || user.admin))).sortBy('alias').value();
    };

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

    self.sendMessageToUser = function sendMessageToUser(userID, message) {
        if (message.user) {
            message.user = self.getCachedUser(message.user);
        }

        self.emitToUser(userID, 'messageReceived', [message]);
    };

    self.sendMessage = function sendMessage(message) {
        if (message.user) {
            message.user = self.getCachedUser(message.user);
        }

        if (message.body) {
            postToMessageLog(message);
        }

        io.sockets.emit('messageReceived', message);
    };

    self.on('userConnected', function(userID) {
        onlineUsers.add(userID);

        if (SHOW_CONNECTION_MESSAGES) {
            let user = self.getCachedUser(userID);

            if (user.setUp && (user.authorized || user.admin)) {
                self.sendMessage({
                    user: userID,
                    action: 'connected'
                });
            }
        }

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    self.on('userDisconnected', function(userID) {
        let user = self.getCachedUser(userID);

        if (SHOW_CONNECTION_MESSAGES) {
            if (user.setUp && (user.authorized || user.admin)) {
                self.sendMessage({
                    user: userID,
                    action: 'disconnected'
                });
            }
        }

        onlineUsers.delete(userID);

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

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
                        let user = self.getCachedUser(userID);

                        if (user.admin) {
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

                    mentions = _(mentions).uniqBy(user => user.id).map(user => user.toObject()).value();

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

    function onUserPurgeUser(victimID) {
        let userID = this.decoded_token.user;

        let user = self.getCachedUser(userID);

        if (user.admin) {
            let victim = self.getCachedUser(victimID);

            self.postToAdminLog(user.id, `purged the chat messages of \`<${BASE_URL}/player/${victim.steamID}|${victim.alias}>\``);

            io.sockets.emit('userPurged', victimID);
        }
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('sendChatMessage');
        socket.on('sendChatMessage', onUserSendChatMessage);
        socket.on('purgeUser', onUserPurgeUser);
    });
};
