/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var bodyParser = require('body-parser');
var config = require('config');
var jwt = require('jsonwebtoken');
var lodash = require('lodash');
var OpenIDStrategy = require('passport-openid').Strategy;
var passport = require('passport');
var socketioJwt = require('socketio-jwt');
var url = require('url');

var database = require('../database');

module.exports = function(app, io, self, server) {
    self.unauthenticatedRestrictions = {
        aspects: ['start', 'chat'],
        reasons: ['You are currently not logged on.']
    };
    self.userRestrictions = {};
    self.userSockets = {};
    self.users = {};

    self.getFilteredUser = function getFilteredUser(userID) {
        return lodash.omit(self.users[userID].toObject(), ['_id', 'id', '__v']);
    };

    self.on('retrieveUsers', function(userIDs) {
        if (!userIDs) {
            userIDs = lodash(io.sockets.connected).map(function(socket) {
                return socket.decoded_token;
            }).compact().value();
        }

        database.User.find({
            '_id': {
                $in: userIDs
            }
        }, function(err, users) {
            if (err) {
                throw err;
                return;
            }

            lodash.each(users, function(user) {
                self.users[user.id] = user;
            });

            self.emit('usersRetrieved', lodash.map(users, function(user) {
                return user.id;
            }));
        });
    });

    self.on('usersRetrieved', function(userIDs) {
        lodash.each(userIDs, function(userID) {
            Promise.all([
                // check user bans
                // check that user is currently not playing in a game
            ]).then(function(restrictions) {
                self.userRestrictions[userID] = lodash.reduce(restrictions, function(allRestrictions, restriction) {
                    allRestrictions.aspects = lodash.union(allRestrictions.aspects, restriction.aspects);
                    allRestrictions.reasons = [...allRestrictions.reasons, ...restriction.reasons];
                }, {
                    aspects: [],
                    reasons: []
                });

                if (self.userSockets[userID]) {
                    for (let socketID of self.userSockets[userID]) {
                        io.sockets.connected[socketID].emit('restrictionsUpdated', self.userRestrictions[userID]);
                    }
                }

                self.emit('userRestrictionsUpdated', userID);
            });
        });
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
            } else if (!user) {
                user = new database.User({
                    steamID: id
                });
                user.save(function(err) {
                    done(err, user);
                });
            } else {
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
        } else {
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

        res.status(200).send(token);
    });

    io.sockets.on('connection', socketioJwt.authorize({
        required: false,
        secret: config.get('server.tokenSecret'),
        additionalAuth: function(token, successCallback, errorCallback) {
            database.User.findById(token, function(err, user) {
                if (err) {
                    errorCallback(err);
                } else if (!user) {
                    errorCallback('user was not found');
                } else {
                    successCallback();
                }
            });
        }
    }));

    io.sockets.on('connection', function(socket) {
        socket.emit('restrictionsUpdated', self.unauthenticatedRestrictions);
    });
    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        if (!self.userSockets[userID]) {
            self.emit('retrieveUsers', [userID]);

            self.userSockets[userID] = new Set([socket.id]);

            let userRetrieved = function(users) {
                if (lodash.includes(users, userID)) {
                    self.emit('userConnected', userID);
                } else {
                    self.once('usersRetrieved', userRetrieved);
                }
            };
            self.once('usersRetrieved', userRetrieved);
        } else {
            self.userSockets[userID].add(socket.id);

            socket.emit('restrictionsUpdated', self.userRestrictions[socket.decoded_token]);
        }

        socket.on('disconnect', function() {
            self.userSockets[userID].delete(socket.id);

            if (self.userSockets[userID].size === 0) {
                self.emit('userDisconnected', userID);

                delete self.userRestrictions[userID];
                delete self.users[userID];
                delete self.userSockets[userID];
            }
        });
    });

    app.get('/user/settings', function(req, res) {
        if (req.user) {
            res.render('userSettings');
        } else {
            res.redirect('/user/login');
        }
    });
    app.post('/user/settings', bodyParser.urlencoded({
        extended: false
    }), function(req, res) {
        Promise.all([
            new Promise(function(resolve, reject) {
                if (req.body.alias && !req.user.alias) {
                    if (/\w+/.test(req.body.alias)) {
                        database.User.findOne({alias: req.body.alias}, function(err, user) {
                            if (err) {
                                reject(err);
                            }

                            if (!user) {
                                req.user.alias = req.body.alias;
                                resolve();
                            }
                            else {
                                reject('duplicate alias found');
                            }
                        });
                    }
                    else {
                        reject('invalid alias format');
                    }
                }

                resolve();
            })
        ]).then(function() {
            if (req.user.alias) {
                req.user.setUp = true;
            }

            req.user.save(function() {
                res.redirect('/user/settings');
            });
        }, function() {
            res.redirect('/user/settings');
        });
    });
};
