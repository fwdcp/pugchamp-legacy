/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

module.exports = function(app, database, io, self, server) {
    app.get('/', function(req, res) {
        res.render('index');
    });
};
