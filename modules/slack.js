'use strict';

const _ = require('lodash');
const Botkit = require('botkit');
const config = require('config');
const Q = require('q');

module.exports = function(app, cache, chance, database, io, self) {
    if (config.has('server.slack')) {
        const APP_LOG_CHANNEL = config.has('server.slack.channels.appLog') ? config.get('server.slack.channels.appLog') : '#app-log';
        const SLACK_INCOMING_WEBHOOK_URL = config.get('server.slack.incomingWebhook');
        const SLACK_MESSAGE_DEFAULTS = config.get('server.slack.messageDefaults');

        var controller = Botkit.slackbot();
        var bot = controller.spawn({
            incoming_webhook: {
                url: SLACK_INCOMING_WEBHOOK_URL
            }
        });

        self.postToSlack = async function postToSlack(message) {
            await Q.ninvoke(bot, 'sendWebhook', _.defaultsDeep(message, SLACK_MESSAGE_DEFAULTS));
        };

        self.postToLog = async function postToLog(info) {
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

            await self.postToSlack(message);
        };

        (async function() {
            await self.postToLog({
                description: 'server booting up'
            });
        })();
    }
    else {
        self.postToSlack = _.noop;
        self.postToLog = _.noop;
    }
};
