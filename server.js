var config = require('config');
var express = require('express');
var hbs = require('hbs');
var http = require('http');
var jwt = require('jsonwebtoken');
var OpenIDStrategy = require('passport-openid').Strategy;
var passport = require('passport');
var path = require('path');
var serveStatic = require('serve-static');
var session = require('express-session');
var socketIO = require('socket.io');
var socketioJwt = require('socketio-jwt');
var url = require('url');

var app = express();
var server = http.Server(app);
var io = socketIO(server);

passport.use(new OpenIDStrategy({
    providerURL: 'http://steamcommunity.com/openid',
    returnURL: function(req) {
        return url.format({
            protocol: req.protocol,
            host: req.get('host'),
            pathname: '/auth/login/return'
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

app.set('view engine', 'hbs');

hbs.registerPartials(__dirname + '/views/partials');

app.use(session({
    resave: false,
    saveUninitialized: false,
    secret: config.get('server.sessionSecret')
}));
app.use(passport.initialize());
app.use(passport.session());

app.use('/', serveStatic(path.resolve(__dirname, 'public')));
app.use('/components', serveStatic(path.resolve(__dirname, 'bower_components')));

app.get('/auth/login', passport.authenticate('openid'));
app.get('/auth/login/return', passport.authenticate('openid', {successRedirect: '/', failureRedirect: '/'}));
app.get('/auth/logout', function(req, res) {
    req.logout();
    res.redirect('/');
});
app.get('/auth/token', function(req, res) {
    if (!req.user) {
        res.sendStatus(401);
        return;
    }

    var token = jwt.sign(req.user, config.get('server.tokenSecret'));

    res.status(200).send(token);
});

app.get('/', function(req, res) {
    res.render('index', { user: req.user });
});

io.sockets.on('connection', socketioJwt.authorize({
    required: false,
    secret: config.get('server.tokenSecret')
}));

server.listen(config.get('server.listen'));
