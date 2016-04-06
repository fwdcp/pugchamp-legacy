'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const express = require('express');
const HttpStatus = require('http-status-codes');
const moment = require('moment');

module.exports = function(app, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const HIDE_DRAFT_STATS = config.get('app.users.hideDraftStats');

    var router = express.Router();

    router.use('/', function(req, res, next) {
        if (!req.user || !req.user.admin) {
            res.status(HttpStatus.FORBIDDEN).render('unauthorized');
        }
        else {
            next();
            return;
        }
    });

    self.postToAdminLog = co.wrap(function* postToAdminLog(userID, action) {
        let user = self.getCachedUser(userID);

        let message = {
            channel: '#admin-log',
            attachments: [{
                fallback: `${user.alias} ${action}`,
                author_name: user.alias,
                author_link: `${BASE_URL}/player/${user.steamID}`,
                text: action
            }]
        };

        yield self.postToSlack(message);
    });

    router.post('/user/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let user = yield database.User.findById(req.params.id);

        if (!user) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'changeSettings') {
            if (req.body.alias !== user.alias) {
                let existingUser = yield database.User.findOne({
                    alias: req.body.alias
                });

                if (!existingUser) {
                    self.postToAdminLog(req.user.id, `changed the alias of \`<${BASE_URL}/player/${user.steamID}|${req.body.alias}>\` from \`${user.alias}\``);

                    user.alias = req.body.alias;
                }
            }

            if (!HIDE_DRAFT_STATS) {
                let showDraftStats = !!req.body.showDraftStats;
                if (showDraftStats !== user.options.showDraftStats) {
                    if (showDraftStats) {
                        self.postToAdminLog(req.user.id, `enabled showing draft stats for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\``);
                    }
                    else {
                        self.postToAdminLog(req.user.id, `disabled showing draft stats for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\``);
                    }

                    user.options.showDraftStats = showDraftStats;
                }
            }

            try {
                yield user.save();

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to save settings for <${BASE_URL}/player/${user.steamID}|${user.alias}>: ${JSON.stringify(req.body)}`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'createRestriction') {
            let aspects = req.body.aspects ? _.split(req.body.aspects, ',') : [];
            let expires = req.body.expires ? req.body.expires : null;
            let reason = req.body.reason ? req.body.reason : null;

            let restriction = new database.Restriction({
                user: user.id,
                active: true,
                aspects,
                reason,
                expires
            });

            let formattedAspects = _.size(restriction.aspects) > 0 ? ` (aspects: ${restriction.aspects.join(', ')})` : '';
            let formattedExpiration = restriction.expires ? ` (expires: ${moment(restriction.expires).format('llll')})` : ' (expires: never)';
            let formattedReason = restriction.reason ? ` (reason: ${restriction.reason})` : '';
            self.postToAdminLog(req.user.id, `restricted \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\`${formattedAspects}${formattedExpiration}${formattedReason}`);

            try {
                yield restriction.save();
                yield self.updateUserRestrictions(user.id);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to apply restriction to <${BASE_URL}/player/${user.steamID}|${user.alias}>: ${JSON.stringify(req.body)}`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'revokeRestriction') {
            let restriction = yield database.Restriction.findById(req.body.restriction);

            if (!restriction) {
                res.sendStatus(HttpStatus.NOT_FOUND);
                return;
            }

            if (user.id === self.getDocumentID(restriction.user) && restriction.active) {
                let formattedAspects = _.size(restriction.aspects) > 0 ? ` (aspects: ${restriction.aspects.join(', ')})` : '';
                let formattedExpiration = restriction.expires ? ` (expires: ${moment(restriction.expires).format('llll')})` : ' (expires: never)';
                let formattedReason = restriction.reason ? ` (reason: ${restriction.reason})` : '';
                self.postToAdminLog(req.user.id, `revoked restriction for \`<${BASE_URL}/player/${user.steamID}|${user.alias}>\`${formattedAspects}${formattedExpiration}${formattedReason}`);

                restriction.active = false;

                try {
                    yield restriction.save();
                    yield self.updateUserRestrictions(user.id);

                    res.sendStatus(HttpStatus.OK);
                }
                catch (err) {
                    self.postToLog({
                        description: `failed to revoke restriction \`${restriction.id}\` for <${BASE_URL}/player/${user.steamID}|${user.alias}>`,
                        error: err
                    });

                    res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
                }
            }
            else {
                res.sendStatus(HttpStatus.BAD_REQUEST);
            }
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    router.post('/game/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        let game = yield database.Game.findById(req.params.id);

        if (!game) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'reassignServer') {
            if (game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            let availableServers = yield self.getAvailableServers();

            if (_.size(availableServers) === 0) {
                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
                return;
            }

            let server = chance.pick(availableServers);

            self.postToAdminLog(req.user.id, `reassigned game \`<${BASE_URL}/game/${game.id}|${game.id}>\` to server \`${server}\``);

            try {
                yield self.shutdownGame(game);
                yield self.assignGameToServer(game, server);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to reassign game \`<${BASE_URL}/game/${game.id}|${game.id}>\` to server \`${game.server}\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'reinitializeServer') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user.id, `reinitialized server \`${game.server}\` for game \`<${BASE_URL}/game/${game.id}|${game.id}>\``);

            try {
                yield self.initializeServer(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to reinitialize server \`${game.server}\` for game \`<${BASE_URL}/game/${game.id}|${game.id}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'updateServerPlayers') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user.id, `updated players for server \`${game.server}\` for game \`<${BASE_URL}/game/${game.id}|${game.id}>\``);

            try {
                yield self.updateServerPlayers(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update players for server \`${game.server}\` for game \`<${BASE_URL}/game/${game.id}|${game.id}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else if (req.body.type === 'requestSubstitute') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            let player = self.getCachedUser(req.body.player);

            if (!player) {
                res.sendStatus(HttpStatus.NOT_FOUND);
                return;
            }

            let gamePlayerInfo = self.getGamePlayerInfo(game, player.id);

            if (!gamePlayerInfo || gamePlayerInfo.player.replaced) {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user.id, `requested substitute for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${game.id}|${game.id}>\``);

            self.requestSubstitute(game, player.id);

            res.sendStatus(HttpStatus.OK);
        }
        else if (req.body.type === 'abortGame') {
            if (game.status === 'aborted' || game.status === 'completed') {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user.id, `aborted game \`<${BASE_URL}/game/${game.id}|${game.id}>\``);

            try {
                yield self.abortGame(game);

                res.sendStatus(HttpStatus.OK);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to abort game \`<${BASE_URL}/game/${game.id}|${game.id}>\``,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    router.post('/server/:id', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (!_.has(GAME_SERVER_POOL, req.params.id)) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        if (req.body.type === 'rconCommand') {
            let trimmedCommand = _.trim(req.body.command);

            if (!trimmedCommand) {
                res.sendStatus(HttpStatus.BAD_REQUEST);
                return;
            }

            self.postToAdminLog(req.user.id, `executed \`${req.body.command}\` on server \`${req.params.id}\``);

            try {
                let result = yield self.sendRCONCommand(req.params.id, req.body.command);

                res.json(result);
            }
            catch (err) {
                self.postToLog({
                    description: `RCON command \`${req.body.command}\` on server \`${req.params.id}\` failed`,
                    error: err
                });

                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }
        else {
            res.sendStatus(HttpStatus.BAD_REQUEST);
        }
    }));

    app.use('/admin', router);

    self.requestAdmin = co.wrap(function* requestHelp(userID, message) {
        let user = self.getCachedUser(userID);
        let trimmedMessage = _.trim(message);

        yield self.postToSlack({
            channel: '#admin-request',
            attachments: [{
                fallback: trimmedMessage ? `${user.alias} requested help: ${trimmedMessage}` : `${user.alias} requested help`,
                color: 'warning',
                author_name: user.alias,
                author_link: `${BASE_URL}/player/${user.steamID}`,
                text: trimmedMessage
            }]
        });
    });

    function onRequestAdmin(message) {
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
