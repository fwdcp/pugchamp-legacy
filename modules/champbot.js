/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";
var Botkit = require('botkit');


module.exports = function(app, database, io, self, server) {

	var controller = Botkit.slackbot();
	var bot = controller.spawn({
		token: 'xoxb-18706803635-Klshn8B1UncqVK5udK2RnChS',
		incoming_webhook: {
			url: 'https://hooks.slack.com/services/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'
		}
	})
	bot.startRTM(function(err,bot,payload) {
		if (err) {
			throw new Error('Could not connect to Slack');
		}
	});
	

	self.on('adminRequested', function(user) {  
		bot.sendWebhook({
		    username: "champbot",
			icon_emoji: ":robot_face:",
			text: "HELP! " + user.alias + " with steamid: " + user.steamID + " has requested an admin",
			channel: '#champbottest',
			}, function(err,res) {
				if(err) {
				throw new Error('Something went wrong with the webhook');
			}
		});
	});


}