'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const debug = require('debug');
const jwt = require('jsonwebtoken');
const HttpStatus = require('http-status-codes');
const moment = require('moment');
const OpenIDStrategy = require('passport-openid').Strategy;
const passport = require('passport');
const rp = require('request-promise');
const socketioJwt = require('socketio-jwt');
const url = require('url');

var socketDebug = debug('pugchamp:sockets');

module.exports = function(app, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const CAPTAIN_GAME_REQUIREMENT = config.get('app.users.captainGameRequirement');
    const UNAUTHENTICATED_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain', 'chat', 'support'],
        reasons: ['You are currently not [logged on](/user/login).']
    };
    const USER_AUTHORIZATIONS = config.has('app.users.authorizations') ? config.get('app.users.authorizations') : [];
    const USER_AUTHORIZATION_DEFAULT = config.has('app.users.authorizationDefault') ? config.get('app.users.authorizationDefault') : true;
    const USER_AUTHORIZATION_APIS = config.has('app.users.authorizationAPIs') ? config.get('app.users.authorizationAPIs') : [];
    var userCache = new Map();
    var userRestrictions = new Map();
    var userSockets = new Map();

    function checkUserAuthorization(user) {
        return co(function*() {
            for (let authorization of USER_AUTHORIZATIONS) {
                if (authorization.user === user.steamID) {
                    return authorization.authorized;
                }
            }

            for (let authorizationAPI of USER_AUTHORIZATION_APIS) {
                try {
                    let response = yield rp({
                        resolveWithFullResponse: true,
                        simple: true,
                        qs: {
                            user: user.steamID
                        },
                        uri: authorizationAPI
                    });

                    if (response.statusCode === HttpStatus.OK) {
                        return true;
                    }
                    else if (response.statusCode === HttpStatus.FORBIDDEN) {
                        return false;
                    }
                    else {
                        continue;
                    }
                }
                catch (err) {
                    continue;
                }
            }

            return USER_AUTHORIZATION_DEFAULT;
        });
    }

    self.getCachedUsers = function getCachedUsers() {
        return [...userCache.values()];
    };

    self.getCachedUser = function getCachedUser(userID) {
        return userCache.get(userID);
    };

    self.updateCachedUser = co.wrap(function*(userID) {
        let user = yield database.User.findById(userID);

        userCache.set(userID, user.toObject());

        self.emit('cachedUserUpdated', userID);
    });

    self.getOnlineUsers = function getOnlineUsers() {
        return [...userSockets.keys()];
    };

    self.emitToUser = function emitToUser(userID, name, args) {
        if (userSockets.has(userID)) {
            for (let socketID of userSockets.get(userID)) {
                let socket = io.sockets.connected[socketID];

                if (socket) {
                    socket.emit(name, ...args);
                }
            }
        }
    };

    self.getUserRestrictions = function getUserRestrictions(userID) {
        const UNKNOWN_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain', 'chat', 'support'],
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
            aspects: ['sub', 'start', 'captain', 'chat', 'support'],
            reasons: ['Your account is not [set up](/user/settings) properly.']
        };
        if (!user.setUp) {
            restrictions.push(NOT_READY_RESTRICTIONS);
        }

        const UNAUTHORIZED_USER_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain', 'chat', 'support'],
            reasons: ['You are not authorized to use this system.']
        };
        const UNAUTHORIZED_ADMIN_RESTRICTIONS = {
            aspects: ['sub', 'start', 'captain'],
            reasons: ['You are not authorized to play in this system.']
        };
        user.authorized = yield checkUserAuthorization(user);
        yield user.save();
        if (!user.authorized) {
            if (!user.admin) {
                restrictions.push(UNAUTHORIZED_USER_RESTRICTIONS);
            }
            else {
                restrictions.push(UNAUTHORIZED_ADMIN_RESTRICTIONS);
            }
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
                $in: ['initializing', 'launching', 'live']
            }
        });
        if (currentGame) {
            restrictions.push(CURRENT_GAME_RESTRICTIONS);
        }

        const CURRENT_DRAFT_RESTRICTIONS = {
            aspects: ['sub'],
            reasons: ['You are involved in a currently occurring draft.']
        };
        if (_.includes(self.getDraftPlayers(), userID)) {
            restrictions.push(CURRENT_DRAFT_RESTRICTIONS);
        }

        const CURRENT_SUBSTITUTE_REQUEST_RESTRICTIONS = {
            aspects: ['start', 'captain'],
            reasons: ['You are currently applying to a substitute request.']
        };
        let appliedToSubstitute = _.some(self.getCurrentSubstituteRequests(), function(request) {
            return request.candidates.has(userID);
        });
        if (appliedToSubstitute) {
            restrictions.push(CURRENT_SUBSTITUTE_REQUEST_RESTRICTIONS);
        }

        const MIN_GAME_RESTRICTIONS = {
            aspects: ['captain'],
            reasons: ['You cannot captain because you do not meet the requirement for games played.']
        };
        if (user.stats.roles) {
            let gamesPlayed = _.reduce(user.stats.roles, (sum, stat) => sum + stat.number, 0);

            if (gamesPlayed < CAPTAIN_GAME_REQUIREMENT) {
                restrictions.push(MIN_GAME_RESTRICTIONS);
            }
        }
        else {
            restrictions.push(MIN_GAME_RESTRICTIONS);
        }

        const DRAFT_EXPIRE_COOLDOWN_RESTRICTIONS = {
            aspects: ['captain'],
            reasons: ['You are currently on a captain cooldown for allowing a draft to expire.']
        };
        if (self.isOnDraftExpireCooldown(userID)) {
            restrictions.push(DRAFT_EXPIRE_COOLDOWN_RESTRICTIONS);
        }

        let activeRestrictions = yield database.Restriction.find({
            user: userID,
            active: true
        });

        for (let restriction of activeRestrictions) {
            if (!restriction.expires || moment().isBefore(restriction.expires)) {
                let reason;

                if (_.size(restriction.aspects) !== 0) {
                    let formattedAspects = restriction.aspects.join(', ');
                    let formattedExpiration = restriction.expires ? moment(restriction.expires).fromNow() : 'never';
                    let formattedReason = restriction.reason ? ` for the reason: ${restriction.reason}` : '.';
                    reason = `You are currently restricted (aspects: ${formattedAspects}) (expires: ${formattedExpiration})${formattedReason}`;
                }
                else {
                    let formattedReason = restriction.reason ? ` for the reason: ${restriction.reason}` : '.';
                    reason = `You have received a warning${formattedReason}`;
                }

                restrictions.push({
                    aspects: restriction.aspects,
                    reasons: [reason]
                });
            }
            else {
                restriction.active = false;

                yield restriction.save();
            }
        }

        let combinedRestrictions = _.reduce(restrictions, function(combined, restriction) {
            return {
                aspects: _.union(combined.aspects, restriction.aspects),
                reasons: [...combined.reasons, ...restriction.reasons]
            };
        }, {
            aspects: [],
            reasons: []
        });

        userRestrictions.set(userID, combinedRestrictions);

        self.emit('userRestrictionsUpdated', userID);

        return combinedRestrictions;
    });

    self.on('userRestrictionsUpdated', function(userID) {
        self.emitToUser(userID, 'restrictionsUpdated', [self.getUserRestrictions(userID)]);
    });

    passport.use(new OpenIDStrategy({
        providerURL: 'http://steamcommunity.com/openid',
        returnURL(req) {
            return url.format({
                protocol: req.protocol,
                host: req.get('host'),
                pathname: '/user/login/return'
            });
        },
        realm(req) {
            return url.format({
                protocol: req.protocol,
                host: req.get('host')
            });
        },
        stateless: true
    }, co.wrap(function*(identifier, done) {
        let id = identifier.replace('http://steamcommunity.com/openid/id/', '');

        try {
            let user = yield database.User.findOne({
                steamID: id
            });

            if (!user) {
                user = new database.User({
                    steamID: id
                });
            }

            yield user.save();

            done(null, user);
        }
        catch (err) {
            done(err);
        }
    })));
    passport.serializeUser(function(user, done) {
        done(null, user._id);
    });
    passport.deserializeUser(function(id, done) {
        database.User.findById(id, done);
    });

    app.get('/user/login', passport.authenticate('openid'));
    app.get('/user/login/return', passport.authenticate('openid'), function(req, res) {
        res.redirect('/');
    });
    app.get('/user/logout', function(req, res) {
        req.logout();
        res.redirect('/');
    });
    app.get('/user/token', function(req, res) {
        if (!req.user) {
            res.sendStatus(HttpStatus.FORBIDDEN);
            return;
        }

        let token = jwt.sign({
            user: req.user.id
        }, config.get('server.tokenSecret'), {
            expiresIn: config.get('server.tokenExpiration')
        });

        res.status(HttpStatus.OK).json({
            token
        });
    });

    io.sockets.on('connection', socketioJwt.authorize({
        required: false,
        secret: config.get('server.tokenSecret'),
        additional_auth: co.wrap(function*(token, successCallback, errorCallback) {
            try {
                let user = yield database.User.findById(token.user).exec();

                if (!user) {
                    errorCallback('user does not exist', 'invalid_user');
                }
                else {
                    successCallback();
                }
            }
            catch (err) {
                errorCallback(err);
            }
        })
    }));

    io.sockets.on('connection', function(socket) {
        socket.emit('restrictionsUpdated', UNAUTHENTICATED_RESTRICTIONS);
        socket.emit('userInfoUpdated', null);
    });

    function onUserDisconnect() {
        let userID = this.decoded_token.user;

        if (userSockets.has(userID)) {
            let socketList = userSockets.get(userID);

            socketList.delete(this.id);

            if (socketList.size === 0) {
                self.emit('userDisconnected', userID);

                userSockets.delete(userID);
            }
        }
    }

    io.sockets.on('authenticated', co.wrap(function*(socket) {
        let userID = socket.decoded_token.user;

        function onUserSocketPacket() {
            socketDebug(`user ${userID} sent packet (${this.transport.name})`);
        }

        function onUserSocketClose(reason) {
            socketDebug(`user ${userID} connection closed: ${reason} (${this.transport.name})`);
        }

        function onUserSocketUpgrading(transport) {
            socketDebug(`user ${userID} connection upgrading to (${transport.name})`);
        }

        function onUserSocketUpgrade(transport) {
            socketDebug(`user ${userID} connection upgraded to (${transport.name})`);
        }

        socketDebug(`user ${userID} connected and authenticated (${socket.conn.transport.name})`);
        socket.conn.removeListener('packet', onUserSocketPacket);
        socket.conn.on('packet', onUserSocketPacket)
        socket.conn.removeListener('close', onUserSocketClose);
        socket.conn.on('close', onUserSocketClose);
        socket.conn.removeListener('upgrading', onUserSocketUpgrading);
        socket.conn.on('upgrading', onUserSocketUpgrading);
        socket.conn.removeListener('upgraded', onUserSocketUpgrade);
        socket.conn.on('upgraded', onUserSocketUpgrade);

        yield self.updateCachedUser(userID);

        socket.emit('userInfoUpdated', self.getCachedUser(userID));

        if (!userSockets.has(userID)) {
            userSockets.set(userID, new Set([socket.id]));

            yield self.updateUserRestrictions(userID);

            self.emit('userConnected', userID);
        }
        else {
            userSockets.get(userID).add(socket.id);

            socket.emit('restrictionsUpdated', self.getUserRestrictions(userID));
        }

        socket.removeAllListeners('disconnect');
        socket.on('disconnect', onUserDisconnect);
    }));

    app.get('/user/settings', function(req, res) {
        if (req.user) {
            let errors = [];

            if (!req.user.setUp) {
                errors.push('Your account is not set up yet.');
            }

            res.render('userSettings', {
                errors
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
                        req.user.alias = req.body.alias;
                    }
                    else {
                        errors.push('The alias you selected is not available.');
                    }
                }
                else {
                    errors.push('The alias you selected is not in the proper format.');
                }
            }

            if (req.user.alias) {
                req.user.setUp = true;
            }
            else {
                errors.push('Your account is not set up yet.');
            }

            req.user.options.showDraftStats = !!req.body.showDraftStats;

            try {
                yield req.user.save();
            }
            catch (err) {
                self.postToLog({
                    description: `failed to update user <${BASE_URL}/player/${req.user.steamID}|${req.user.alias}>: ${JSON.stringify(req.body)}`,
                    error: err
                });

                errors.push('There was an error saving your information to the database.');
            }

            res.render('userSettings', {
                errors
            });
        }
        else {
            res.redirect('/user/login');
        }
    }));

    co(function*() {
        let users = yield database.User.find({}, '_id').exec();

        for (let user of users) {
            user.authorized = yield checkUserAuthorization(user);

            yield user.save();

            yield self.updateCachedUser(user.id);
        }
    });
};
