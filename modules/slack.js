'use strict';

const _ = require('lodash');
const Botkit = require('botkit');
const co = require('co');
const config = require('config');
const Q = require('q');

module.exports = function(app, cache, chance, database, io, self) {
    if (config.has('server.slack')) {
        const SLACK_INCOMING_WEBHOOK_URL = config.get('server.slack.incomingWebhook');
        const SLACK_MESSAGE_DEFAULTS = config.get('server.slack.messageDefaults');

        var controller = Botkit.slackbot();
        var bot = controller.spawn({
            incoming_webhook: {
                url: SLACK_INCOMING_WEBHOOK_URL
            }
        });

        /**
         * @async
         */
        self.postToSlack = co.wrap(function* postToSlack(message) {
            yield Q.ninvoke(bot, 'sendWebhook', _.defaultsDeep(message, SLACK_MESSAGE_DEFAULTS));
        });

        /**
         * @async
         */
        self.postToLog = co.wrap(function* postToLog(info) {
            let message = {
                channel: '#app-log',
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

            yield self.postToSlack(message);
        });
    }
    else {
        self.postToSlack = function postToSlack() {};
        self.postToLog = function postToLog() {};
    }
};
