'use strict';

const _ = require('lodash');
const config = require('config');
const ms = require('ms');
const twitter = require('twitter-text');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const CHAT_LOG_CHANNEL = config.has('server.slack.channels.chatLog') ? config.get('server.slack.channels.chatLog') : '#chat-log';
    const RATE_LIMIT = ms(config.get('app.chat.rateLimit'));
    const SHOW_CONNECTION_MESSAGES = config.get('app.chat.showConnectionMessages');

    async function updateOnlineUserList() {
        let users = await self.getCachedUsers(self.getOnlineUsers());
        let onlineList = _(users).filter(user => (user.setUp && (user.authorized || self.isUserAdmin(user)))).sortBy('alias').value();

        await cache.setAsync('onlineUsers', JSON.stringify(onlineList));

        io.sockets.emit('onlineUserListUpdated', onlineList);
    }

    async function getOnlineUserList() {
        if (!(await cache.existsAsync('onlineUsers'))) {
            await updateOnlineUserList();
        }

        return JSON.parse(await cache.getAsync('onlineUsers'));
    }

    self.processOnlineListUpdate = _.debounce(async function processOnlineListUpdate() {
        await updateOnlineUserList();
    });

    async function postToMessageLog(message) {
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

        await self.postToSlack({
            channel: CHAT_LOG_CHANNEL,
            attachments: [attachment]
        });
    }

    self.sendMessageToUser = async function sendMessageToUser(user, message) {
        if (message.user) {
            message.user = await self.getCachedUser(message.user);
        }

        self.emitToUser(user, 'messageReceived', message);
    };

    self.sendMessage = async function sendMessage(message) {
        if (message.user) {
            message.user = await self.getCachedUser(message.user);
        }

        if (message.body) {
            postToMessageLog(message);
        }

        io.sockets.emit('messageReceived', message);
    };

    self.on('userConnected', async function(userID) {
        if (SHOW_CONNECTION_MESSAGES) {
            let user = await self.getCachedUser(userID);

            if (user.setUp && (user.authorized || self.isUserAdmin(user))) {
                self.sendMessage({
                    user: userID,
                    action: 'connected'
                });
            }
        }

        self.processOnlineListUpdate();
    });

    self.on('userDisconnected', async function(userID) {
        if (SHOW_CONNECTION_MESSAGES) {
            let user = await self.getCachedUser(userID);

            if (user.setUp && (user.authorized || self.isUserAdmin(user))) {
                self.sendMessage({
                    user: userID,
                    action: 'disconnected'
                });
            }
        }

        self.processOnlineListUpdate();
    });

    io.sockets.on('connection', async function(socket) {
        socket.emit('onlineUserListUpdated', await getOnlineUserList());
    });

    async function onUserSendChatMessage(message) {
        let userID = this.decoded_token.user;

        try {
            if (!self.isUserAdmin(userID)) {
                let cacheResponse = await cache.getAsync(`chatLimited-${userID}`);

                if (!_.isNil(cacheResponse) && JSON.parse(cacheResponse)) {
                    return;
                }

                await cache.setAsync(`chatLimited-${userID}`, JSON.stringify(true), 'PX', RATE_LIMIT);
            }

            let userRestrictions = await self.getUserRestrictions(userID);

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

                    let mentions = await Promise.all(_.map(mentionedAliases, alias => self.getUserByAlias(alias)));
                    mentions = await self.getCachedUsers(_(mentions).compact().uniqBy(user => helpers.getDocumentID(user)).value());

                    self.sendMessage({
                        user: userID,
                        body: trimmedMessage,
                        highlighted,
                        mentions
                    });
                }
            }
        }
        catch (err) {
            console.err(err.stack);
        }
    }

    async function onUserPurgeUser(victim) {
        let userID = this.decoded_token.user;

        try {
            if (self.isUserAdmin(userID)) {
                let victimID = helpers.getDocumentID(victim);
                victim = await self.getCachedUser(victim);

                self.postToAdminLog(userID, `purged the chat messages of \`<${BASE_URL}/player/${victim.steamID}|${victim.alias}>\``);

                io.sockets.emit('userPurged', victimID);
            }
        }
        catch (err) {
            console.err(err.stack);
        }
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('sendChatMessage');
        socket.on('sendChatMessage', onUserSendChatMessage);
        socket.on('purgeUser', onUserPurgeUser);
    });

    self.processOnlineListUpdate();
};
