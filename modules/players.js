/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const lodash = require('lodash');
const math = require('mathjs');

module.exports = function(app, database, io, self, server) {
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
        database.User.find({
            $or: [{
                'currentRating': {
                    $exists: true
                }
            }, {
                'captainScore.low': {
                    $exists: true
                }
            }]
        }).populate('currentRating').exec(function(err, users) {
            var players = lodash(users).orderBy([function(user) {
                if (user.currentRating) {
                    return user.currentRating.after.rating;
                }

                return Number.NEGATIVE_INFINITY;
            }, function(user) {
                if (user.currentRating) {
                    return user.currentRating.after.deviation;
                }

                return Number.POSITIVE_INFINITY;
            }, function(user) {
                if (lodash.has(user.captainScore, 'low')) {
                    return user.captainScore.low;
                }

                return Number.NEGATIVE_INFINITY;
            }], ['desc', 'asc', 'desc']).map(function(user) {
                let viewUser = user.toObject();

                if (viewUser.currentRating) {
                    viewUser.currentRating.before.rating = math.round(user.currentRating.before.rating);
                    viewUser.currentRating.before.deviation = math.round(user.currentRating.before.deviation);
                    viewUser.currentRating.after.rating = math.round(user.currentRating.after.rating);
                    viewUser.currentRating.after.deviation = math.round(user.currentRating.after.deviation);
                }

                if (viewUser.captainScore) {
                    viewUser.captainScore.low = math.round(user.captainScore.low, 3);
                    viewUser.captainScore.center = math.round(user.captainScore.center, 3);
                    viewUser.captainScore.high = math.round(user.captainScore.high, 3);
                }

                return viewUser;
            }).value();

            res.render('playerList', {
                players: players
            });
        });
    });
};
