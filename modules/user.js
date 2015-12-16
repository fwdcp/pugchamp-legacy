var config = require('config');
var jwt = require('jsonwebtoken');
var OpenIDStrategy = require('passport-openid').Strategy;
var passport = require('passport');
var socketioJwt = require('socketio-jwt');
var url = require('url');

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
        done(null, identifier.replace('http://steamcommunity.com/openid/id/', ''));
    }));
    passport.serializeUser(function(id, done) {
        done(null, id);
    });
    passport.deserializeUser(function(id, done) {
        done(null, id);
    });

    app.get('/user/login', passport.authenticate('openid'));
    app.get('/user/login/return', passport.authenticate('openid', {successRedirect: '/', failureRedirect: '/'}));
    app.get('/user/logout', function(req, res) {
        req.logout();
        res.redirect('/');
    });
    app.get('/user/token', function(req, res) {
        if (!req.user) {
            res.sendStatus(401);
            return;
        }

        var token = jwt.sign(req.user, config.get('server.tokenSecret'));

        res.status(200).send(token);
    });

    io.sockets.on('connection', socketioJwt.authorize({
        required: false,
        secret: config.get('server.tokenSecret')
    }));
};
