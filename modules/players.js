/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var lodash = require('lodash');
var math = require('mathjs');

var database = require('../database');

module.exports = function(app, io, self, server) {
    app.get('/player/:steam', function(req, res) {
        database.User.findOne({
            steamID: req.params.steam
        }, function(err, user) {
            Promise.all([database.Game.find({
                'players.user': user.id
            }).exec(), database.Rating.find({
                'user': user.id
            }).exec()]).then(function(results) {
                // TODO: render player page
            });
        });
    });

    app.get('/players', function(req, res) {
        database.User.find({}).populate('currentRating').exec(function(err, users) {
            var players = lodash(users).filter(function(user) {
                if (user.currentRating) {
                    return true;
                }

                return false;
            }).sortByOrder([function(user) {
                if (user.currentRating) {
                    return user.currentRating.after.rating;
                }
            }, function(user) {
                if (user.currentRating) {
                    return user.currentRating.after.deviation;
                }
            }, function(user) {
                if (user.captainScore) {
                    return user.captainScore.low;
                }
            }], ['desc', 'asc', 'desc']).map(function(user) {
                let viewUser = user.toObject();

                console.log(user);

                viewUser.currentRating.before.rating = math.round(user.currentRating.before.rating);
                viewUser.currentRating.before.deviation = math.round(user.currentRating.before.deviation);
                viewUser.currentRating.after.rating = math.round(user.currentRating.after.rating);
                viewUser.currentRating.after.deviation = math.round(user.currentRating.after.deviation);

                if (viewUser.captainScore) {
                    viewUser.captainScore.low = math.round(user.captainScore.low, 3);
                    viewUser.captainScore.center = math.round(user.captainScore.center, 3);
                    viewUser.captainScore.high = math.round(user.captainScore.high, 3);
                }

                return viewUser;
            }).reverse().value();

            res.render('playerList', {
                players: players
            });
        });
    });
};
