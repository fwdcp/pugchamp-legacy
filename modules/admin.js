/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const express = require('express');
const moment = require('moment');

module.exports = function(app, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const GAME_SERVER_POOL = config.get('app.servers.pool');

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
            let message = {
                channel: '#admin-log',
                attachments: [{
                    fallback: user.alias + ' ' + action,
                    author_name: user.alias,
                    author_link: BASE_URL + '/player/' + user.steamID,
                    text: action
                }]
            };

            yield self.postToSlack(message);
        });
    }

    router.post('/user/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let user = yield database.User.findById(req.params.id);

        if (!user) {
            res.sendStatus(404);
            return;
        }

        if (req.body.type === 'changeSettings') {
            if (req.body.alias !== user.alias) {
                let existingUser = yield database.User.findOne({
                    alias: req.body.alias
                });

                if (!existingUser) {
                    postToAdminLog(req.user, 'changed the alias of `<' + BASE_URL + '/player/' + user.steamID + '|' + req.body.alias + '>` from `' + user.alias + '`');

                    user.alias = req.body.alias;
                }
            }

            try {
                yield user.save();

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to save settings for <' + BASE_URL + '/player/' + user.steamID + '|' + user.alias + '>: ' + JSON.stringify(req.body),
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else if (req.body.type === 'createRestriction') {
            let aspects = _.split(req.body.aspects, ',');
            let expires = req.body.expires ? req.body.expires : null;
            let reason = req.body.reason ? req.body.reason : null;

            if (_.size(aspects) === 0) {
                res.sendStatus(400);
                return;
            }

            let restriction = new database.Restriction({
                user: user.id,
                active: true,
                aspects: aspects,
                reason: reason,
                expires: expires
            });

            postToAdminLog(req.user, 'restricted `<' + BASE_URL + '/player/' + user.steamID + '|' + user.alias + '>` (aspects: ' + restriction.aspects.join(', ') + ') (expires: ' + (restriction.expires ? moment(restriction.expires).format('llll') : 'never') + ') (reason: ' + restriction.reason + ')');

            try {
                yield restriction.save();
                yield self.updateUserRestrictions(user.id);

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to apply restriction to <' + BASE_URL + '/player/' + user.steamID + '|' + user.alias + '>: ' + JSON.stringify(req.body),
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else if (req.body.type === 'revokeRestriction') {
            let restriction = yield database.Restriction.findById(req.body.restriction);

            if (!restriction) {
                res.sendStatus(404);
                return;
            }

            if (user.id === self.getDocumentID(restriction.user) && restriction.active) {
                postToAdminLog(req.user, 'revoked restriction for `<' + BASE_URL + '/player/' + user.steamID + '|' + user.alias + '>` (aspects: ' + restriction.aspects.join(', ') + ') (expires: ' + (restriction.expires ? moment(restriction.expires).format('llll') : 'never') + ') (reason: ' + restriction.reason + ')');

                restriction.active = false;

                try {
                    yield restriction.save();
                    yield self.updateUserRestrictions(user.id);

                    res.sendStatus(200);
                }
                catch (err) {
                    self.postToLog({
                        description: 'failed to revoke restriction `' + restriction.id + '` for <' + BASE_URL + '/player/' + user.steamID + '|' + user.alias + '>',
                        error: err
                    });

                    res.sendStatus(500);
                }
            }
            else {
                res.sendStatus(400);
            }
        }
        else {
            res.sendStatus(400);
        }
    }));

    router.post('/game/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let game = yield database.Game.findById(req.params.id);

        if (!game) {
            res.sendStatus(404);
            return;
        }

        if (req.body.type === 'reassignServer') {
            if (game.status === 'completed') {
                res.sendStatus(400);
                return;
            }

            let availableServers = yield self.getAvailableServers();

            if (_.size(availableServers) === 0) {
                res.sendStatus(500);
                return;
            }

            let server = chance.pick(availableServers);

            postToAdminLog(req.user, 'reassigned game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>` to server `' + server + '`');

            try {
                yield self.shutdownGame(game);
                yield self.assignGameToServer(game, server);

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to reassign game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>` to server `' + game.server + '`',
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else if (req.body.type === 'reinitializeServer') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(400);
                return;
            }

            postToAdminLog(req.user, 'reinitialized server `' + game.server + '` for game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`');

            try {
                yield self.initializeServer(game);

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to reinitialize server `' + game.server + '` for game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`',
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else if (req.body.type === 'updateServerPlayers') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(400);
                return;
            }

            postToAdminLog(req.user, 'updated players for server `' + game.server + '` for game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`');

            try {
                yield self.updateServerPlayers(game);

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to update players for server `' + game.server + '` for game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`',
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else if (req.body.type === 'requestSubstitute') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(400);
                return;
            }

            let player = self.getCachedUser(req.body.player);

            if (!player) {
                res.sendStatus(404);
                return;
            }

            let gamePlayerInfo = self.getGamePlayerInfo(game, player.id);

            if (!gamePlayerInfo || gamePlayerInfo.player.replaced) {
                res.sendStatus(400);
                return;
            }

            postToAdminLog(req.user, 'requested substitute for player `<' + BASE_URL + '/player/' + player.steamID + '|' + player.alias + '>` for game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`');

            self.requestSubstitute(game, player.id);

            res.sendStatus(200);
        }
        else if (req.body.type === 'abortGame') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(400);
                return;
            }

            postToAdminLog(req.user, 'aborted game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`');

            try {
                yield self.abortGame(game);

                res.sendStatus(200);
            }
            catch (err) {
                self.postToLog({
                    description: 'failed to abort game `<' + BASE_URL + '/game/' + game.id + '|' + game.id + '>`',
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else {
            res.sendStatus(400);
        }
    }));

    router.post('/server/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (!_.has(GAME_SERVER_POOL, req.params.id)) {
            res.sendStatus(404);
            return;
        }

        if (req.body.type === 'rconCommand') {
            let trimmedCommand = _.trim(req.body.command);

            if (!trimmedCommand) {
                res.sendStatus(400);
                return;
            }

            postToAdminLog(req.user, 'executed `' + req.body.command + '` on server `' + req.params.id + '`');

            try {
                let result = yield self.sendRCONCommand(req.params.id, req.body.command);

                res.send(result);
            }
            catch (err) {
                self.postToLog({
                    description: 'RCON command `' + req.body.command + '` on server `' + req.params.id + '` failed',
                    error: err
                });

                res.sendStatus(500);
            }
        }
        else {
            res.sendStatus(400);
        }
    }));

    app.use('/admin', router);

    self.requestAdmin = co.wrap(function* requestHelp(userID, message) {
        let user = self.getCachedUser(userID);
        let trimmedMessage = _.trim(message);

        yield self.postToSlack({
            channel: '#admin-request',
            attachments: [{
                fallback: trimmedMessage ? user.alias + ' requested help: ' + trimmedMessage : user.alias + ' requested help',
                color: 'warning',
                author_name: user.alias,
                author_link: BASE_URL + '/player/' + user.steamID,
                text: trimmedMessage
            }]
        });
    });

    function onRequestAdmin(message) {
        /*jshint validthis: true */
        let userID = this.decoded_token.user;

        return co(function*() {
            let userRestrictions = self.getUserRestrictions(userID);

            if (!_.includes(userRestrictions, 'support')) {
                try {
                    yield self.requestAdmin(userID, message);
                }
                catch (err) {
                    self.sendMessageToUser(userID, {
                        action: 'admin request failed'
                    });
                }
            }
        });
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('requestAdmin');
        socket.on('requestAdmin', onRequestAdmin);
    });
};
