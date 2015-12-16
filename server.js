var config = require('config');
var express = require('express');
var hbs = require('hbs');
var http = require('http');
var passport = require('passport');
var path = require('path');
var serveStatic = require('serve-static');
var session = require('express-session');
var socketIO = require('socket.io');

var app = express();
var server = http.Server(app);
var io = socketIO(server);

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

require('./modules')(app, io, server);

app.get('/', function(req, res) {
    res.render('index', { user: req.user });
});

server.listen(config.get('server.listen'));
