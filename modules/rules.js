'use strict';


const _ = require('lodash');
const co = require('co');
const config = require('config');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const humanize = require('humanize');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    app.get('/rules', co.wrap(function*(req, res) {
	res.render('rules');
}));
};
