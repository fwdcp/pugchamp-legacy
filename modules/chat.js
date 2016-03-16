'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const twitter = require('twitter-text');

module.exports = function(app, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');

    var onlineUsers = new Set();

    self.getOnlineUserList = function() {
        return _([...onlineUsers]).map(userID => self.getCachedUser(userID)).filter(user => user.setUp).sortBy('alias').value();
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

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    self.on('userDisconnected', function(userID) {
        onlineUsers.delete(userID);

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    function onUserSendChatMessage(message) {
        let userID = this.decoded_token.user;

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

                let mentions = _.intersectionWith(self.getCachedUsers(), twitter.extractMentions(trimmedMessage), (user, alias) => alias.localeCompare(user.alias, 'en', {usage: 'search', sensitivity: 'base'}) === 0);

                self.sendMessage({
                    user: userID,
                    body: trimmedMessage,
                    highlighted,
                    mentions
                });
            }
        }
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('sendChatMessage');
        socket.on('sendChatMessage', onUserSendChatMessage);
    });
};
