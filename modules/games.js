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

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const MONGODB_URL = config.get('server.mongodb');
    const POST_GAME_RESET_DELAY = ms(config.get('app.games.postGameResetDelay'));
    const RATING_BASE = config.get('app.users.ratingBase');
    const ROLES = config.get('app.games.roles');
    const SUBSTITUTE_REQUEST_PERIOD = ms(config.get('app.games.substituteRequestPeriod'));
    const SUBSTITUTE_SELECTION_METHOD = config.get('app.games.substituteSelectionMethod');

    /**
     * @async
     */
    self.updateGameCache = co.wrap(function* updateGameCache(...games) {
        yield helpers.runAppScript('updateGameCache', _.map(games, game => helpers.getDocumentID(game)));
    });

    /**
     * @async
     */
    function rateGame(game) {
        return co(function*() {
            yield child_process.exec(`python rate_game.py ${helpers.getDocumentID(game)}`, {
                cwd: path.resolve(__dirname, '../ratings')
            });
        });
    }

    /**
     * @async
     */
    function updateCurrentGame(users) {
        return co(function*() {
            yield helpers.runAppScript('updateCurrentGame', _.map(users, user => helpers.getDocumentID(user)));

            let cachedCurrentGames = _.zipObject(_.map(users, user => helpers.getDocumentID(user)), yield cache.mgetAsync(_.map(users, user => `currentGame-${helpers.getDocumentID(user)}`)));

            _.forEach(cachedCurrentGames, function(cacheResponse, userID) {
                self.emitToUser(userID, 'currentGameUpdated', _.isNil(cacheResponse) ? null : JSON.parse(cacheResponse));
            });
        });
    }

    /**
     * @async
     */
    function getCurrentGame(user) {
        return co(function*() {
            let cacheResponse = yield cache.getAsync(`currentGame-${helpers.getDocumentID(user)}`);

            return _.isNil(cacheResponse) ? null : JSON.parse(cacheResponse);
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

            if (!(yield cache.existsAsync(keyName))) {
                yield self.updateGameCache();
            }

            return JSON.parse(yield cache.getAsync(keyName));
        });
    }

    /**
     * @async
     */
    self.processGameUpdate = co.wrap(function* processGameUpdate(game) {
        let gameID = helpers.getDocumentID(game);
        game = yield database.Game.findById(gameID);

        if (game.status !== 'initializing') {
            if (helpers.getDocumentID(game) === self.getCurrentDraftGame()) {
                yield self.cleanUpDraft();
            }
        }

        yield self.updateUserRestrictions(...helpers.getGameUsers(game));
        yield updateCurrentGame(helpers.getGameUsers(game));

        self.updateGameCache(game);
        self.updateUserCache(...helpers.getGameUsers(game));
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

            let outgoingPlayers = _.keyBy(yield self.getCachedUsers(_(currentSubstituteRequests.values()).toArray().map('player').value()), user => helpers.getDocumentID(user));

            for (let request of currentSubstituteRequests.entries()) {
                substituteRequestsMessage.requests.push({
                    id: request[0],
                    game: request[1].game,
                    role: ROLES[request[1].role],
                    captain: helpers.getDocumentID(request[1].captain),
                    player: outgoingPlayers[helpers.getDocumentID(request[1].player)],
                    candidates: _.toArray(request[1].candidates),
                    startTime: request[1].opened,
                    endTime: request[1].opened + SUBSTITUTE_REQUEST_PERIOD
                });
            }

            yield cache.setAsync('substituteRequests', JSON.stringify(substituteRequestsMessage));

            io.sockets.emit('substituteRequestsUpdated', substituteRequestsMessage);
        });
    }

    /**
     * @async
     */
    function getSubstituteRequestsMessage() {
        return co(function*() {
            if (!(yield cache.existsAsync('substituteRequests'))) {
                yield updateSubstituteRequestsMessage();
            }

            return JSON.parse(yield cache.getAsync('substituteRequests'));
        });
    }

    /**
     * @async
     */
    self.processSubstituteRequestsUpdate = _.debounce(co.wrap(function* processSubstituteRequestsUpdate() {
        yield updateSubstituteRequestsMessage();
    }));

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

            let game = yield database.Game.findById(helpers.getDocumentID(request.game));

            if (!game || game.status === 'completed' || game.status === 'aborted') {
                self.removeSubstituteRequest(requestID);
                return;
            }

            let gameUserInfo = helpers.getGameUserInfo(game, request.player);

            if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
                self.removeSubstituteRequest(requestID);
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
                let player = yield database.User.findById(helpers.getDocumentID(request.player)).exec();
                /* eslint-disable lodash/prefer-lodash-method */
                let candidatePlayers = yield database.User.find({
                    '_id': {
                        $in: candidates
                    }
                }).exec();
                /* eslint-enable lodash/prefer-lodash-method */

                selectedCandidate = _(candidatePlayers).sortBy(function(candidate) {
                    return Math.abs(candidate.stats.rating.mean - player.stats.rating.mean);
                }).map(candidate => helpers.getDocumentID(candidate)).head();
            }
            else if (SUBSTITUTE_SELECTION_METHOD === 'random') {
                selectedCandidate = chance.pick(candidates);
            }

            try {
                yield self.performSubstitution(game, request.player, selectedCandidate);
            }
            catch (err) {
                self.postToLog({
                    description: `error in making substitution for game \`${helpers.getDocumentID(game)}\``,
                    error: err
                });

                self.sendMessage({
                    action: 'failed to complete substitution for game due to internal error'
                });
            }

            self.removeSubstituteRequest(requestID);
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

            self.processSubstituteRequestsUpdate();

            if (!request.timeout) {
                yield attemptSubstitution(requestID);
            }
        });
    }

    /**
     * @async
     */
    self.removeGameSubstituteRequests = function removeGameSubstituteRequests(game) {
        let gameID = helpers.getDocumentID(game);

        _(currentSubstituteRequests.entries()).toArray().filter(request => (helpers.getDocumentID(request[1].game) === gameID)).forEach(function(request) {
            self.removeSubstituteRequest(request[0]);
        });
    };

    /**
     * @async
     */
    self.requestSubstitute = function requestSubstitute(game, player) {
        if (!game || game.status === 'completed' || game.status === 'aborted') {
            return;
        }

        let gameUserInfo = helpers.getGameUserInfo(game, player);

        if (!gameUserInfo || !gameUserInfo.player || gameUserInfo.player.replaced) {
            return;
        }

        if (currentSubstituteRequests.has(helpers.getDocumentID(gameUserInfo.player))) {
            return;
        }

        currentSubstituteRequests.set(helpers.getDocumentID(gameUserInfo.player), {
            game: helpers.getDocumentID(game),
            role: gameUserInfo.role.role,
            captain: helpers.getDocumentID(gameUserInfo.team.captain),
            player: helpers.getDocumentID(player),
            opened: Date.now(),
            candidates: new Set(),
            timeout: setTimeout(attemptSubstitution, SUBSTITUTE_REQUEST_PERIOD, helpers.getDocumentID(gameUserInfo.player))
        });

        self.processSubstituteRequestsUpdate();
    };

    /**
     * @async
     */
    self.performSubstitution = co.wrap(function* performSubstitution(game, oldPlayer, newPlayer) {
        if (!game || !oldPlayer || !newPlayer) {
            return;
        }

        let oldPlayerID = helpers.getDocumentID(oldPlayer);
        let newPlayerID = helpers.getDocumentID(newPlayer);

        _(game.teams).flatMap('composition').forEach(function(role) {
            let player = _.find(role.players, function(currentPlayer) {
                return !currentPlayer.replaced && oldPlayerID === helpers.getDocumentID(currentPlayer.user);
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

        yield self.updateServerPlayers(game);
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
        self.removeGameSubstituteRequests(game);

        yield self.shutdownGameServers(game);
    });

    /**
     * @async
     */
    self.removeSubstituteRequest = function removeSubstituteRequest(requestID) {
        if (currentSubstituteRequests.has(requestID)) {
            let request = currentSubstituteRequests.get(requestID);

            if (request.timeout) {
                clearTimeout(request.timeout);
            }

            currentSubstituteRequests.delete(requestID);

            self.processSubstituteRequestsUpdate();
        }
    };

    /**
     * @async
     */
    self.handleGameServerUpdate = co.wrap(function* handleGameServerUpdate(info) {
        let game = yield database.Game.findById(info.game);

        if (info.status === 'setup') {
            if (game.status !== 'initializing' && game.status !== 'launching') {
                self.postToLog({
                    description: `game \`${helpers.getDocumentID(game)}\` was ${game.status} but is being reported as set up`
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
                    description: `game \`${helpers.getDocumentID(game)}\` was ${game.status} but is being reported as live`
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
                        $in: helpers.getGameUsers(game)
                    }
                }), user => helpers.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[helpers.getDocumentID(player.user)];

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
            if (game.status === 'aborted') {
                self.postToLog({
                    description: `game \`${helpers.getDocumentID(game)}\` was ${game.status} but is being reported as completed`
                });

                return;
            }
            else if (game.status === 'completed') {
                // NOTE: being completed is fine, we just don't want to rerun the completion functions again since we already have data

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
                        $in: helpers.getGameUsers(game)
                    }
                }), user => helpers.getDocumentID(user));
                /* eslint-enable lodash/prefer-lodash-method */

                for (let team of game.teams) {
                    for (let role of team.composition) {
                        for (let player of role.players) {
                            let user = gameUsers[helpers.getDocumentID(player.user)];

                            if (user && _.has(info.time, user.steamID)) {
                                player.time = info.time[user.steamID];
                            }
                        }
                    }
                }
            }

            yield game.save();

            yield self.processGameUpdate(game);
            self.removeGameSubstituteRequests(game);
            setTimeout(self.shutdownGameServers, POST_GAME_RESET_DELAY, game);

            try {
                yield rateGame(game);

                yield self.updatePlayerStats(...helpers.getGameUsers(game));

                yield self.updateGameCache(game);
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update stats for game \`${helpers.getDocumentID(game)}\``,
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

                yield self.updateGameCache(game);
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

                yield self.updateGameCache(game);
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

            let playerInfo = helpers.getGameUserInfo(game, info.player);

            if (userID !== helpers.getDocumentID(playerInfo.team.captain)) {
                return;
            }

            let player = yield self.getCachedUser(info.player);
            let captain = yield self.getCachedUser(userID);

            self.postToLog({
                description: `\`<${BASE_URL}/player/${captain.steamID}|${captain.alias}>\` requested substitute for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``
            });

            self.requestSubstitute(game, info.player);
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

            let playerInfo = helpers.getGameUserInfo(game, request.player);

            let player = yield self.getCachedUser(request.player);

            if (userID === helpers.getDocumentID(playerInfo.team.captain)) {
                let captain = yield self.getCachedUser(userID);

                self.postToLog({
                    description: `\`<${BASE_URL}/player/${captain.steamID}|${captain.alias}>\` retracted substitute request for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``
                });

                self.removeSubstituteRequest(requestID);
            }
            else if (self.isUserAdmin(userID)) {
                self.postToAdminLog(userID, `retracted substitute request for player \`<${BASE_URL}/player/${player.steamID}|${player.alias}>\` for game \`<${BASE_URL}/game/${helpers.getDocumentID(game)}|${helpers.getDocumentID(game)}>\``);

                self.removeSubstituteRequest(requestID);
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

    self.on('userRestrictionsUpdated', function(userID, userRestrictions) {
        if (_.includes(userRestrictions.aspects, 'sub')) {
            for (let request of currentSubstituteRequests.values()) {
                request.candidates.delete(userID);
            }
        }

        self.processSubstituteRequestsUpdate();
    });

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
    self.updateUserGames = co.wrap(function* updateUserGames(user) {
        let userID = helpers.getDocumentID(user);

        /* eslint-disable lodash/prefer-lodash-method */
        let games = yield database.Game.find({
            $or: [{
                'teams.captain': userID
            }, {
                'teams.composition.players.user': userID
            }]
        }).exec();
        /* eslint-enable lodash/prefer-lodash-method */

        yield self.updateGameCache(...games);
    });

    /**
     * @async
     */
    self.getGamePage = co.wrap(function* getGamePage(game) {
        if (!(yield cache.existsAsync(`gamePage-${helpers.getDocumentID(game)}`))) {
            yield self.updateGameCache(game);
        }

        return JSON.parse(yield cache.getAsync(`gamePage-${helpers.getDocumentID(game)}`));
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

    self.processSubstituteRequestsUpdate();

    fs.writeFileSync(path.resolve(__dirname, '../ratings/settings.cfg'), `[config]\nconnect: ${MONGODB_URL}\ndb: ${database.Rating.db.name}\nratingBase: ${RATING_BASE}\n`);
};
