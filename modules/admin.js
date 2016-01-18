/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const bodyParser = require('body-parser');
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

    function postToAdminLog(user, action) {
        return co(function*() {
            var message = {
                channel: '#admin-log',
                attachments: [{
                    fallback: user.alias + ' ' + action,
                    author_name: user.alias,
                    author_link: BASE_URL + '/admin/user/' + user.steamID,
                    text: action
                }]
            };

            yield self.postToSlack(message);
        });
    }

    router.get('/users', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/games', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/servers', co.wrap(function*(req, res) {
        let servers = yield self.getServerStatuses();

        res.render('admin/servers', {
            servers: servers
        });
    }));

    router.post('/servers', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (req.body.type === 'rconCommand') {
            postToAdminLog(req.user, 'executed `' + req.body.command + '` on server `' + req.body.server + '`');

            try {
                let result = yield self.sendRCONCommand(req.body.server, req.body.command);

                res.send(result);
            }
            catch (err) {
                res.sendStatus(500);

                self.postToLog({
                    description: 'RCON command `' + req.body.command + '` on server `' + req.body.server + '` failed',
                    error: err
                });
            }
        }

        res.sendStatus(404);
    }));

    app.use('/admin', router);

    self.postToLog = co.wrap(function* postToLog(info) {
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
                color: 'danger',
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
                author_link: BASE_URL + '/admin/user/' + user.steamID,
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
