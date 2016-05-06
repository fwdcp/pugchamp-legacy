'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const co = require('co');
const config = require('config');
const jwt = require('jsonwebtoken');
const HttpStatus = require('http-status-codes');
const OpenIDStrategy = require('passport-openid').Strategy;
const passport = require('passport');
const rp = require('request-promise');
const socketioJwt = require('socketio-jwt');
const url = require('url');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const HIDE_DRAFT_STATS = config.get('app.users.hideDraftStats');
    const INITIAL_RATINGS = config.has('app.users.initialRatings') ? config.get('app.users.initialRatings') : [];
    const UNAUTHENTICATED_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain', 'chat', 'support'],
        reasons: ['You are currently not [logged on](/user/login).']
    };

    var userSockets = new Map();

    /**
     * @async
     */
    self.updateUserCache = co.wrap(function* updateUserCache(users) {
        yield helpers.runAppScript('updateUserCache', _.map(users, user => helpers.getDocumentID(user)));
    });

    /**
     * @async
     */
    self.getCachedUser = co.wrap(function* getCachedUser(user) {
        let userID = helpers.getDocumentID(user);

        if (!(yield cache.existsAsync(`user-${userID}`))) {
            yield self.updateUserCache([user]);
        }

        return JSON.parse(yield cache.getAsync(`user-${userID}`));
    });

    /**
     * @async
     */
    self.getCachedUsers = co.wrap(function* getCachedUsers(users) {
        let cachedUsers = yield cache.mgetAsync(_.map(users, user => `user-${helpers.getDocumentID(user)}`));

        let missingUsers = _.filter(users, (user, index) => !cachedUsers[index]);
        if (_.size(missingUsers) > 0) {
            yield self.updateUserCache(missingUsers);

            cachedUsers = yield cache.mgetAsync(_.map(users, user => `user-${helpers.getDocumentID(user)}`));
        }

        return cachedUsers;
    });

    /**
     * @async
     */
    self.getUserByAlias = co.wrap(function* getUserByAlias(alias) {
        let user = yield database.User.findOne({
            $text: {
                $search: `"${alias}"`,
                $language: 'none',
                $caseSensitive: false,
                $diacriticSensitive: false
            }
        }, {
            aliasMatch: {
                $meta: 'textScore'
            }
        }).sort({
            aliasMatch: {
                $meta: 'textScore'
            }
        }).exec();

        return user;
    });

    self.getOnlineUsers = function getOnlineUsers() {
        return _.toArray(userSockets.keys());
    };

    self.emitToUser = function emitToUser(user, name, args) {
        let userID = helpers.getDocumentID(user);

        if (userSockets.has(userID)) {
            _(userSockets.get(userID)).toArray().forEach(function(socketID) {
                let socket = io.sockets.connected[socketID];

                if (socket) {
                    socket.emit(name, ...args);
                }
            });
        }
    };

    /**
     * @async
     */
    self.updateUserRestrictions = co.wrap(function* updateUserRestrictions(users) {
        yield helpers.runAppScript('updateUserRestrictions', _.map(users, user => helpers.getDocumentID(user)));

        for (let user of users) {
            let userRestrictions = yield self.getUserRestrictions(user);

            self.emit('userRestrictionsUpdated', helpers.getDocumentID(user), userRestrictions);
        }
    });

    /**
     * @async
     */
    self.getUserRestrictions = co.wrap(function* getUserRestrictions(user) {
        let userID = helpers.getDocumentID(user);

        if (userID) {
            if (!(yield cache.existsAsync(`userRestrictions-${userID}`))) {
                yield self.updateUserRestrictions([user]);
            }

            return JSON.parse(yield cache.getAsync(`userRestrictions-${userID}`));
        }
        else {
            return UNAUTHENTICATED_RESTRICTIONS;
        }
    });

    /**
     * @async
     */
    self.getUsersRestrictions = co.wrap(function* getUsersRestrictions(users) {
        let usersRestrictions = yield cache.mgetAsync(_.map(users, user => `userRestrictions-${helpers.getDocumentID(user)}`));

        let missingUsers = _.filter(users, (user, index) => !usersRestrictions[index]);
        if (_.size(missingUsers) > 0) {
            yield self.updateUserRestrictions(missingUsers);

            usersRestrictions = yield cache.mgetAsync(_.map(users, user => `userRestrictions-${helpers.getDocumentID(user)}`));
        }

        return _.zipObject(_.map(users, user => helpers.getDocumentID(user)), _.map(usersRestrictions, restrictions => restrictions || UNAUTHENTICATED_RESTRICTIONS));
    });

    self.on('userRestrictionsUpdated', function(userID, userRestrictions) {
        self.emitToUser(userID, 'restrictionsUpdated', [userRestrictions]);
    });

    /**
     * @async
     */
    function updateUserGroups(users) {
        return co(function*() {
            yield helpers.runAppScript('updateUserGroups', _.map(users, user => helpers.getDocumentID(user)));
        });
    }

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
                'steamID': id
            });

            if (!user) {
                user = new database.User({
                    steamID: id
                });

                for (let initialRating of INITIAL_RATINGS) {
                    if (initialRating.api) {
                        try {
                            let response = yield rp({
                                resolveWithFullResponse: true,
                                simple: false,
                                qs: {
                                    user: user.steamID
                                },
                                uri: initialRating.api
                            });

                            if (response.statusCode === HttpStatus.OK) {
                                user.stats.rating.mean = initialRating.mean;
                                user.stats.rating.deviation = initialRating.deviation;

                                break;
                            }
                            else {
                                continue;
                            }
                        }
                        catch (err) {
                            continue;
                        }
                    }
                    else {
                        user.stats.rating.mean = initialRating.mean;
                        user.stats.rating.deviation = initialRating.deviation;

                        break;
                    }
                }

                yield user.save();

                yield self.updatePlayerStats([user]);
            }

            done(null, user);
        }
        catch (err) {
            done(err);
        }
    })));
    passport.serializeUser(function(user, done) {
        done(null, helpers.getDocumentID(user));
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

        let user = yield self.getCachedUser(userID);
        socket.emit('userInfoUpdated', user);

        if (!userSockets.has(userID)) {
            userSockets.set(userID, new Set([socket.id]));

            yield self.updateUserRestrictions([userID]);
            yield updateUserGroups([userID]);

            self.emit('userConnected', userID);
        }
        else {
            userSockets.get(userID).add(socket.id);

            socket.emit('restrictionsUpdated', yield self.getUserRestrictions(userID));
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

            let majorChange = false;

            if (req.body.alias && !req.user.alias) {
                if (/^[A-Za-z0-9_]{1,15}$/.test(req.body.alias)) {
                    let existingUser = yield self.getUserByAlias(req.body.alias);

                    if (!existingUser || helpers.getDocumentID(existingUser) === helpers.getDocumentID(req.user)) {
                        req.user.alias = req.body.alias;

                        majorChange = true;
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

            if (!HIDE_DRAFT_STATS) {
                req.user.options.showDraftStats = !!req.body.showDraftStats;
            }

            try {
                yield req.user.save();

                yield self.updateUserCache([req.user]);

                if (majorChange) {
                    yield self.updateUserRestrictions([req.user]);
                    yield self.updateUserGames(req.user);
                }
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
};
