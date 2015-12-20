var config = require('config');
var mongoose = require('mongoose');

mongoose.connect(config.get('server.mongodb'));

var userSchema = {
    alias: String,
    steamID: String,
    setUp: {
        type: Boolean,
        default: false
    },
    stats: {
        overall: {
            games: {
                played: {type: Number, default: 0},
                wins: {type: Number, default: 0},
                losses: {type: Number, default: 0},
                ties: {type: Number, default: 0}
            },
            skill: {
                rating: {type: Number, default: 1500},
                deviation: {type: Number, default: 500}
            }
        },
        captain: {
            games: {
                played: {type: Number, default: 0},
                wins: {type: Number, default: 0},
                losses: {type: Number, default: 0},
                ties: {type: Number, default: 0}
            }
        }
    }
}

module.exports = {
    User: mongoose.model('User', userSchema)
};
