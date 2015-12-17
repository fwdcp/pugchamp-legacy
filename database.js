var config = require('config');
var mongoose = require('mongoose');

mongoose.connect(config.get('server.mongodb'));

var playerSchema = {
    alias: String,
    steamID: String,
    stats: {
        overall: {
            games: {
                played: Number,
                wins: Number,
                losses: Number,
                ties: Number
            },
            skill: {
                rating: Number
                deviation: Number
            }
        },
        captain: {
            games: {
                played: Number,
                wins: Number,
                losses: Number,
                ties: Number
            }
        }
    }
}

module.exports = {
    Player: mongoose.model('Player', playerSchema)
};
