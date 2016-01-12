/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var express = require('express');

module.exports = function(app, database, io, self, server) {
    var router = express.Router();

    router.use('/', function(req, res, next) {
        if (!req.user || !req.user.admin) {
            res.status(403).render('unauthorized');
        }
        else {
            next();
        }
    });

    router.get('/users', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/games', function(req, res) {
        // TODO: implement admin page
    });

    router.get('/servers', function(req, res) {
        // TODO: implement admin page
    });

    app.use('/admin', router);
};
