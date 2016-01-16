/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const jwt = require('jsonwebtoken');
const lodash = require('lodash');
const OpenIDStrategy = require('passport-openid').Strategy;
const passport = require('passport');
const socketioJwt = require('socketio-jwt');
const url = require('url');

module.exports = function(app, database, io, self, server) {
    const UNAUTHENTICATED_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain', 'chat'],
        reasons: ['You are currently not logged on.']
    };
    var userRestrictions = new Map();
    var userSockets = new Map();

    self.getOnlineUsers = function getOnlineUsers() {
        return [...userSockets.keys()];
    };

    self.emitToUser = function emitToUser(userID, name, args) {
        if (userSockets.has(userID)) {
            for (let socket of userSockets.get(userID)) {
                io.sockets.connected[socket].emit(name, args);
            }
        }
    };

    self.getUserRestrictions = function getUserRestrictions(userID) {
        const UNKNOWN_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain', 'chat'],
            reasons: ['There was an error retrieving your current restrictions.']
        };

        if (userID) {
            if (userRestrictions.has(userID)) {
                return userRestrictions.get(userID);
            }
            else {
                self.updateUserRestrictions(userID);

                return UNKNOWN_RESTRICTIONS;
            }
        }

        return UNAUTHENTICATED_RESTRICTIONS;
    };
    self.updateUserRestrictions = co.wrap(function* updateUserRestrictions(userID) {
        let user = yield database.User.findById(userID);
        let restrictions = [];

        const NOT_READY_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain', 'chat'],
            reasons: ['Your account is not set up properly.']
        };
        if (!user.setUp) {
            restrictions.push(NOT_READY_RESTRICTIONS);
        }

        const CURRENT_GAME_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain'],
            reasons: ['You are involved in a currently active game.']
        };
        let currentGame = yield database.Game.findOne({
            $or: [{
                'teams.captain': userID
            }, {
                'teams.composition.players.user': userID
            }],
            status: {
                $in: ['assigning', 'launching', 'live']
            }
        });
        if (currentGame) {
            restrictions.push(CURRENT_GAME_RESTRICTIONS);
        }

        // TODO: check user restrictions

        let combinedRestrictions = lodash.reduce(restrictions, function(combinedRestrictions, restriction) {
            return {
                aspects: lodash.union(combinedRestrictions.aspects, restriction.aspects),
                reasons: [...combinedRestrictions.reasons, ...restriction.reasons]
            };
        }, {
            aspects: [],
            reasons: []
        });

        self.emit('userRestrictionsUpdated', userID);

        return combinedRestrictions;
    });

    self.on('userRestrictionsUpdated', function(userID) {
        self.emitToUser(userID, 'restrictionsUpdated', [self.getUserRestrictions(userID)]);
    });

    passport.use(new OpenIDStrategy({
        providerURL: 'http://steamcommunity.com/openid',
        returnURL: function(req) {
            return url.format({
                protocol: req.protocol,
                host: req.get('host'),
                pathname: '/user/login/return'
            });
        },
        realm: function(req) {
            return url.format({
                protocol: req.protocol,
                host: req.get('host')
            });
        },
        stateless: true
    }, function(identifier, done) {
        let id = identifier.replace('http://steamcommunity.com/openid/id/', '');

        database.User.findOne({
            steamID: id
        }, function(err, user) {
            if (err) {
                done(err);
            }
            else if (!user) {
                user = new database.User({
                    steamID: id
                });
                user.save(function(err) {
                    done(err, user);
                });
            }
            else {
                done(null, user);
            }
        });
    }));
    passport.serializeUser(function(user, done) {
        done(null, user._id);
    });
    passport.deserializeUser(function(id, done) {
        database.User.findById(id, done);
    });

    app.use(function(req, res, next) {
        res.locals.user = req.user ? req.user.toObject() : null;
        next();
    });

    app.get('/user/login', passport.authenticate('openid'));
    app.get('/user/login/return', passport.authenticate('openid'), function(req, res) {
        if (req.user && !req.user.setUp) {
            res.redirect('/user/settings');
        }
        else {
            res.redirect('/');
        }
    });
    app.get('/user/logout', function(req, res) {
        req.logout();
        res.redirect('/');
    });
    app.get('/user/token', function(req, res) {
        if (!req.user) {
            res.sendStatus(401);
            return;
        }

        let token = jwt.sign(req.user.id, config.get('server.tokenSecret'), {
            expiresIn: config.get('server.tokenExpiration')
        });

        res.status(200).json({
            token: token
        });
    });

    io.sockets.on('connection', socketioJwt.authorize({
        required: false,
        secret: config.get('server.tokenSecret'),
        additionalAuth: function(token, successCallback, errorCallback) {
            database.User.findById(token, function(err, user) {
                if (err) {
                    errorCallback(err);
                }
                else if (!user) {
                    errorCallback('user was not found');
                }
                else {
                    successCallback();
                }
            });
        }
    }));

    io.sockets.on('connection', function(socket) {
        socket.emit('restrictionsUpdated', UNAUTHENTICATED_RESTRICTIONS);
    });
    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        socket.emit('userUpdated', userID);

        if (!userSockets.has(userID)) {
            userSockets.set(userID, new Set([socket.id]));

            self.emit('userConnected', userID);
        }
        else {
            userSockets.get(userID).add(socket.id);

            socket.emit('restrictionsUpdated', self.getUserRestrictions(userID));
        }

        socket.on('disconnect', function() {
            userSockets.get(userID).delete(socket.id);

            if (userSockets.get(userID).size === 0) {
                self.emit('userDisconnected', userID);

                userSockets.delete(userID);
            }
        });
    });

    app.get('/user/settings', function(req, res) {
        if (req.user) {
            let errors = [];

            if (!req.user.setUp) {
                errors.push('Your account is not set up yet.');
            }

            res.render('userSettings', {
                errors: errors
            });
        }
        else {
            res.redirect('/user/login');
        }
    });
    app.post('/user/settings', bodyParser.urlencoded({
        extended: false
    }), co.wrap(function*(req, res) {
        if (req.user) {
            let errors = [];

            if (req.body.alias && !req.user.alias) {
                if (/^[A-Za-z0-9_]{1,15}$/.test(req.body.alias)) {
                    let existingUser = yield database.User.findOne({
                        alias: req.body.alias
                    });

                    if (!existingUser) {
                        errors.push('The alias you selected is not available.');
                    }
                    else {
                        req.user.alias = req.body.alias;
                    }
                }
                else {
                    errors.push('The alias you selected is not in the proper format');
                }
            }

            if (req.user.alias) {
                req.user.setUp = true;
            }
            else {
                errors.push('Your account is not set up yet.');
            }

            yield req.user.save();

            res.render('userSettings', {
                errors: errors
            });
        }
        else {
            res.redirect('/user/login');
        }
    }));
};
