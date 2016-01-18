/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const config = require('config');
const express = require('express');

module.exports = function(app, database, io, self, server) {
    const BASE_URL = config.get('server.baseURL');

    var router = express.Router();

    router.use('/', function(req, res, next) {
        if (!req.user || !req.user.admin) {
            res.status(403).render('unauthorized');
        }
        else {
            next();
        }
    });

    router.get('/users', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/games', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/servers', function(req, res) {
        // TODO: implement admin page
    });

    app.use('/admin', router);

    self.postToLog = co.wrap(function* postToLog(info) {
        console.log(info);

        var message = {
            channel: '#app-log',
            attachments: []
        };

        if (info.description) {
            message.text = info.description;
        }

        if (info.error) {
            message.attachments.push({
                fallback: info.error,
                color: danger,
                text: '```' + _.hasIn(info.error, 'stack') ? info.error.stack : info.error + '```'
            });
        }

        yield self.postToSlack(message);
    });

    self.requestAdmin = co.wrap(function* requestHelp(userID, message) {
        let user = self.getCachedUser(userID);
        let trimmedMessage = _.trim(message);

        yield self.postToSlack({
            channel: '#admin-request',
            attachments: [{
                fallback: trimmedMessage ? user.alias + ' requested help: ' + trimmedMessage : user.alias + ' requested help',
                color: 'warning',
                author_name: user.alias,
                author_link: BASE_URL + '/user/' + user.steamID,
                text: trimmedMessage
            }]
        });
    });

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token.user;

        socket.on('requestAdmin', co.wrap(function*(message) {
            try {
                yield self.requestAdmin(userID, message);
            }
            catch (err) {
                self.sendMessage({
                    action: 'admin request failed'
                });
            }
        }));
    });
};
