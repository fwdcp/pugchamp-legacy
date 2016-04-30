'use strict';

const _ = require('lodash');
const child_process = require('mz/child_process');
const co = require('co');
const config = require('config');
const fs = require('fs');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const math = require('mathjs');
const moment = require('moment');
const ms = require('ms');
const path = require('path');

require('moment-duration-format');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const MONGODB_URL = config.get('server.mongodb');
    const POST_GAME_RESET_DELAY = ms(config.get('app.games.postGameResetDelay'));
    const RATING_BASE = config.get('app.users.ratingBase');
    const ROLES = config.get('app.games.roles');
    const SUBSTITUTE_REQUEST_PERIOD = ms(config.get('app.games.substituteRequestPeriod'));
    const SUBSTITUTE_SELECTION_METHOD = config.get('app.games.substituteSelectionMethod');

    self.getGameUsers = function getGameUsers(game) {
        let users = [];

        for (let team of game.teams) {
            users.push(team.captain);

            for (let role of team.composition) {
                for (let player of role.players) {
                    users.push(player.user);
                }
            }
        }

        return _.uniqBy(users, user => self.getDocumentID(user));
    };

    self.getGameUserInfo = function getGameUserInfo(game, user) {
        let userID = self.getDocumentID(user);

        let team;
        let role;
        let player;

        team = _.find(game.teams, function(currentTeam) {
            role = _.find(currentTeam.composition, function(currentRole) {
                player = _.find(currentRole.players, function(currentPlayer) {
                    return userID === self.getDocumentID(currentPlayer.user);
                });

                if (player) {
                    return true;
                }

                return false;
            });

            if (role || userID === self.getDocumentID(currentTeam.captain)) {
                return true;
            }

            return false;
        });

        if (team) {
            return {
                game,
                team,
                role,
                player
            };
        }

        return null;
    };

    /**
     * @async
     */
    function rateGame(game) {
        return co(function*() {
            yield child_process.exec(`python rate_game.py ${self.getDocumentID(game)}`, {
                cwd: path.resolve(__dirname, '../ratings')
            });
        });
    }

    /**
     * @async
     */
    function updateCurrentGame(game, user) {
        return co(function*() {
            if (game.status === 'launching' || game.status === 'live') {
                let gameUserInfo = self.getGameUserInfo(game.toObject(), user);

                let currentGameInfo = {
                    game: self.getDocumentID(game),
                    team: _.omit(gameUserInfo.team, 'composition'),
                    user: yield self.getCachedUser(user)
                };

                currentGameInfo.team.captain = yield self.getCachedUser(gameUserInfo.team.captain);

                currentGameInfo.player = gameUserInfo.role && gameUserInfo.player;
                if (currentGameInfo.player) {
                    currentGameInfo.role = ROLES[gameUserInfo.role.role];
                    currentGameInfo.replaced = gameUserInfo.player.replaced;

                    if (!currentGameInfo.replaced && game.server) {
                        currentGameInfo.server = _.omit(GAME_SERVER_POOL[game.server], 'rcon', 'salt');
                        currentGameInfo.server.id = game.server;
                    }
                }

                currentGameInfo.captain = self.getDocumentID(gameUserInfo.team.captain) === self.getDocumentID(user);
                if (currentGameInfo.captain) {
                    currentGameInfo.activeTeamPlayers = yield _(gameUserInfo.team.composition).map(role => _(role.players).reject('replaced').map(player => ({
                        user: player.user,
                        role: ROLES[role.role]
                    })).value()).flattenDeep().map(co.wrap(function*(player) {
                        player.user = yield self.getCachedUser(player.user);

                        return player;
                    })).value();
                }

                yield cache.setAsync(`currentGame-${self.getDocumentID(user)}`, JSON.stringify(currentGameInfo));

                self.emitToUser(user, 'currentGameUpdated', [currentGameInfo]);
            }
            else {
                yield cache.delAsync(`currentGame-${self.getDocumentID(user)}`);

                self.emitToUser(user, 'currentGameUpdated', [null]);
            }
        });
    }

    /**
     * @async
     */
    function getCurrentGame(user) {
        return co(function*() {
            let cacheResponse = yield cache.getAsync(`currentGame-${self.getDocumentID(user)}`);

            return JSON.parse(cacheResponse);
        });
    }

    /**
     * @async
     */
    function updateGameList() {
        return co(function*() {
            /* eslint-disable lodash/prefer-lodash-method */
            let games = yield database.Game.find({}).sort('-date').select('date status teams.faction teams.captain score map duration').populate('teams.captain', 'alias steamID').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            yield cache.setAsync('allGameList', JSON.stringify(_.invokeMap(games, 'toObject')));
            yield cache.setAsync('allVisibleGameList', JSON.stringify(_(games).filter(game => game.status !== 'initializing' && game.status !== 'aborted').invokeMap('toObject').value()));
            yield cache.setAsync('recentGameList', JSON.stringify(_(games).takeWhile(game => moment().diff(game.date, 'days') < 1).invokeMap('toObject').value()));
            yield cache.setAsync('recentVisibleGameList', JSON.stringify(_(games).takeWhile(game => moment().diff(game.date, 'days') < 1).filter(game => game.status !== 'initializing' && game.status !== 'aborted').invokeMap('toObject').value()));
        });
    }

    /**
     * @async
     */
    function getGameList(old, invisible) {
        return co(function*() {
            let keyName;

            if (old) {
                if (invisible) {
                    keyName = 'allGameList';
                }
                else {
                    keyName = 'allVisibleGameList';
                }
            }
            else {
                if (invisible) {
                    keyName = 'recentGameList';
                }
                else {
                    keyName = 'recentVisibleGameList';
                }
            }

            let cacheResponse = yield cache.getAsync(keyName);

            if (!cacheResponse) {
                yield updateGameList();
                cacheResponse = yield cache.getAsync(keyName);
            }

            return JSON.parse(cacheResponse);
        });
    }

    /**
     * @async
     */
    self.processGameUpdate = co.wrap(function* processGameUpdate(game) {
        let gameID = self.getDocumentID(game);
        game = yield database.Game.findById(gameID);

        if (game.status !== 'initializing') {
            if (self.getDocumentID(game) === self.getCurrentDraftGame()) {
                yield self.cleanUpDraft();
            }
        }

        yield _.map(self.getGameUsers(game), user => self.updateUserRestrictions(user));
        yield _.map(self.getGameUsers(game), user => updateCurrentGame(game, user));

        yield self.invalidateGamePage(game);
        yield updateGameList();
        yield _.map(self.getGameUsers(game), user => self.invalidatePlayerPage(game, user));
    });

    var currentSubstituteRequests = new Map();

    self.getCurrentSubstituteRequests = function getCurrentSubstituteRequests() {
        return _.toArray(currentSubstituteRequests.values());
    };

    /**
     * @async
     */
    function updateSubstituteRequestsMessage() {
        return co(function*() {
            let substituteRequestsMessage = {
                requests: []
            };

            let outgoingPlayers = _.keyBy(yield _(currentSubstituteRequests.values()).toArray().map(request => self.getCachedUser(request.player)).value(), user => self.getDocumentID(user));

            for (let request of currentSubstituteRequests.entries()) {
                substituteRequestsMessage.requests.push({
                    id: request[0],
                    game: request[1].game,
                    role: ROLES[request[1].role],
                    captain: self.getDocumentID(request[1].captain),
                    player: outgoingPlayers[self.getDocumentID(request[1].player)],
                    candidates: _.toArray(request[1].candidates),
                    startTime: request[1].opened,
                    endTime: request[1].opened + SUBSTITUTE_REQUEST_PERIOD
                });
            }

            yield cache.setAsync('substituteRequests', JSON.stringify(substituteRequestsMessage));

            io.sockets.emit('substituteRequestsUpdated', yield getSubstituteRequestsMessage());
        });
    }

    /**
     * @async
     */
    function getSubstituteRequestsMessage() {
        return co(function*() {
            let cacheResponse = yield cache.getAsync('substituteRequests');

            if (!cacheResponse) {
                yield updateSubstituteRequestsMessage();
                cacheResponse = yield cache.getAsync('substituteRequests');
            }

            return JSON.parse(cacheResponse);
        });
    }

    /**
     * @async
     */
    function attemptSubstitution(requestID) {
        return co(function*() {
            if (!currentSubstituteRequests.has(requestID)) {
                return;
            }

            let request = currentSubstituteRequests.get(requestID);

            if (request.timeout) {
                clearTimeout(request.timeout);
                request.timeout = null;
            }

            let game = yield database.Game.findById(self.getDocumentID(request.game));

            if (!game || game.status === 'completed' || game.status === 'aborted') {
                yield self.removeSubstituteRequest(requestID);
                return;
            }

            let gameUserInfo = self.getGameUserInfo(game, request.player);

            if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
                yield self.removeSubstituteRequest(requestID);
                return;
            }

            if (request.candidates.size === 0) {
                return;
            }

            let candidates = _.toArray(request.candidates);
            let selectedCandidate;

            if (SUBSTITUTE_SELECTION_METHOD === 'first') {
                selectedCandidate = _.head(candidates);
            }
            else if (SUBSTITUTE_SELECTION_METHOD === 'closest') {
                let player = yield database.User.findById(self.getDocumentID(request.player)).exec();
                /* eslint-disable lodash/prefer-lodash-method */
                let candidatePlayers = yield database.User.find({
                    '_id': {
                        $in: candidates
                    }
                }).exec();
                /* eslint-enable lodash/prefer-lodash-method */

                selectedCandidate = _(candidatePlayers).sortBy(function(candidate) {
                    return Math.abs(candidate.stats.rating.mean - player.stats.rating.mean);
                }).map(candidate => self.getDocumentID(candidate)).head();
            }
            else if (SUBSTITUTE_SELECTION_METHOD === 'random') {
                selectedCandidate = chance.pick(candidates);
            }

            try {
                yield self.performSubstitution(game, request.player, selectedCandidate);
            }
            catch (err) {
                self.postToLog({
                    description: `error in making substitution for game \`${self.getDocumentID(game)}\``,
                    error: err
                });

                self.sendMessage({
                    action: 'failed to complete substitution for game due to internal error'
                });
            }

            yield self.removeSubstituteRequest(requestID);
        });
    }

    /**
     * @async
     */
    function updateSubstituteApplication(requestID, player, active) {
        return co(function*() {
            if (!currentSubstituteRequests.has(requestID)) {
                return;
            }

            let userRestrictions = yield self.getUserRestrictions(player);
            let request = currentSubstituteRequests.get(requestID);

            if (!_.includes(userRestrictions.aspects, 'sub')) {
                if (active) {
                    request.candidates.add(player);
                }
                else {
                    request.candidates.delete(player);
                }
            }

            yield self.updateUserRestrictions(player);

            yield updateSubstituteRequestsMessage();

            if (!request.timeout) {
                yield attemptSubstitution(requestID);
            }
        });
    }

    /**
     * @async
     */
    self.removeGameSubstituteRequests = co.wrap(function* removeGameSubstituteRequests(game) {
        let gameID = self.getDocumentID(game);

        yield _(currentSubstituteRequests.entries()).toArray().filter(request => (self.getDocumentID(request[1].game) === gameID)).map(request => self.removeSubstituteRequest(request[0])).value();
    });

    /**
     * @async
     */
    self.requestSubstitute = co.wrap(function* requestSubstitute(game, player) {
        if (!game || game.status === 'completed' || game.status === 'aborted') {
            return;
        }

        let gameUserInfo = self.getGameUserInfo(game, player);

        if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
            return;
        }

        if (currentSubstituteRequests.has(self.getDocumentID(gameUserInfo.player))) {
            return;
        }

        currentSubstituteRequests.set(self.getDocumentID(gameUserInfo.player), {
            game: self.getDocumentID(game),
            role: gameUserInfo.role.role,
            captain: self.getDocumentID(gameUserInfo.team.captain),
            player: self.getDocumentID(player),
            opened: Date.now(),
            candidates: new Set(),
            timeout: setTimeout(attemptSubstitution, SUBSTITUTE_REQUEST_PERIOD, self.getDocumentID(gameUserInfo.player))
        });

        yield updateSubstituteRequestsMessage();
    });

    /**
     * @async
     */
    self.performSubstitution = co.wrap(function* performSubstitution(game, oldPlayer, newPlayer) {
        if (!game || !oldPlayer || !newPlayer) {
            return;
        }

        let oldPlayerID = self.getDocumentID(oldPlayer);
        let newPlayerID = self.getDocumentID(newPlayer);

        _(game.teams).flatMap('composition').forEach(function(role) {
            let player = _.find(role.players, function(currentPlayer) {
                return !currentPlayer.replaced && oldPlayerID === self.getDocumentID(currentPlayer.user);
            });

            if (player) {
                player.replaced = true;

                role.players.push({
                    user: newPlayerID
                });
            }
        });

        yield game.save();

        yield self.processGameUpdate(game);

        yield self.updateServerPlayers(game, true);
    });

    /**
     * @async
     */
    self.abortGame = co.wrap(function* abortGame(game) {
        if (!game) {
            return;
        }

        if (game.status === 'aborted' || game.status === 'completed') {
            return;
        }

        game.status = 'aborted';

        yield game.save();

        yield self.processGameUpdate(game);
        yield self.removeGameSubstituteRequests(game);

        yield self.shutdownGame(game);
    });

    /**
     * @async
     */
    self.removeSubstituteRequest = co.wrap(function* removeSubstituteRequest(requestID) {
        if (currentSubstituteRequests.has(requestID)) {
            let request = currentSubstituteRequests.get(requestID);

            if (request.timeout) {
                clearTimeout(request.timeout);
            }

            currentSubstituteRequests.delete(requestID);

            yield _(request.candidates).toArray().map(candidate => self.updateUserRestrictions(candidate)).value();

            yield updateSubstituteRequestsMessage();
        }
    });

    /**
     * @async
     */
    self.handleGameServerUpdate = co.wrap(function* handleGameServerUpdate(info) {
        let game = yield database.Game.findById(info.game);

        if (info.status === 'setup') {
            if (game.status !== 'initializing' && game.status !== 'launching') {
                self.postToLog({
                    description: `game \`${self.getDocumentID(game)}\` was ${game.status} but is being reported as set up`
                });

                return;
            }

            game.status = 'launching';

            yield game.save();

            yield self.processGameUpdate(game);
        }
        else if (info.status === 'live') {
            if (game.status === 'aborted' || game.status === 'completed') {
                self.postToLog({
                    description: `game \`${self.getDocumentID(game)}\` was ${game.status} but is being reported as live`
                });

                return;
            }

            game.status = 'live';

            if (info.score) {
                game.score = _.map(game.teams, team => info.score[team.faction]);
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                /* eslint-disable lodash/prefer-lodash-method */
                let gameUsers = _.keyBy(yield database.User.find({
                    '_id': {
                        $in: _.map(self.getGameUsers(game), user => self.getDocumentID(user))
                    }
                }), user => self.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[self.getDocumentID(player.user)];

                            if (user && _.has(info.time, user.steamID)) {
                                player.time = info.time[user.steamID];
                            }
                        }
                    }
                }
            }

            yield game.save();

            yield self.processGameUpdate(game);
        }
        else if (info.status === 'completed') {
            if (game.status === 'aborted' || game.status === 'completed') {
                self.postToLog({
                    description: `game \`${self.getDocumentID(game)}\` was ${game.status} but is being reported as completed`
                });

                return;
            }

            game.status = 'completed';

            if (info.score) {
                game.score = _.map(game.teams, team => info.score[team.faction]);
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                /* eslint-disable lodash/prefer-lodash-method */
                let gameUsers = _.keyBy(yield database.User.find({
                    '_id': {
                        $in: _.map(self.getGameUsers(game), user => self.getDocumentID(user))
                    }
                }), user => self.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[self.getDocumentID(player.user)];

                            if (user && _.has(info.time, user.steamID)) {
                                player.time = info.time[user.steamID];
                            }
                        }
                    }
                }
            }

            yield game.save();

            yield self.processGameUpdate(game);
            setTimeout(self.shutdownGame, POST_GAME_RESET_DELAY, game);
            yield self.removeGameSubstituteRequests(self.getDocumentID(game));

            try {
                yield rateGame(game);

                yield _.map(self.getGameUsers(game), user => self.updatePlayerStats(user));

                yield self.invalidateGamePage(game);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update stats for game \`${self.getDocumentID(game)}\``,
                    error: err
                });
            }
        }
        else if (info.status === 'logavailable') {
            if (info.url) {
                let link = _.find(game.links, ['type', 'logs.tf']);

                if (link) {
                    link.url = info.url;
                }
                else {
                    game.links.push({
                        type: 'logs.tf',
                        url: info.url
                    });
                }

                yield game.save();

                yield self.invalidateGamePage(game);
            }
        }
        else if (info.status === 'demoavailable') {
            if (info.url) {
                let link = _.find(game.links, ['type', 'demos.tf']);

                if (link) {
                    link.url = info.url;
                }
                else {
                    game.links.push({
                        type: 'demos.tf',
                        url: info.url
                    });
                }

                yield game.save();

                yield self.invalidateGamePage(game);
            }
        }
    });

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('substituteRequestsUpdated', yield getSubstituteRequestsMessage());
    }));

    function onUserRequestSubstitute(info) {
        let userID = this.decoded_token.user;

        co(function*() {
            let game = yield database.Game.findById(info.game);

            let playerInfo = self.getGameUserInfo(game, info.player);

            if (userID !== self.getDocumentID(playerInfo.team.captain)) {
                return;
            }

            yield self.requestSubstitute(game, info.player);
        });
    }

    function onUserUpdateSubstituteApplication(info) {
        let userID = this.decoded_token.user;

        co(function*() {
            yield updateSubstituteApplication(info.request, userID, info.status);
        });
    }

    function onUserRetractSubstituteRequest(requestID) {
        let userID = this.decoded_token.user;

        co(function*() {
            if (!currentSubstituteRequests.has(requestID)) {
                return;
            }

            let request = currentSubstituteRequests.get(requestID);
            let game = yield database.Game.findById(request.game);

            let playerInfo = self.getGameUserInfo(game, request.player);

            if (userID === self.getDocumentID(playerInfo.team.captain)) {
                yield self.removeSubstituteRequest(requestID);
            }
            else if (self.isUserAdmin(userID)) {
                let player = yield self.getCachedUser(request.player);

                self.postToAdminLog(userID, `retracted substitute request for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${self.getDocumentID(game)}|${self.getDocumentID(game)}>\``);

                yield self.removeSubstituteRequest(requestID);
            }
        });
    }

    io.sockets.on('authenticated', co.wrap(function*(socket) {
        let userID = socket.decoded_token.user;

        socket.emit('currentGameUpdated', yield getCurrentGame(userID));

        socket.removeAllListeners('requestSubstitute');
        socket.on('requestSubstitute', onUserRequestSubstitute);

        socket.removeAllListeners('updateSubstituteApplication');
        socket.on('updateSubstituteApplication', onUserUpdateSubstituteApplication);

        socket.removeAllListeners('retractSubstituteRequest');
        socket.on('retractSubstituteRequest', onUserRetractSubstituteRequest);
    }));

    self.on('userRestrictionsUpdated', co.wrap(function*(userID) {
        let userRestrictions = yield self.getUserRestrictions(userID);

        if (_.includes(userRestrictions.aspects, 'sub')) {
            for (let request of currentSubstituteRequests.values()) {
                request.candidates.delete(userID);
            }
        }

        yield updateSubstituteRequestsMessage();
    }));

    hbs.registerHelper('ratingChange', function(change) {
        if (change > 0) {
            return new hbs.handlebars.SafeString(`<span class="rating-increase"><iron-icon icon="arrow-upward"></iron-icon> ${math.round(+change)}</span>`);
        }
        else if (change < 0) {
            return new hbs.handlebars.SafeString(`<span class="rating-decrease"><iron-icon icon="arrow-downward"></iron-icon> ${math.round(-change)}</span>`);
        }
        else if (change === 0) {
            return new hbs.handlebars.SafeString('<span class="rating-no-change"><iron-icon icon="compare-arrows"></iron-icon> 0</span>');
        }
    });
    hbs.registerHelper('gameDuration', function(duration) {
        return moment.duration(duration, 'seconds').format('m:ss', {
            trim: false
        });
    });

    /**
     * @async
     */
    self.invalidateGamePage = co.wrap(function* invalidateGamePage(game) {
        yield cache.delAsync(`gamePage-${self.getDocumentID(game)}`);
    });

    /**
     * @async
     */
    self.invalidateUserGamePages = co.wrap(function* invalidateUserGamePages(user) {
        let userID = self.getDocumentID(user);

        /* eslint-disable lodash/prefer-lodash-method */
        let games = yield database.Game.find({
            $or: [{
                'teams.captain': userID
            }, {
                'teams.composition.players': {
                    $elemMatch: {
                        user: userID
                    }
                }
            }]
        }).exec();
        /* eslint-enable lodash/prefer-lodash-method */

        yield _.map(games, game => self.invalidateGamePage(game));
    });

    /**
     * @async
     */
    self.getGamePage = co.wrap(function* getGamePage(game) {
        let cacheResponse = yield cache.getAsync(`gamePage-${self.getDocumentID(game)}`);

        let gamePage;

        if (cacheResponse) {
            gamePage = JSON.parse(cacheResponse);
        }
        else {
            game = yield database.Game.findById(self.getDocumentID(game));

            if (!game) {
                return null;
            }

            gamePage = {
                game: game.toObject()
            };

            let gameUsers = _.keyBy(yield _.map(self.getGameUsers(game), user => self.getCachedUser(user)), user => self.getDocumentID(user));

            /* eslint-disable lodash/prefer-lodash-method */
            let ratings = HIDE_RATINGS ? {} : _.keyBy(yield database.Rating.find({
                game: self.getDocumentID(game)
            }).exec(), rating => self.getDocumentID(rating.user));
            /* eslint-enable lodash/prefer-lodash-method */

            _.forEach(gamePage.game.teams, function(team) {
                team.captain = gameUsers[self.getDocumentID(team.captain)];

                team.composition = _.sortBy(team.composition, function(role) {
                    return _(ROLES).keys().indexOf(role.role);
                });

                _.forEach(team.composition, function(role) {
                    role.role = _.assign({
                        id: role.role
                    }, ROLES[role.role]);

                    _.forEach(role.players, function(player) {
                        player.user = gameUsers[self.getDocumentID(player.user)];

                        if (!HIDE_RATINGS) {
                            let rating = ratings[self.getDocumentID(player.user)];

                            if (rating) {
                                player.rating = {
                                    rating: rating.after.mean,
                                    deviation: rating.after.deviation,
                                    change: rating.after.mean - rating.before.mean
                                };
                            }
                        }
                    });
                });
            });

            yield cache.setAsync(`gamePage-${self.getDocumentID(game)}`, JSON.stringify(gamePage));
        }

        return gamePage;
    });

    app.get('/game/:id', co.wrap(function*(req, res) {
        let gamePage = yield self.getGamePage(req.params.id);

        if (gamePage) {
            res.render('game', gamePage);
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    }));

    app.get('/games/all', co.wrap(function*(req, res) {
        res.render('fullGamesList', {
            games: yield getGameList(true, self.isUserAdmin(req.user))
        });
    }));

    app.get('/games', co.wrap(function*(req, res) {
        res.render('recentGamesList', {
            games: yield getGameList(false, self.isUserAdmin(req.user))
        });
    }));

    co(function*() {
        yield updateSubstituteRequestsMessage();

        fs.writeFileSync(path.resolve(__dirname, '../ratings/settings.cfg'), `[config]\nconnect: ${MONGODB_URL}\ndb: ${database.Rating.db.name}\nratingBase: ${RATING_BASE}\n`);
    });
};
