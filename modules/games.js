/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var config = require('config');
var lodash = require('lodash');
var ms = require('ms');

var database = require('../database');

module.exports = function(app, io, self, server) {
    var gameServerPool = config.get('app.servers.pool');

    function abortGame(game) {
        database.Game.findById(game.id, function(err, updatedGame) {
            if (updatedGame.status === 'assigning' || updatedGame.status === 'launching') {
                self.emit('retrieveUsers', lodash.map(game.players, function(player) {
                    return player.user;
                }));

                lodash.each(updatedGame.players, function(player) {
                    if (!player.replaced) {
                        self.emit('sendMessageToUser', {
                            userID: player.user.toHexString(),
                            name: 'currentGame',
                            arguments: [null]
                        });
                    }
                });

                updatedGame.status = 'aborted';
                updatedGame.save();
            }
        });
    }

    self.on('gameSetup', function(info) {
        info.game.status = 'launching';
        info.game.save();

        // NOTE: forces a user update so they cannot add up to another game
        self.emit('retrieveUsers', lodash.map(info.game.players, function(player) {
            return player.user;
        }));

        self.emit('cleanUpDraft');

        let gameServer = gameServerPool[info.game.server];

        lodash.each(info.game.players, function(player) {
            if (!player.replaced) {
                self.emit('sendMessageToUser', {
                    userID: player.user.toHexString(),
                    name: 'currentGame',
                    arguments: [{
                        game: info.game.id,
                        address: gameServer.address,
                        password: gameServer.password
                    }]
                });
            }
        });

        setTimeout(abortGame, ms(config.get('app.games.startPeriod')), info.game);
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
        info.game.status = 'aborted';

        if (info.score) {
            info.game.results.score.splice(0, lodash.size(info.game.results.score));

            lodash.each(info.game.captains, function(captain) {
                info.game.results.score.push(info.score[captain.faction]);
            });
        }

        info.game.save();

        // NOTE: forces a user update so they can add up to another game
        self.emit('retrieveUsers', lodash.map(info.game.players, function(player) {
            return player.user;
        }));

        lodash.each(info.game.players, function(player) {
            if (!player.replaced) {
                self.emit('sendMessageToUser', {
                    userID: player.user.toHexString(),
                    name: 'currentGame',
                    arguments: [null]
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

        info.game.save();

        // NOTE: forces a user update so they can add up to another game
        self.emit('retrieveUsers', lodash.map(info.game.players, function(player) {
            return player.user;
        }));

        lodash.each(info.game.players, function(player) {
            if (!player.replaced) {
                self.emit('sendMessageToUser', {
                    userID: player.user.toHexString(),
                    name: 'currentGame',
                    arguments: [null]
                });
            }
        });

        // TODO: calculate ratings
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
                    replaced: false
                }
            },
            status: {
                $in: ['launching', 'live']
            }
        }, function(err, game) {
            if (game) {
                let gameServer = gameServerPool[game.server];

                socket.emit('currentGame', {
                    game: game.id,
                    address: gameServer.address,
                    password: gameServer.password
                });
            }
            else {
                socket.emit('currentGame', null);
            }
        });
    });
};
