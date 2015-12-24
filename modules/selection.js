var config = require('config');
var lodash = require('lodash');
var mongoose = require('mongoose');

var database = require('../database');

    var playersAvailable = lodash.mapValues(config.get('app.games.roles'), function() { return []; });
    var captainsAvailable = [];
module.exports = function(app, io, self, server) {

    io.sockets.on('authenticated', function(socket) {
        socket.on('changeAvailability', function(availability, callback) {

        });
    });

    app.get('/', function(req, res) {
        res.render('index', { user: req.user, roles: config.get('app.games.roles') });
    });
};
