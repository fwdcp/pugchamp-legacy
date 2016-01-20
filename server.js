/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const config = require('config');
const EventEmitter = require('events');
const express = require('express');
const hbs = require('hbs');
const http = require('http');
const ms = require('ms');
const passport = require('passport');
const path = require('path');
const serveStatic = require('serve-static');
const session = require('express-session');
const socketIO = require('socket.io');
const MongoStore = require('connect-mongo')(session);

var app = express();
var database = require('./database');
var server = http.Server(app);
var io = socketIO(server);
var self = new EventEmitter();

app.set('view engine', 'hbs');

app.set('trust proxy', 'loopback');

hbs.registerPartials(__dirname + '/views/partials');

app.use(session({
    cookie: {
        maxAge: ms(config.get('server.sessionExpiration'))
    },
    resave: false,
    saveUninitialized: false,
    secret: config.get('server.sessionSecret'),
    store: new MongoStore({
        mongooseConnection: database.mongoose.connection
    })
}));
app.use(passport.initialize());
app.use(passport.session());

app.use('/', serveStatic(path.resolve(__dirname, 'public')));
app.use('/components', serveStatic(path.resolve(__dirname, 'bower_components')));

require('./modules')(app, database, io, self);

server.listen(config.get('server.listen'));
