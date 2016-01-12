/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const bodyParser = require('body-parser');
const config = require('config');
const jwt = require('jsonwebtoken');
const lodash = require('lodash');
const OpenIDStrategy = require('passport-openid').Strategy;
const passport = require('passport');
const socketioJwt = require('socketio-jwt');
const url = require('url');

module.exports = function(app, database, io, self, server) {
    self.unauthenticatedRestrictions = {
        aspects: ['sub', 'start', 'captain', 'chat'],
        reasons: ['You are currently not logged on.']
    };
    self.userRestrictions = new Map();
    self.userSockets = new Map();
    self.users = new Map();

    self.getOnlineList = function getOnlineList() {
        return [...self.userSockets.keys()];
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
            }

            lodash.forEach(users, function(user) {
                self.users.set(user.id, user);
            });

            self.emit('usersRetrieved', lodash.map(users, function(user) {
                return user.id;
            }));
        });
    });

    self.on('sendMessageToUser', function(message) {
        if (self.userSockets.has(message.userID)) {
            for (let socketID of self.userSockets.get(message.userID)) {
                io.sockets.connected[socketID].emit(message.name, ...message.arguments);
            }
        }
    });

    self.on('usersRetrieved', function(userIDs) {
        lodash.forEach(userIDs, function(userID) {
            self.emit('sendMessageToUser', {
                userID: userID,
                name: 'userInfoUpdated',
                arguments: [self.users.get(userID).toObject()]
            });

            Promise.all([
                new Promise(function(resolve, reject) {
                    if (self.users.get(userID).setUp) {
                        resolve({
                            aspects: [],
                            reasons: []
                        });
                    }
                    else {
                        resolve({
                            aspects: ['sub', 'start', 'captain', 'chat'],
                            reasons: ['Your account is not set up properly.']
                        });
                    }
                }),
                // TODO: check user bans
                new Promise(function(resolve, reject) {
                    database.Game.findOne({
                        'players.user': userID,
                        status: {
                            $in: ['assigning', 'launching', 'live']
                        }
                    }, function(err, game) {
                        if (game) {
                            resolve({
                                aspects: ['sub', 'start', 'captain'],
                                reasons: ['You are currently in a game.']
                            });
                        }
                        else {
                            resolve({
                                aspects: [],
                                reasons: []
                            });
                        }
                    });
                })
            ]).then(function(restrictions) {
                self.userRestrictions.set(userID, lodash.reduce(restrictions, function(allRestrictions, restriction) {
                    return {
                        aspects: lodash.union(allRestrictions.aspects, restriction.aspects),
                        reasons: [...allRestrictions.reasons, ...restriction.reasons]
                    };
                }, {
                    aspects: [],
                    reasons: []
                }));

                self.emit('userRestrictionsUpdated', userID);
            });
        });
    });

    self.on('userRestrictionsUpdated', function(userID) {
        self.emit('sendMessageToUser', {
            userID: userID,
            name: 'restrictionsUpdated',
            arguments: [self.userRestrictions.get(userID)]
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
        socket.emit('restrictionsUpdated', self.unauthenticatedRestrictions);
    });
    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token;

        if (!self.userSockets.has(userID)) {
            self.emit('retrieveUsers', [userID]);

            self.userSockets.set(userID, new Set([socket.id]));

            let userRetrieved = function(users) {
                if (lodash.includes(users, userID)) {
                    self.emit('userConnected', userID);
                }
                else {
                    self.once('usersRetrieved', userRetrieved);
                }
            };
            self.once('usersRetrieved', userRetrieved);
        }
        else {
            self.userSockets.get(userID).add(socket.id);

            socket.emit('userInfoUpdated', self.users.get(userID).toObject());
            socket.emit('restrictionsUpdated', self.userRestrictions.get(userID));
        }

        socket.on('disconnect', function() {
            self.userSockets.get(userID).delete(socket.id);

            if (self.userSockets.get(userID).size === 0) {
                self.emit('userDisconnected', userID);

                self.userRestrictions.delete(userID);
                self.userSockets.delete(userID);
            }
        });
    });

    app.get('/user/settings', function(req, res) {
        if (req.user) {
            res.render('userSettings');
        }
        else {
            res.redirect('/user/login');
        }
    });
    app.post('/user/settings', bodyParser.urlencoded({
        extended: false
    }), function(req, res) {
        Promise.all([
            new Promise(function(resolve, reject) {
                if (req.body.alias && !req.user.alias) {
                    if (/\w{1,15}/.test(req.body.alias)) {
                        database.User.findOne({
                            alias: req.body.alias
                        }, function(err, user) {
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
                else {
                    resolve();
                }
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

    app.get('/', function(req, res) {
        res.render('index', {
            user: req.user
        });
    });
};
