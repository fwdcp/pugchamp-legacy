/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var config = require('config');
var mongoose = require('mongoose');

mongoose.connect(config.get('server.mongodb'));

var userSchema = new mongoose.Schema({
    alias: String,
    steamID: String,
    setUp: {
        type: Boolean,
        default: false
    }
});

var gameSchema = new mongoose.Schema({
    status: String,
    date: Date,
    captains: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        faction: String
    }],
    maps: [String],
    players: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        role: String,
        team: Number,
        origin: String,
        time: Number
    }],
    results: [{
        score: [Number],
        links: [{
            type: String,
            url: String
        }]
    }],
    choices: [{
        type: String,
        method: String,
        captain: Number,
        faction: String,
        role: String,
        player: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        map: String
    }],
    pool: {
        maps: [String],
        players: [{
            user: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            },
            roles: [String]
        }]
    }
});

module.exports = {
    Game: mongoose.model('Game', gameSchema),
    User: mongoose.model('User', userSchema)
};
