/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const child_process = require('child_process');
const config = require('config');
const lodash = require('lodash');
const ms = require('ms');
const path = require('path');
const wilson = require('wilson-interval');

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

    self.on('updateGamePlayers', function(game) {
        game.populate('teams.composition.players.user').execPopulate().then(function(game) {
            let players = lodash(game.teams).map(function(team) {
                return lodash.map(team.composition, function(role) {
                    return lodash.map(role.players, function(player) {
                        return player.id;
                    });
                });
            }).flatten().value();

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
                                userID: player.user.toHexString(),
                                name: 'currentGameUpdated',
                                arguments: [gameInfo]
                            });
                        }
                    });
                });
            });
        });
    });

    self.on('gameSetup', function(info) {
        info.game.status = 'launching';
        info.game.save();

        self.emit('updateGamePlayers', info.game);

        self.emit('cleanUpDraft');

        self.emit('broadcastGameInfo', info.game);

        setTimeout(timeoutGame, ms(config.get('app.games.startPeriod')), info.game);
    });

    self.on('gameLive', function(info) {
        info.game.status = 'live';

        if (info.score) {
            info.game.score = [];

            lodash.each(info.game.teams, function(team) {
                info.game.score.push(info.score[team.faction]);
            });
        }

        info.game.save();
    });

    self.on('gameAbandoned', function(info) {
        self.emit('abortGame', info.game);

        if (info.score) {
            info.game.score = [];

            lodash.each(info.game.teams, function(team) {
                info.game.score.push(info.score[team.faction]);
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
                                player.time = info.time[player.user.steamID];
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
            info.game.score = [];

            lodash.each(info.game.teams, function(team) {
                info.game.score.push(info.score[team.faction]);
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
                                player.time = info.time[player.user.steamID];
                            });
                        });
                    });

                    game.save().then(function() {
                        rateGame(game);
                    });
                });
            }
        });

        self.emit('updateGamePlayers', info.game);
        self.emit('broadcastGameInfo', info.game);
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

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        database.Game.findOne({
            'teams.composition.players': {
                $elemMatch: {
                    user: userID,
                    replaced: false
                }
            },
            status: {
                $in: ['launching', 'live']
            }
        }, function(err, game) {
            formatGameInfo(game).then(function(gameInfo) {
                socket.emit('currentGameUpdated', gameInfo);
            });
        });
    });
};
