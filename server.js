var config = require('config');
var express = require('express');
var http = require('http');
var io = require('socket.io');
var OpenIDStrategy = require('passport-openid').Strategy;
var passport = require('passport');
var session = require('express-session');
var url = require('url');

var app = express();
var server = http.Server(app);
var sockets = io(server);

passport.use(new OpenIDStrategy({
    providerURL: 'http://steamcommunity.com/openid',
    returnURL: function(req) {
        return url.format({
            protocol: req.protocol,
            host: req.get('host'),
            pathname: '/login/return'
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

app.use(session({
    resave: false,
    saveUninitialized: false,
    secret: config.get('server.sessionSecret')
}));
app.use(passport.initialize());
app.use(passport.session());

app.get('/', function(req, res) {
    if (req.user) {
        res.status(200).send(req.user);
    }
    else {
        res.sendStatus(401);
    }
});
app.get('/login', passport.authenticate('openid'));
app.get('/login/return', passport.authenticate('openid', {successRedirect: '/', failureRedirect: '/'}));

server.listen(config.get('server.listen'));
