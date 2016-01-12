/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var child_process = require('child_process');
var config = require('config');
var lodash = require('lodash');
var ms = require('ms');
var path = require('path');

module.exports = function(app, database, io, self, server) {
    var gameServerPool = config.get('app.servers.pool');

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
            game.populate('captains.user').execPopulate().then(function(game) {
                return Promise.all(lodash.map(game.captains, function(captain) {
                    let user = captain.user;

                    return database.Game.find({
                        'captains.user': user.id,
                        'status': 'completed'
                    }).exec().then(function(captainGames) {
                        let captainStats = lodash.reduce(captainGames, function(stats, game) {
                            stats.total++;

                            if (user._id.equals(game.captains[0].user)) {
                                if (game.results.score[0] > game.results.score[1]) {
                                    stats.wins++;
                                }
                                else if (game.results.score[0] < game.results.score[1]) {
                                    stats.losses++;
                                }
                                else if (game.results.score[0] === game.results.score[1]) {
                                    stats.ties++;
                                }
                            }
                            else if (user._id.equals(game.captains[1].user)) {
                                if (game.results.score[1] > game.results.score[0]) {
                                    stats.wins++;
                                }
                                else if (game.results.score[1] < game.results.score[0]) {
                                    stats.losses++;
                                }
                                else if (game.results.score[1] === game.results.score[0]) {
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

        return game.populate('captains.user players.user').execPopulate().then(function(game) {
            if (game.status === 'aborted' || game.status === 'completed') {
                return null;
            }
            else {
                let gameInfo = game.toObject();

                // TODO: transform game info

                return gameInfo;
            }
        });
    }

    self.on('broadcastGameInfo', function(game) {
        formatGameInfo(game).then(function(gameInfo) {
            lodash.each(game.players, function(player) {
                if (!player.replacement) {
                    self.emit('sendMessageToUser', {
                        userID: player.user.toHexString(),
                        name: 'currentGameUpdated',
                        arguments: [gameInfo]
                    });
                }
            });
        });
    });

    self.on('gameSetup', function(info) {
        info.game.status = 'launching';
        info.game.save();

        // NOTE: forces a user update so they cannot add up to another game
        self.emit('retrieveUsers', lodash.map(info.game.players, function(player) {
            return player.user;
        }));

        self.emit('cleanUpDraft');

        self.emit('broadcastGameInfo', info.game);

        setTimeout(timeoutGame, ms(config.get('app.games.startPeriod')), info.game);
    });

    self.on('gameLive', function(info) {
        info.game.status = 'live';

        if (info.score) {
            info.game.results.score.splice(0, lodash.size(info.game.results.score));

            lodash.each(info.game.captains, function(captain) {
                info.game.results.score.push(info.score[captain.faction]);
            });
        }

        info.game.save();
    });

    self.on('gameAbandoned', function(info) {
        self.emit('abortGame', info.game);

        if (info.score) {
            info.game.results.score.splice(0, lodash.size(info.game.results.score));

            lodash.each(info.game.captains, function(captain) {
                info.game.results.score.push(info.score[captain.faction]);
            });
        }

        if (info.duration) {
            info.game.results.duration = info.duration;
        }

        info.game.save().then(function() {
            if (info.time) {
                info.game.populate('players.user', function(err, game) {
                    if (err) {
                        throw err;
                    }

                    lodash.each(game.players, function(player) {
                        player.time = info.time[player.user.steamID];
                    });

                    game.save();
                });
            }
        });
    });

    self.on('gameCompleted', function(info) {
        info.game.status = 'completed';

        if (info.score) {
            info.game.results.score.splice(0, lodash.size(info.game.results.score));

            lodash.each(info.game.captains, function(captain) {
                info.game.results.score.push(info.score[captain.faction]);
            });
        }

        if (info.duration) {
            info.game.results.duration = info.duration;
        }

        info.game.save().then(function() {
            if (info.time) {
                info.game.populate('players.user', function(err, game) {
                    if (err) {
                        throw err;
                    }

                    lodash.each(game.players, function(player) {
                        player.time = info.time[player.user.steamID];
                    });

                    game.save().then(function() {
                        rateGame(game);
                    });
                });
            }
        });

        // NOTE: forces a user update so they can add up to another game
        self.emit('retrieveUsers', lodash.map(info.game.players, function(player) {
            return player.user;
        }));

        self.emit('broadcastGameInfo', info.game);
    });

    self.on('gameLogAvailable', function(info) {
        let index = lodash.findIndex(info.game.results.links, 'type', 'logs.tf');

        if (index !== -1) {
            info.game.results.links[index].link = info.url;
        }
        else {
            info.game.results.links.push({
                type: 'logs.tf',
                link: info.url
            });
        }

        info.game.save();
    });

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        database.Game.findOne({
            players: {
                $elemMatch: {
                    user: userID,
                    replacement: {
                        $exists: false
                    }
                }
            },
            status: {
                $in: ['launching', 'live']
            }
        }, function(err, game) {
            socket.emit('currentGameUpdated', formatGameInfo(game));
        });
    });
};
