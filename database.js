'use strict';

const _ = require('lodash');
const config = require('config');
const math = require('mathjs');
const mongoose = require('mongoose');

const ADMINS = config.get('app.users.admins');
const AUTHORIZATION_DEFAULT = config.has('app.users.authorizationDefault') ? config.get('app.users.authorizationDefault') : true;
const HIDE_DRAFT_STATS = config.get('app.users.hideDraftStats');
const HIDE_RATINGS = config.get('app.users.hideRatings');
const MAPS = config.get('app.games.maps');
const SERVER_POOL = config.get('app.servers.pool');

mongoose.connect(config.get('server.mongodb'));

var userSchema = new mongoose.Schema({
    alias: {
        type: String,
        match: /^[A-Za-z0-9_]{1,15}$/
    },
    steamID: String,
    authorized: {
        type: Boolean,
        default: AUTHORIZATION_DEFAULT
    },
    setUp: {
        type: Boolean,
        default: false
    },
    options: {
        showDraftStats: {
            type: Boolean,
            default: false
        }
    },
    stats: {
        captainScore: {
            low: Number,
            center: Number,
            high: Number
        },
        draft: [{
            type: {
                type: String,
                enum: ['captain', 'picked', 'undrafted']
            },
            position: Number,
            count: Number
        }],
        playerScore: {
            low: Number,
            center: Number,
            high: Number
        },
        rating: {
            mean: {
                type: Number,
                default: 1500
            },
            deviation: {
                type: Number,
                default: 500
            }
        },
        roles: [{
            role: String,
            count: Number
        }]
    }
});
userSchema.index({alias: 'text'}, {default_language: 'none'});
userSchema.virtual('admin').get(function() {
    return _.includes(ADMINS, this.steamID);
});
userSchema.virtual('stats.rating.low').get(function() {
    return this.stats.rating.mean - (3 * this.stats.rating.deviation);
});
userSchema.virtual('stats.rating.high').get(function() {
    return this.stats.rating.mean + (3 * this.stats.rating.deviation);
});
userSchema.set('toObject', {
    getters: true,
    versionKey: false,
    transform(doc, ret) {
        if (ret.stats) {
            if (!HIDE_RATINGS) {
                if (ret.stats.captainScore) {
                    ret.stats.captainScore.low = _.isNumber(doc.stats.captainScore.low) ? math.round(doc.stats.captainScore.low, 3) : null;
                    ret.stats.captainScore.center = _.isNumber(doc.stats.captainScore.center) ? math.round(doc.stats.captainScore.center, 3) : null;
                    ret.stats.captainScore.high = _.isNumber(doc.stats.captainScore.high) ? math.round(doc.stats.captainScore.high, 3) : null;
                }

                if (ret.stats.playerScore) {
                    ret.stats.playerScore.low = _.isNumber(doc.stats.playerScore.low) ? math.round(doc.stats.playerScore.low, 3) : null;
                    ret.stats.playerScore.center = _.isNumber(doc.stats.playerScore.center) ? math.round(doc.stats.playerScore.center, 3) : null;
                    ret.stats.playerScore.high = _.isNumber(doc.stats.playerScore.high) ? math.round(doc.stats.playerScore.high, 3) : null;
                }

                if (ret.stats.rating && _.isNumber(doc.stats.rating.mean) && _.isNumber(doc.stats.rating.deviation)) {
                    ret.stats.rating.mean = math.round(doc.stats.rating.mean, 0);
                    ret.stats.rating.deviation = math.round(doc.stats.rating.deviation, 0);
                    ret.stats.rating.low = math.round(doc.stats.rating.low, 0);
                    ret.stats.rating.high = math.round(doc.stats.rating.high, 0);
                }
            }
            else {
                delete ret.stats.captainScore;
                delete ret.stats.playerScore;
                delete ret.stats.rating;
            }

            if (HIDE_DRAFT_STATS || (doc.options && !doc.options.showDraftStats)) {
                delete ret.stats.draft;
            }
        }

        delete ret.options;
    }
});

var gameSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: ['initializing', 'launching', 'live', 'aborted', 'completed']
    },
    date: Date,
    map: String,
    server: String,
    duration: Number,
    score: [Number],
    teams: [{
        captain: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        faction: String,
        composition: [{
            role: String,
            players: [{
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: 'User'
                },
                replaced: {
                    type: Boolean,
                    default: false
                },
                time: {
                    type: Number,
                    default: 0
                }
            }]
        }]
    }],
    links: [{
        type: {
            type: String
        },
        url: String
    }],
    draft: {
        choices: [{
            type: {
                type: String
            },
            method: String,
            team: Number,
            faction: String,
            captain: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            },
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
            }],
            captains: [{
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            }]
        }
    }
});
gameSchema.set('toObject', {
    getters: true,
    versionKey: false,
    transform(doc, ret) {
        if (doc.map) {
            ret.map = MAPS[doc.map];
        }

        if (doc.server) {
            ret.server = _.omit(SERVER_POOL[doc.server], 'rcon', 'salt');
            ret.server.id = doc.server;
        }
    }
});

var ratingSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    date: Date,
    game: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Game'
    },
    before: {
        mean: Number,
        deviation: Number
    },
    after: {
        mean: Number,
        deviation: Number
    }
});
ratingSchema.virtual('before.low').get(function() {
    return this.before.mean - (3 * this.before.deviation);
});
ratingSchema.virtual('before.high').get(function() {
    return this.before.mean + (3 * this.before.deviation);
});
ratingSchema.virtual('after.low').get(function() {
    return this.after.mean - (3 * this.after.deviation);
});
ratingSchema.virtual('after.high').get(function() {
    return this.after.mean + (3 * this.after.deviation);
});
ratingSchema.set('toObject', {
    getters: true,
    versionKey: false,
    transform(doc, ret) {
        ret.before.mean = math.round(doc.before.mean);
        ret.before.deviation = math.round(doc.before.deviation);
        ret.before.low = math.round(doc.before.low);
        ret.before.high = math.round(doc.before.high);
        ret.after.mean = math.round(doc.after.mean);
        ret.after.deviation = math.round(doc.after.deviation);
        ret.after.low = math.round(doc.after.low);
        ret.after.high = math.round(doc.after.high);
    }
});

var restrictionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    active: Boolean,
    aspects: [{
        type: String,
        enum: ['sub', 'start', 'captain', 'chat', 'support']
    }],
    reason: String,
    expires: Date
});
restrictionSchema.set('toObject', {
    getters: true,
    versionKey: false
});

module.exports = {
    User: mongoose.model('User', userSchema),
    Game: mongoose.model('Game', gameSchema),
    Rating: mongoose.model('Rating', ratingSchema),
    Restriction: mongoose.model('Restriction', restrictionSchema),
    mongoose
};
