'use strict';

const config = require('config');
const Discord = require('discord.js');
const client = new Discord.Client();
const Q = require('q');
const co = require('co');
const _ = require('lodash');

module.exports = function(app, cache, chance, database, io, self) {

if (config.has('server.discord')) {
        const APP_LOG_CHANNEL = config.has('server.discord.channels.appLog') ? config.get('server.discord.channels.appLog') : '#app-log';
        const TOKEN = config.get('server.discord.token');
        const DISCORD_MESSAGE_DEFAULTS = config.get('server.discord.messageDefaults');

        client.once('ready', () => {
                console.log('Ready');

        });

 client.login(TOKEN);

        /**
         * @async
         */

        self.postToDiscord = async function(message) {
                const channel = client.channels.cache.get(message.channel);
                try {
                        const webhooks = await channel.fetchWebhooks();
                        const webhook = webhooks.first();
                        await webhook.send('Log', {
                        username: DISCORD_MESSAGE_DEFAULTS.username,
                        avatarURL: DISCORD_MESSAGE_DEFAULTS.icon_url,
                        embeds: [{
                                color: 3447003,
                                author: {
                                        name: message.attachments[0].author_name,
                                        url: message.attachments[0].author_link
                                },
                                description: message.attachments[0].text,
                                timestamp: new Date()
                        }]
                        });
                } catch (error) {
                        console.error('Error trying to send: ', error);
                }

        };

        /**
         * @async
         */

        self.postToLog = co.wrap(function* postToLog(info) {
            let message = {
                channel: APP_LOG_CHANNEL,
                attachments: []
            };

            if (info.description) {
                message.text = info.description;
            }

            if (info.error) {
                let errorText = _.hasIn(info.error, 'stack') ? info.error.stack : info.error;

                message.attachments.push({
                    fallback: info.error,
                    color: 'danger',
                    text: `\`\`\`${errorText}\`\`\``
                });
            }

            yield self.postToDiscord(message);
        });

        co(function*() {
            yield self.postToLog({
                description: 'server booting up'
            });
        });
    }
    else {
        self.postToDiscord = co.wrap(_.noop);
        self.postToLog = co.wrap(_.noop);
    }


};
