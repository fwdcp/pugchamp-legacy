/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var lodash = require('lodash');

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
            }).sortBy(function(user) {
                return user.currentRating.after.deviation;
            }).sortBy(function(user) {
                return user.currentRating.after.rating;
            }).map(function(user) {
                let viewUser = lodash.omit(user.toObject(), ['_id', 'id', '__v']);

                viewUser.currentRating.before.rating = Math.round(viewUser.currentRating.before.rating);
                viewUser.currentRating.before.deviation = Math.round(viewUser.currentRating.before.deviation);
                viewUser.currentRating.after.rating = Math.round(viewUser.currentRating.after.rating);
                viewUser.currentRating.after.deviation = Math.round(viewUser.currentRating.after.deviation);

                return viewUser;
            }).reverse().value();

            res.render('playerList', {
                players: players
            });
        });
    });
};
