/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const Chance = require('chance');
const child_process = require('child_process');
const config = require('config');
const lodash = require('lodash');
const ms = require('ms');
const path = require('path');
const wilson = require('wilson-interval');

var chance = new Chance();

module.exports = function(app, database, io, self, server) {
    var roles = config.get('app.games.roles');

    function timeoutGame(game) {
        database.Game.findById(game.id, function(err, updatedGame) {
            if (updatedGame.status === 'assigning' || updatedGame.status === 'launching') {
                self.emit('abortGame', updatedGame);
            }
        });
    }

    function rateGame(game) {
        Promise.all([
            new Promise(function(resolve, reject) {
                child_process.exec('python rate_game.py ' + game.id, {
                    cwd: path.resolve(__dirname, '../ratings')
                }, function(error) {
                    if (!error) {
                        resolve();
                    }
                    else {
                        reject(error);
                    }
                });
            }),
            game.populate('teams.captain').execPopulate().then(function(game) {
                return Promise.all(lodash.map(game.teams, function(team) {
                    let user = team.captain;

                    return database.Game.find({
                        'teams.captain': user.id,
                        'status': 'completed'
                    }).exec().then(function(captainGames) {
                        let captainStats = lodash.reduce(captainGames, function(stats, game) {
                            stats.total++;

                            if (user._id.equals(game.teams[0].captain)) {
                                if (game.score[0] > game.score[1]) {
                                    stats.wins++;
                                }
                                else if (game.score[0] < game.score[1]) {
                                    stats.losses++;
                                }
                                else if (game.score[0] === game.score[1]) {
                                    stats.ties++;
                                }
                            }
                            else if (user._id.equals(game.teams[1].captain)) {
                                if (game.score[1] > game.score[0]) {
                                    stats.wins++;
                                }
                                else if (game.score[1] < game.score[0]) {
                                    stats.losses++;
                                }
                                else if (game.score[1] === game.score[0]) {
                                    stats.ties++;
                                }
                            }

                            return stats;
                        }, {
                            total: 0,
                            wins: 0,
                            losses: 0,
                            ties: 0
                        });

                        if (captainStats.total > 0) {
                            user.captainScore = wilson(captainStats.wins + captainStats.ties, captainStats.total);
                        }

                        return user.save();
                    });
                }));
            })
        ]).catch(function(err) {
            throw err;
        });
    }

    function formatGameInfo(game) {
        if (!game) {
            return Promise.resolve(null);
        }

        return game.populate('teams.captain teams.composition.players.user').execPopulate().then(function(game) {
            if (game.status === 'aborted' || game.status === 'completed') {
                return null;
            }
            else {
                let gameInfo = lodash.omit(game.toObject(), 'draft');

                gameInfo.roles = config.get('app.games.roles');

                return gameInfo;
            }
        });
    }

    var substituteRequestPeriod = ms(config.get('app.games.substituteRequestPeriod'));
    var substituteSelectionMethod = config.get('app.games.substituteSelectionMethod');
    var currentSubstituteRequests = new Map();

    var currentSubstituteRequestsMessage;

    function formatSubstituteRequests() {
        return Promise.all([
            database.Game.find({
                _id: {
                    $in: lodash.map([...currentSubstituteRequests.values()], request => request.game)
                }
            }).populate('teams.captain teams.composition.players.user').exec().then(function(games) {
                return lodash.keyBy(games, 'id');
            }),
            database.User.find({
                _id: {
                    $in: lodash.map([...currentSubstituteRequests.values()], request => request.player)
                }
            }).exec().then(function(users) {
                return lodash.keyBy(users, 'id');
            })
        ]).then(function(results) {
            let games = results[0];
            let players = results[1];

            currentSubstituteRequestsMessage = {
                roles: roles,
                requests: lodash([...currentSubstituteRequests.entries()]).fromPairs().mapValues(request => ({
                    game: request.game,
                    captain: games[request.game].teams[request.team].captain.toObject(),
                    faction: games[request.game].teams[request.team].faction,
                    role: request.role,
                    player: players[request.player].toObject(),
                    candidates: [...request.candidates],
                    start: request.start,
                    end: request.end
                }))
            };

            return currentSubstituteRequestsMessage;
        });
    }

    formatSubstituteRequests().then(function() {
        io.sockets.emit('substituteRequestsUpdated', currentSubstituteRequestsMessage);
    });

    function attemptSubstitution(id) {
        if (!currentSubstituteRequests.has(id)) {
            return;
        }

        let request = currentSubstituteRequests.get(id);

        request.timeout = null;

        database.Game.findById(request.game).populate('teams.composition.players.user').exec().then(function(game) {
            if (game.status === 'completed' || game.status === 'aborted') {
                self.emit('removeSubstituteRequest', id);
                return;
            }

            let team = game.teams[request.team];
            let roleIndex = lodash.findIndex(team.composition, function(role) {
                return role.role === request.role && lodash.some(role.players, {
                    user: {
                        id: request.player
                    },
                    replaced: false
                });
            });

            if (roleIndex === -1) {
                self.emit('removeSubstituteRequest', id);
                return;
            }

            let player = lodash.find(team.composition[roleIndex].players, {
                user: {
                    id: request.player
                },
                replaced: false
            });

            if (request.candidates.length === 0) {
                return;
            }

            return database.User.find({
                _id: {
                    $in: [...request.candidates]
                }
            }).populate('currentRating').exec().then(function(users) {
                let organizedUsers = lodash.keyBy(users, 'id');
                let candidates = lodash.map([...request.candidates], function(userID) {
                    return organizedUsers[userID];
                });

                if (substituteSelectionMethod === 'first') {
                    return candidates[0];
                }
                else if (substituteSelectionMethod === 'closest') {
                    return player.user.populate('currentRating').execPopulate().then(function(player) {
                        let playerRating = 0;

                        if (player.currentRating) {
                            playerRating = player.currentRating.rating - (3 * player.currentRating.deviation);
                        }

                        let sortedCandidates = lodash.sortBy(candidates, function(candidate) {
                            let candidateRating = 0;

                            if (candidate.currentRating) {
                                candidateRating = candidate.currentRating.rating - (3 * candidate.currentRating.deviation);
                            }

                            return Math.abs(candidateRating - playerRating);
                        });

                        return sortedCandidates[0];
                    });
                }
                else if (substituteSelectionMethod === 'random') {
                    return chance.pick(candidates);
                }
            }).then(function(replacement) {
                player.replaced = true;

                team.composition[roleIndex].players.push({
                    user: replacement.id
                });

                return game.save();
            }).then(function() {
                self.emit('updateServerRoster', game);

                self.emit('sendMessageToUser', {
                    userID: request.player,
                    name: 'currentGameUpdated',
                    arguments: [null]
                });
                self.emit('updateUsers', [request.player]);

                self.emit('updateGamePlayers', game);
                self.emit('broadcastGameInfo', game);

                self.emit('removeSubstituteRequest', id);
            });
        });
    }

    self.on('updateGamePlayers', function(game) {
        game.populate('teams.composition.players.user').execPopulate().then(function(game) {
            let players = lodash(game.teams).map(function(team) {
                return lodash.map(team.composition, function(role) {
                    return lodash.map(role.players, function(player) {
                        return player.id;
                    });
                });
            }).flattenDeep().value();

            self.emit('updateUsers', players);
        });
    });

    self.on('broadcastGameInfo', function(game) {
        formatGameInfo(game).then(function(gameInfo) {
            lodash.each(game.teams, function(team) {
                lodash.each(team.composition, function(role) {
                    lodash.each(role.players, function(player) {
                        if (!player.replaced) {
                            self.emit('sendMessageToUser', {
                                userID: player.user.id || player.user.toHexString(),
                                name: 'currentGameUpdated',
                                arguments: [gameInfo]
                            });
                        }
                    });
                });
            });
        });
    });

    self.on('wrapUpGame', function(game) {
        self.emit('updateGamePlayers', game);

        self.emit('broadcastGameInfo', game);

        lodash.forEach(currentSubstituteRequests, function(request, id) {
            if (request.game === game.id) {
                self.emit('removeSubstituteRequest', id);
            }
        });
    });

    formatSubstituteRequests().then(function(info) {
        io.sockets.emit('substituteRequestsUpdated', info);
    });

    self.on('requestSubstitute', function(info) {
        database.Game.findById(info.game).populate('teams.captain teams.composition.players.user').exec().then(function(game) {
            if (!game) {
                return;
            }

            if (game.status === 'completed' || game.status === 'aborted') {
                return;
            }

            let teamIndex = lodash.findIndex(game.teams, {
                captain: {
                    id: info.captain
                }
            });

            if (teamIndex === -1) {
                return;
            }

            let team = game.teams[teamIndex];

            let player = lodash(team.composition).map(function(role) {
                if (role.role === info.role) {
                    return role.players;
                }
                else {
                    return [];
                }
            }).flatten().find({
                user: {
                    id: info.player
                }
            });

            if (!player || player.replaced) {
                return;
            }

            if (currentSubstituteRequests.has(player.id)) {
                return;
            }

            currentSubstituteRequests.set(player.id, {
                game: info.game,
                team: teamIndex,
                role: info.role,
                player: player.user.id,
                start: Date.now(),
                end: Date.now() + substituteRequestPeriod,
                candidates: new Set(),
                timeout: setTimeout(attemptSubstitution, substituteRequestPeriod, player.id)
            });

            formatSubstituteRequests().then(function(info) {
                io.sockets.emit('substituteRequestsUpdated', info);
            });
        });
    });

    self.on('updateSubstituteApplication', function(info) {
        if (!currentSubstituteRequests.has(info.request)) {
            return;
        }

        let userRestrictions = self.userRestrictions.get(info.player);
        let request = currentSubstituteRequests.get(info.request);

        if (!lodash.includes(userRestrictions.aspects, 'sub')) {
            if (info.status) {
                request.candidates.add(info.player);
            }
            else {
                request.candidates.delete(info.player);
            }
        }
        else {
            request.candidates.delete(info.player);
        }

        formatSubstituteRequests().then(function(info) {
            io.sockets.emit('substituteRequestsUpdated', info);
        });

        if (Date.now() >= request.end) {
            attemptSubstitution(info.request);
        }
    });

    self.on('retractSubstituteRequest', function(info) {
        if (!currentSubstituteRequests.has(info.request)) {
            return;
        }

        let request = currentSubstituteRequests.get(info.request);

        database.Game.findById(request.game).populate('teams.captain').exec().then(function(game) {
            if (game.teams[request.team].captain.id !== info.captain) {
                return;
            }

            self.emit('removeSubstituteRequest', info.request);
        });
    });

    self.on('removeSubstituteRequest', function(id) {
        if (currentSubstituteRequests.has(id)) {
            let request = currentSubstituteRequests.delete(id);

            if (request.timeout) {
                clearTimeout(request.timeout);
            }

            formatSubstituteRequests().then(function(info) {
                io.sockets.emit('substituteRequestsUpdated', info);
            });
        }
    });

    self.on('gameSetup', function(info) {
        info.game.status = 'launching';
        info.game.save().then(function() {
            self.emit('updateGamePlayers', info.game);
            self.emit('broadcastGameInfo', info.game);
            self.emit('cleanUpDraft');

            setTimeout(timeoutGame, ms(config.get('app.games.startPeriod')), info.game);
        });
    });

    self.on('gameLive', function(info) {
        info.game.status = 'live';

        if (info.score) {
            info.game.score = lodash.map(info.game.teams, function(team) {
                return info.score[team.faction];
            });
        }

        if (info.duration) {
            info.game.duration = info.duration;
        }

        info.game.save();
    });

    self.on('gameAbandoned', function(info) {
        self.emit('abortGame', info.game);

        if (info.score) {
            info.game.score = lodash.map(info.game.teams, function(team) {
                return info.score[team.faction];
            });
        }

        if (info.duration) {
            info.game.duration = info.duration;
        }

        info.game.save().then(function() {
            if (info.time) {
                info.game.populate('teams.composition.players.user', function(err, game) {
                    if (err) {
                        throw err;
                    }

                    lodash.each(game.teams, function(team) {
                        lodash.each(team.composition, function(role) {
                            lodash.each(role.players, function(player) {
                                if (info.time[player.user.steamID]) {
                                    player.time = info.time[player.user.steamID];
                                }
                            });
                        });
                    });

                    game.save();
                });
            }
        });
    });

    self.on('gameCompleted', function(info) {
        info.game.status = 'completed';

        if (info.score) {
            info.game.score = lodash.map(info.game.teams, function(team) {
                return info.score[team.faction];
            });
        }

        if (info.duration) {
            info.game.duration = info.duration;
        }

        info.game.save().then(function() {
            self.emit('wrapUpGame', info.game);

            if (info.time) {
                info.game.populate('teams.composition.players.user', function(err, game) {
                    if (err) {
                        throw err;
                    }

                    lodash.each(game.teams, function(team) {
                        lodash.each(team.composition, function(role) {
                            lodash.each(role.players, function(player) {
                                if (info.time[player.user.steamID]) {
                                    player.time = info.time[player.user.steamID];
                                }
                            });
                        });
                    });

                    game.save().then(function() {
                        rateGame(game);
                    });
                });
            }
        });
    });

    self.on('gameLogAvailable', function(info) {
        let index = lodash.findIndex(info.game.links, 'type', 'logs.tf');

        if (index !== -1) {
            info.game.links[index].link = info.url;
        }
        else {
            info.game.links.push({
                type: 'logs.tf',
                link: info.url
            });
        }

        info.game.save();
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('substituteRequestsUpdated', currentSubstituteRequestsMessage);
    });

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        database.Game.findOne({
            $or: [{
                'teams.captain': userID
            }, {
                'teams.composition.players': {
                    $elemMatch: {
                        user: userID,
                        replaced: false
                    }
                }
            }],
            status: {
                $in: ['launching', 'live']
            }
        }, function(err, game) {
            formatGameInfo(game).then(function(gameInfo) {
                socket.emit('currentGameUpdated', gameInfo);
            });
        });

        socket.on('requestSubstitute', function(info) {
            info.captain = socket.decoded_token;

            self.emit('requestSubstitute', info);
        });

        socket.on('updateSubstituteApplication', function(info) {
            info.player = socket.decoded_token;

            self.emit('updateSubstituteApplication', info);
        });

        socket.on('retractSubstituteRequest', function(info) {
            info.captain = socket.decoded_token;

            self.emit('retractSubstituteRequest', info);
        });
    });

    self.on('userRestrictionsUpdated', function(userID) {
        for (let requestID in currentSubstituteRequests.keys()) {
            let request = currentSubstituteRequests.get(requestID);

            self.emit('updateSubstituteApplication', {
                player: userID,
                request: requestID,
                status: request.candidates.has(userID)
            });
        }
    });

    app.get('/games', function(req, res) {
        database.Game.find({}).sort('-date').populate('teams.captain').exec().then(function(games) {
            res.render('gameList', {
                games: lodash.map(games, game => game.toObject())
            });
        });
    });
};
