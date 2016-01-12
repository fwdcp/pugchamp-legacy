var config = require('config');
var EventEmitter = require('events');
var express = require('express');
var hbs = require('hbs');
var http = require('http');
var ms = require('ms');
var passport = require('passport');
var path = require('path');
var serveStatic = require('serve-static');
var session = require('express-session');
var socketIO = require('socket.io');
var MongoStore = require('connect-mongo')(session);

var app = express();
var database = require('./database');
var server = http.Server(app);
var io = socketIO(server);
var self = new EventEmitter();

app.set('view engine', 'hbs');

hbs.registerPartials(__dirname + '/views/partials');
hbs.registerHelper('toJSON', function(object) {
    return new hbs.handlebars.SafeString(JSON.stringify(object));
});

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

require('./modules')(app, database, io, self, server);

server.listen(config.get('server.listen'));
