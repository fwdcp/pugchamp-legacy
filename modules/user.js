var bodyParser = require('body-parser');
var config = require('config');
var jwt = require('jsonwebtoken');
var mongoose = require('mongoose');
var OpenIDStrategy = require('passport-openid').Strategy;
var passport = require('passport');
var socketioJwt = require('socketio-jwt');
var url = require('url');

var database = require('../database');

module.exports = function(app, io, server) {
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
        var id = identifier.replace('http://steamcommunity.com/openid/id/', '');

        database.User.findOne({steamID: id}, function(err, user) {
            if (err) {
                done(err);
            }
            else if (!user) {
                user = new database.User({steamID: id});
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

        var token = jwt.sign(req.user.id, config.get('server.tokenSecret'));

        res.status(200).send(token);
    });

    io.sockets.on('connection', socketioJwt.authorize({
        required: false,
        secret: config.get('server.tokenSecret'),
        additionalAuth: function(token, successCallback, errorCallback) {
            database.User.findOne(new mongoose.Types.ObjectId(token), function(err, user) {
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

    app.get('/user/settings', function(req, res) {
        if (req.user) {
            res.render('userSettings');
        }
        else {
            res.redirect('/user/login');
        }
    });
    app.post('/user/settings', bodyParser.urlencoded({extended: false}), function(req, res) {
        if (req.body.alias && !req.user.alias) {
            if (/\w+/.test(req.body.alias)) {
                req.user.alias = req.body.alias;
            }
        }

        if (req.user.alias) {
            req.user.setUp = true;
        }

        req.user.save();
        res.locals.user = req.user.toObject();
        res.redirect('/user/settings');
    });
};
