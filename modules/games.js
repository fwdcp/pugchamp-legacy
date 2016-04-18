'use strict';

const _ = require('lodash');
const child_process = require('mz/child_process');
const co = require('co');
const config = require('config');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const math = require('mathjs');
const moment = require('moment');
const ms = require('ms');
const path = require('path');

require('moment-duration-format');

module.exports = function(app, cache, chance, database, io, self) {
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const POST_GAME_RESET_DELAY = ms(config.get('app.games.postGameResetDelay'));
    const ROLES = config.get('app.games.roles');
    const SUBSTITUTE_REQUEST_PERIOD = ms(config.get('app.games.substituteRequestPeriod'));
    const SUBSTITUTE_SELECTION_METHOD = config.get('app.games.substituteSelectionMethod');
    const UPDATE_GAME_CACHE_DEBOUNCE_MAX_WAIT = 5000;
    const UPDATE_GAME_CACHE_DEBOUNCE_WAIT = 1000;

    var fullGameListCache;
    var fullFilteredGameListCache;
    var recentGameListCache;
    var recentFilteredGameListCache;

    var updateGameCache = _.debounce(co.wrap(function* updateGameCache() {
        let games = yield database.Game.find({}).sort('-date').select('date status teams.faction teams.captain score map duration').populate('teams.captain', 'alias steamID').exec();

        fullGameListCache = _.map(games, game => game.toObject());
        fullFilteredGameListCache = _.filter(fullGameListCache, game => game.status !== 'initializing' && game.status !== 'aborted');
        recentGameListCache = _.takeWhile(fullGameListCache, game => moment().diff(game.date, 'days') < 1);
        recentFilteredGameListCache = _.takeWhile(fullFilteredGameListCache, game => moment().diff(game.date, 'days') < 1);
    }), UPDATE_GAME_CACHE_DEBOUNCE_WAIT, {
        maxWait: UPDATE_GAME_CACHE_DEBOUNCE_MAX_WAIT
    });

    self.on('gameUpdated', function() {
        updateGameCache();
    });

    function rateGame(game) {
        return co(function*() {
            yield child_process.exec(`python rate_game.py ${game.id}`, {
                cwd: path.resolve(__dirname, '../ratings')
            });
        });
    }

    function getCurrentGame(user) {
        return co(function*() {
            let cacheResponse = yield cache.getAsync(`currentGame-${self.getDocumentID(user)}`);

            return cacheResponse;
        });
    }

    function updateCurrentGame(game, user) {
        return co(function*() {
            if (game.status === 'launching' || game.status === 'live') {
                // TODO: format and save to cache
            }
            else {
                yield cache.delAsync(`currentGame-${self.getDocumentID(user)}`);
            }
        });
    }

    self.processGameUpdate = co.wrap(function*(game) {
        let gameID = self.getDocumentID(game);
        game = yield database.Game.findById(gameID);

        if (game.status !== 'initializing') {
            if (self.getDocumentID(game) === self.getCurrentDraftGame()) {
                self.cleanUpDraft();
            }
        }

        for (let team in game.teams) {
            yield updateCurrentGame(game, team.captain);
            self.emitToUser(team.captain, 'currentGameUpdated', [yield getCurrentGame(team.captain)]);
            self.updateUserRestrictions(team.captain);

            for (let role in team.composition) {
                for (let player in role.players) {
                    yield updateCurrentGame(game, player.user);
                    self.emitToUser(player.user, 'currentGameUpdated', [yield getCurrentGame(player.user)]);
                    self.updateUserRestrictions(player.user);
                }
            }
        }
    });

    var currentSubstituteRequests = new Map();
    var currentSubstituteRequestsInfo;

    self.getCurrentSubstituteRequests = function getCurrentSubstituteRequests() {
        return [...currentSubstituteRequests.values()];
    };

    function updateSubstituteRequestsInfo() {
        // TODO: update for caching
        // currentSubstituteRequestsInfo = {
        //     roles: ROLES,
        //     requests: _([...currentSubstituteRequests.entries()]).fromPairs().map((request, id) => ({
        //         id,
        //         game: request.game,
        //         role: request.role,
        //         captain: request.captain,
        //         player: self.getCachedUser(request.player),
        //         candidates: [...request.candidates]
        //     })).value()
        // };
    }

    function getCurrentSubstituteRequestsMessage() {
        let message = _.clone(currentSubstituteRequestsInfo);

        message.requests = _.map(message.requests, function(request) {
            let requestMessage = {
                timeElapsed: Date.now() - currentSubstituteRequests.get(request.id).opened,
                timeTotal: SUBSTITUTE_REQUEST_PERIOD
            };

            _.assign(requestMessage, request);

            return requestMessage;
        });

        return message;
    }

    updateSubstituteRequestsInfo();

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

    function attemptSubstitution(id) {
        return co(function*() {
            if (!currentSubstituteRequests.has(id)) {
                return;
            }

            let request = currentSubstituteRequests.get(id);

            request.timeout = null;

            let game = yield database.Game.findById(request.game);

            if (!game || game.status === 'completed' || game.status === 'aborted') {
                self.removeSubstituteRequest(id);
                return;
            }

            let gamePlayerInfo = self.getGameUserInfo(game, request.player);

            if (!gamePlayerInfo || !gamePlayerInfo.player || gamePlayerInfo.player.replaced) {
                self.removeSubstituteRequest(id);
                return;
            }

            if (request.candidates.size === 0) {
                return;
            }

            let candidates = [...request.candidates];
            let selectedCandidate;

            if (SUBSTITUTE_SELECTION_METHOD === 'first') {
                selectedCandidate = _.head(candidates);
            }
            else if (SUBSTITUTE_SELECTION_METHOD === 'closest') {
                let player = yield database.User.findById(request.player).exec();
                let candidatePlayers = yield database.User.find({
                    _id: {
                        $in: [...request.candidates]
                    }
                }).exec();

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
                    description: `error in making substitution for game \`${game.id}\``,
                    error: err
                });

                self.sendMessage({
                    action: 'failed to complete substitution for game due to internal error'
                });
            }

            self.removeSubstituteRequest(id);
        });
    }

    function updateSubstituteApplication(requestID, player, active) {
        if (!currentSubstituteRequests.has(requestID)) {
            return;
        }

        let userRestrictions = self.getUserRestrictions(player);
        let request = currentSubstituteRequests.get(requestID);

        if (!_.includes(userRestrictions.aspects, 'sub')) {
            if (active) {
                request.candidates.add(player);
            }
            else {
                request.candidates.delete(player);
            }
        }

        self.updateUserRestrictions(player);

        updateSubstituteRequestsInfo();
        io.sockets.emit('substituteRequestsUpdated', getCurrentSubstituteRequestsMessage());

        if (!request.timeout) {
            attemptSubstitution(request);
        }
    }

    self.removeGameSubstituteRequests = function removeGameSubstituteRequests(game) {
        let gameID = self.getDocumentID(game);

        for (let requestID of currentSubstituteRequests.keys()) {
            let request = currentSubstituteRequests.get(requestID);

            if (self.getDocumentID(request.game) === gameID) {
                self.removeSubstituteRequest(requestID);
            }
        }
    };

    self.requestSubstitute = function requestSubstitute(game, player) {
        if (!game || game.status === 'completed' || game.status === 'aborted') {
            return;
        }

        let gamePlayerInfo = self.getGameUserInfo(game, player);

        if (!gamePlayerInfo || !gamePlayerInfo.player || gamePlayerInfo.player.replaced) {
            return;
        }

        if (currentSubstituteRequests.has(gamePlayerInfo.player.id)) {
            return;
        }

        currentSubstituteRequests.set(self.getDocumentID(gamePlayerInfo.player), {
            game: self.getDocumentID(game),
            role: gamePlayerInfo.role.role,
            captain: self.getDocumentID(gamePlayerInfo.team.captain),
            player: playerID,
            opened: Date.now(),
            candidates: new Set(),
            timeout: setTimeout(attemptSubstitution, SUBSTITUTE_REQUEST_PERIOD, self.getDocumentID(gamePlayerInfo.player))
        });

        updateSubstituteRequestsInfo();
        io.sockets.emit('substituteRequestsUpdated', getCurrentSubstituteRequestsMessage());
    };

    self.performSubstitution = co.wrap(function* performSubstitution(game, oldPlayer, newPlayer) {
        if (!game || !oldPlayer || !newPlayer) {
            return;
        }

        let oldPlayerID = self.getDocumentID(oldPlayer);
        let newPlayerID = self.getDocumentID(newPlayer);

        _(game.teams).map(team => team.composition).flatten().forEach(function(role) {
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

        yield self.updateServerPlayers(game);
    });

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

        self.removeGameSubstituteRequests(game.id);
        self.updateLaunchStatus();

        yield self.shutdownGame(game);
    });

    self.removeSubstituteRequest = function removeSubstituteRequest(id) {
        if (currentSubstituteRequests.has(id)) {
            let request = currentSubstituteRequests.get(id);

            if (request.timeout) {
                clearTimeout(request.timeout);
            }

            for (let candidate of request.candidates) {
                self.updateUserRestrictions(candidate);
            }

            currentSubstituteRequests.delete(id);

            updateSubstituteRequestsInfo();
            io.sockets.emit('substituteRequestsUpdated', getCurrentSubstituteRequestsMessage());
        }
    };

    self.handleGameServerUpdate = co.wrap(function* handleGameServerUpdate(info) {
        let game = yield database.Game.findById(info.game);

        if (info.status === 'setup') {
            if (game.status !== 'initializing' && game.status !== 'launching') {
                self.postToLog({
                    description: `game \`${game.id}\` was ${game.status} but is being reported as set up`
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
                    description: `game \`${game.id}\` was ${game.status} but is being reported as live`
                });

                return;
            }

            game.status = 'live';

            if (info.score) {
                game.score = _.map(game.teams, function(team) {
                    return info.score[team.faction];
                });
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                for (let team in game.teams) {
                    for (let role in team.composition) {
                        for (let player in role.players) {
                            let userID = self.getDocumentID(player.user);
                            let user = yield database.User.findById(userID);

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
                    description: `game \`${game.id}\` was ${game.status} but is being reported as completed`
                });

                return;
            }

            game.status = 'completed';

            if (info.score) {
                game.score = _.map(game.teams, function(team) {
                    return info.score[team.faction];
                });
            }

            if (info.duration) {
                game.duration = info.duration;
            }

            if (info.time) {
                for (let team in game.teams) {
                    for (let role in team.composition) {
                        for (let player in role.players) {
                            let userID = self.getDocumentID(player.user);
                            let user = yield database.User.findById(userID);

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
            self.removeGameSubstituteRequests(game.id);
            self.updateLaunchStatus();

            try {
                yield rateGame(game);

                yield _(game.teams).map(function(team) {
                    return _.map(team.composition, function(role) {
                        return _.map(role.players, player => player.user);
                    });
                }).flattenDeep().map(user => self.updatePlayerStats(user)).value();
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update stats for game \`${game.id}\``,
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
            }
        }
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('substituteRequestsUpdated', getCurrentSubstituteRequestsMessage());
    });

    function onUserRequestSubstitute(info) {
        let userID = this.decoded_token.user;

        return co(function*() {
            let game = yield database.Game.findById(info.game);

            let playerInfo = self.getGameUserInfo(game, info.player);

            if (userID !== self.getDocumentID(playerInfo.team.captain)) {
                return;
            }

            self.requestSubstitute(game, info.player);
        });
    }

    function onUserUpdateSubstituteApplication(info) {
        let userID = this.decoded_token.user;

        updateSubstituteApplication(info.request, userID, info.status);
    }

    function onUserRetractSubstituteRequest(requestID) {
        let userID = this.decoded_token.user;

        return co(function*() {
            if (!currentSubstituteRequests.has(requestID)) {
                return;
            }

            let request = currentSubstituteRequests.get(requestID);
            let game = yield database.Game.findById(request.game);

            let playerInfo = self.getGameUserInfo(game, request.player);

            if (userID !== self.getDocumentID(playerInfo.team.captain)) {
                return;
            }

            self.removeSubstituteRequest(requestID);
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

    self.on('userRestrictionsUpdated', function(userID) {
        let userRestrictions = self.getUserRestrictions(userID);

        if (_.includes(userRestrictions.aspects, 'sub')) {
            for (let request of currentSubstituteRequests) {
                request.candidates.delete(userID);
            }
        }

        updateSubstituteRequestsInfo();
        io.sockets.emit('substituteRequestsUpdated', getCurrentSubstituteRequestsMessage());
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
        return moment.duration(duration, 'seconds').format('m:ss', {trim: false});
    });

    app.get('/game/:id', co.wrap(function*(req, res) {
        // TODO: update for caching
        // let game = yield database.Game.findById(req.params.id).exec();
        //
        // if (!game) {
        //     res.sendStatus(HttpStatus.NOT_FOUND);
        //     return;
        // }
        //
        // game = game.toObject();
        //
        // let ratings = {};
        //
        // if (!HIDE_RATINGS) {
        //     ratings = _.keyBy(yield database.Rating.find({
        //         game: game.id
        //     }).exec(), rating => self.getDocumentID(rating.user));
        // }
        //
        // _.each(game.teams, function(team) {
        //     team.captain = self.getCachedUser(team.captain);
        //
        //     team.composition = _.sortBy(team.composition, function(role) {
        //         return _(ROLES).keys().indexOf(role.role);
        //     });
        //
        //     _.each(team.composition, function(role) {
        //         role.role = _.assign({
        //             id: role.role
        //         }, ROLES[role.role]);
        //
        //         _.each(role.players, function(player) {
        //             player.user = self.getCachedUser(player.user);
        //
        //             if (!HIDE_RATINGS) {
        //                 let rating = ratings[self.getDocumentID(player.user)];
        //
        //                 if (rating) {
        //                     player.rating = {
        //                         rating: rating.after.mean,
        //                         deviation: rating.after.deviation,
        //                         change: rating.after.mean - rating.before.mean
        //                     };
        //                 }
        //             }
        //         });
        //     });
        // });
        //
        // res.render('game', {
        //     game
        // });
    }));

    app.get('/games/all', function(req, res) {
        res.render('fullGamesList', {
            games: !req.user || !req.user.admin ? fullFilteredGameListCache : fullGameListCache
        });
    });

    app.get('/games', function(req, res) {
        res.render('recentGamesList', {
            games: !req.user || !req.user.admin ? recentFilteredGameListCache : recentGameListCache
        });
    });

    updateGameCache();
};
